"""Target runtime helpers: dependency rebuild and isolated Pi smoke test."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .errors import die, warn


def detect_manager(target: Path) -> tuple[list[str], Path] | None:
    for root in (target, target / "agent"):
        if not (root / "package.json").is_file():
            continue
        candidates = [
            ("package-lock.json", ["npm", "install", "--ignore-scripts"]),
            ("pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]),
            ("yarn.lock", ["yarn", "install", "--immutable"]),
            ("bun.lockb", ["bun", "install", "--frozen-lockfile"]),
            ("bun.lock", ["bun", "install", "--frozen-lockfile"]),
        ]
        for lockfile, command in candidates:
            if (root / lockfile).exists() and shutil.which(command[0]):
                return command, root
    return None


def rebuild_dependencies(target: Path) -> None:
    detected = detect_manager(target)
    if not detected:
        warn(
            "no compatible target package manifest, lockfile, and package "
            "manager; skipped dependency rebuild"
        )
        return
    command, cwd = detected
    print(f"Rebuilding target dependencies with {' '.join(command)} in {cwd}")
    try:
        result = subprocess.run(command, cwd=cwd, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        warn(f"dependency rebuild unavailable: {error}; continuing")
        return
    if result.returncode:
        warn(
            f"dependency rebuild failed with exit code {result.returncode}; continuing"
        )


def pi_supported_options(
    pi: str, environment: dict[str, str] | None = None
) -> set[str]:
    """Return the long/short CLI flags the installed pi understands.

    Smoke passes a batch of `--no-*` flags that younger pi versions added
    (e.g. `--no-lens`). Older pi builds reject unknown flags and abort, so
    query `pi --help` once and only keep flags this runtime advertises.
    The help output depends on PI_CODING_AGENT_DIR (e.g. pi-lens advertises
    `--no-lens` only when installed), so query it in the same isolated
    environment smoke runs in, not the host's.
    """
    try:
        result = subprocess.run(
            [pi, "--help"],
            env=environment,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return set()
    if result.returncode:
        return set()
    options: set[str] = set()
    for line in result.stdout.splitlines():
        match = re.match(r"\s+(--[A-Za-z][\w-]*)(?:\s*,\s*(-[A-Za-z]+))?", line)
        if match:
            options.add(match.group(1))
            if match.group(2):
                options.add(match.group(2))
    return options


def smoke(target: Path) -> None:
    pi = os.environ.get("DOTPI_PI", "pi")
    if not shutil.which(pi) and not Path(pi).is_file():
        die(f"Pi runtime not found ({pi}); install rolled back")
    with tempfile.TemporaryDirectory(prefix="dotpi-smoke-") as directory:
        isolated = Path(directory) / ".pi"
        if target.exists():
            shutil.copytree(target, isolated, symlinks=True)
        environment = os.environ.copy()
        environment["PI_CODING_AGENT_DIR"] = str(isolated / "agent")
        # Env var, not a CLI flag: works on pi builds that predate --offline.
        environment["PI_OFFLINE"] = "1"
        # Only pass optional --no-* flags the isolated pi actually advertises;
        # older builds (and targets without pi-lens) reject unknown flags like
        # --no-lens and abort the smoke run. Query help in the isolated env so
        # the flag set matches the runtime we are about to launch.
        supported = pi_supported_options(pi, environment)
        # Strong smoke = real model round-trip (verifies provider config, auth,
        # and the model call). It needs WANDB_API_BASE_URL + WANDB_API_KEY in
        # the environment: the repo's models.json/auth.json use $-placeholders
        # that pi resolves from env. A default install skips auth.json and runs
        # PI_OFFLINE=1, so a fresh install usually has no creds; fall back to an
        # empty prompt that still loads settings, models, and extensions
        # (catching broken JSON or extension code) but exits before any model
        # call.
        # ponytail: wandb-specific; generalize to the default provider's env
        # vars and extension if more providers land.
        round_trip = bool(
            environment.get("WANDB_API_BASE_URL")
            and environment.get("WANDB_API_KEY")
            and (target / "agent" / "extensions" / "wandb").is_dir()
        )
        prompt = "Reply with exactly DOTPI_SMOKE_OK" if round_trip else ""
        desired = [
            "--no-session",
            "--no-tools",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-lens",
            "-p",
            prompt,
        ]
        command = [
            pi,
            *[
                flag
                for flag in desired
                if not supported or flag in supported or not flag.startswith("-")
            ],
        ]
        try:
            result = subprocess.run(
                command,
                env=environment,
                text=True,
                capture_output=True,
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            die(f"isolated Pi smoke failed: {error}; install rolled back")
        if result.returncode:
            detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
            die(
                f"isolated Pi smoke failed: "
                f"{' '.join(detail) or 'unexpected response'}; install rolled back"
            )
        if round_trip and "DOTPI_SMOKE_OK" not in result.stdout:
            detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
            die(
                f"isolated Pi smoke failed: "
                f"{' '.join(detail) or 'unexpected response'}; install rolled back"
            )
    print("Pi smoke: OK")
