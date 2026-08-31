#!/usr/bin/env python3
"""Safe installer and backup tool for this repository's Pi configuration."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import difflib
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any, NoReturn

APP = "dotpi"
AUTH = Path("agent/auth.json")
DEFAULT_TARGET = Path.home() / ".pi"


class DotpiError(Exception):
    def __init__(self, code: int):
        super().__init__()
        self.code = code


def die(message: str, code: int = 2) -> NoReturn:
    print(f"{APP}: error: {message}", file=sys.stderr)
    raise DotpiError(code)


def warn(message: str) -> None:
    print(f"{APP}: warning: {message}", file=sys.stderr)


def repo_root() -> Path:
    return Path(__file__).resolve().parent


def target_path(value: str | None) -> Path:
    return Path(value).expanduser().resolve() if value else DEFAULT_TARGET.resolve()


def backup_root(target: Path) -> Path:
    return target.parent / (
        ".pi-backups" if target.name == ".pi" else f"{target.name}-backups"
    )


def relative_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        die(f"path must be repository-relative: {value}")
    return path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


def parse_int(value: Any, label: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        die(f"invalid integer for {label}")


def set_mode(path: Path, value: Any) -> None:
    try:
        os.chmod(path, parse_int(value, "file mode"))
    except OSError as error:
        die(f"cannot set mode on {path}: {error}")


def set_private(path: Path) -> None:
    try:
        path.chmod(0o600 if path.is_file() else 0o700)
    except OSError as error:
        die(f"cannot protect {path}: {error}")


def ensure_target_safe(target: Path) -> None:
    if target in {Path("/"), Path.home().resolve()}:
        die(f"refusing unsafe target: {target}")


def parse_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        die(f"invalid JSON {path}: {error}")


def direct_json_sources(root: Path) -> list[Path]:
    return sorted(
        path for path in (root / "agent").glob("*.json") if path.name != "auth.json"
    )


def extension_sources(root: Path) -> dict[str, Path]:
    extensions = root / "agent" / "extensions"
    if not extensions.is_dir():
        return {}
    return {path.name: path for path in sorted(extensions.iterdir()) if path.is_dir()}


def validate_source(root: Path, include_extensions: bool = True) -> None:
    if not (root / "agent").is_dir():
        die("repository has no agent directory")
    for path in direct_json_sources(root):
        parse_json(path)
    auth = root / AUTH
    if auth.exists():
        parse_json(auth)
    if not include_extensions:
        return
    for name, extension in extension_sources(root).items():
        manifest_path = extension / "package.json"
        if not manifest_path.is_file():
            die(f"extension {name} has no package.json")
        manifest = parse_json(manifest_path)
        if not isinstance(manifest, dict) or not isinstance(manifest.get("pi"), dict):
            die(f"extension {name} package.json has no pi manifest")
        entries = manifest["pi"].get("extensions")
        if not isinstance(entries, list) or not entries:
            die(f"extension {name} has no pi extension entrypoint")
        for entry in entries:
            entry_path = extension / str(entry)
            if not entry_path.is_file():
                die(f"extension {name} entrypoint is missing: {entry}")


def is_interactive(args: argparse.Namespace) -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty())


def require_confirmation(args: argparse.Namespace, action: str) -> None:
    if args.yes:
        return
    if not is_interactive(args):
        die(f"non-interactive {action} requires --yes; no changes made")
    try:
        answer = input(f"{action}. Continue? [y/N] ").strip().lower()
    except EOFError:
        die(f"non-interactive {action} requires --yes; no changes made")
    if answer not in {"y", "yes"}:
        die("cancelled; no changes made", 1)


def copy_entry(source: Path, destination: Path, overwrite: bool = False) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        if destination.exists() or destination.is_symlink():
            if not overwrite:
                die(f"path exists: {destination}")
            remove_entry(destination)
        destination.symlink_to(os.readlink(source))
        return
    if source.is_dir():
        if destination.exists() and not overwrite:
            die(f"path exists: {destination}")
        if destination.exists():
            remove_entry(destination)
        shutil.copytree(source, destination, symlinks=True, copy_function=shutil.copy2)
        return
    if destination.exists() and not overwrite:
        die(f"path exists: {destination}")
    with source.open("rb") as input_file, destination.open("wb") as output_file:
        shutil.copyfileobj(input_file, output_file)
    shutil.copymode(source, destination, follow_symlinks=False)


def remove_entry(path: Path) -> None:
    try:
        if path.is_symlink() or path.is_file():
            path.unlink()
        elif path.is_dir():
            shutil.rmtree(path)
    except OSError as error:
        die(f"cannot remove {path}: {error}")


def snapshot_file(path: Path) -> tuple[bytes, int] | None:
    if not path.exists() or path.is_symlink() or not path.is_file():
        return None
    return path.read_bytes(), mode(path)


def restore_snapshot(path: Path, snapshot: tuple[bytes, int] | None) -> None:
    if snapshot is None:
        if path.exists() or path.is_symlink():
            remove_entry(path)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
            temporary.write(snapshot[0])
            temporary.flush()
            temporary_name = temporary.name
        os.chmod(temporary_name, snapshot[1])
        os.replace(temporary_name, path)
    except OSError as error:
        die(f"cannot restore {path}: {error}")
    finally:
        if temporary_name:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary_name)


def atomic_write(path: Path, content: bytes, file_mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_name = temporary.name
    try:
        os.chmod(temporary_name, file_mode)
        os.replace(temporary_name, path)
    except OSError as error:
        die(f"cannot atomically write {path}: {error}")
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary_name)


def json_preview(source: Path, destination: Path) -> str | None:
    try:
        source_text = source.read_text(encoding="utf-8").splitlines(keepends=True)
        if destination.exists():
            destination_text = destination.read_text(encoding="utf-8").splitlines(
                keepends=True
            )
        else:
            destination_text = []
    except OSError as error:
        die(f"cannot read JSON for preview: {error}")
        if source_text == destination_text:
            return None
    return "".join(
        difflib.unified_diff(
            destination_text,
            source_text,
            fromfile=str(destination),
            tofile=str(source),
        )
    )


def select_extensions(args: argparse.Namespace, sources: dict[str, Path]) -> list[str]:
    if args.no_extensions:
        return []
    filters = [
        item for value in (args.extension or []) for item in value.split(",") if item
    ]
    if filters:
        selected: list[str] = []
        for item in filters:
            name = Path(item).name
            if name not in sources:
                die(
                    f"unknown extension filter: {item}; choices: {', '.join(sources) or 'none'}"
                )
            if name not in selected:
                selected.append(name)
        return selected
    if not is_interactive(args):
        die("non-interactive install requires --extension filters")
    if not sources:
        return []
    print("Available extensions:")
    for index, name in enumerate(sources, 1):
        print(f"  {index}. {name}")
    answer = input(
        "Select extensions (comma-separated numbers/names, blank=all): "
    ).strip()
    if not answer:
        return list(sources)
    selected = []
    for item in answer.split(","):
        item = item.strip()
        if item.isdigit():
            index = parse_int(item, "extension selection") - 1
            if not 0 <= index < len(sources):
                die(f"unknown extension selection: {item}")
            name = list(sources)[index]
        else:
            name = Path(item).name
        if name not in sources:
            die(f"unknown extension selection: {item}")
        if name not in selected:
            selected.append(name)
    return selected


def extension_conflicts(
    target: Path, selected: list[str], sources: dict[str, Path]
) -> list[str]:
    return [
        name for name in selected if (target / "agent" / "extensions" / name).exists()
    ]


def default_backup_paths(target: Path) -> list[Path]:
    agent = target / "agent"
    return (
        [
            path.relative_to(target)
            for path in sorted(agent.glob("*.json"))
            if path.name != "auth.json"
        ]
        if agent.is_dir()
        else []
    )


def iter_entries(root: Path, relative: Path) -> list[tuple[Path, Path]]:
    source = root / relative
    if not source.exists() and not source.is_symlink():
        return []
    entries: list[tuple[Path, Path]] = []
    if source.is_dir() and not source.is_symlink():
        entries.append((relative, source))
        for path in sorted(source.rglob("*")):
            entries.append((path.relative_to(root), path))
    else:
        entries.append((relative, source))
    return entries


def create_backup(
    target: Path, paths: list[Path], label: str, announce: bool = True
) -> Path:
    root = backup_root(target)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup_id = (
        dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + uuid.uuid4().hex[:8]
    )
    backup = root / backup_id
    payload = backup / "payload"
    payload.mkdir(mode=0o700, parents=True)
    entries: list[dict[str, object]] = []
    for relative in paths:
        for entry_relative, source in iter_entries(target, relative):
            destination = payload / entry_relative
            entry: dict[str, object] = {
                "path": entry_relative.as_posix(),
                "mode": mode(source),
                "type": "symlink"
                if source.is_symlink()
                else "directory"
                if source.is_dir()
                else "file",
            }
            if source.is_symlink():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.symlink_to(os.readlink(source))
                entry["target"] = os.readlink(source)
            elif source.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                set_mode(destination, entry["mode"])
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                set_mode(destination, entry["mode"])
                if relative == AUTH:
                    set_mode(destination, 0o600)
                entry["sha256"] = sha256(source)
            entries.append(entry)
    manifest = {
        "format": 1,
        "id": backup_id,
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "target": str(target),
        "label": label,
        "entries": entries,
    }
    (backup / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    os.chmod(backup / "manifest.json", 0o600)
    set_private(backup)
    if announce:
        print(f"Backup created: {backup_id} ({len(entries)} entries)")
    return backup


def load_backup(target: Path, backup_id: str) -> tuple[Path, dict[str, Any]]:
    backup = backup_root(target) / backup_id
    manifest_path = backup / "manifest.json"
    if not manifest_path.is_file():
        die(f"backup not found: {backup_id}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        die(f"invalid backup manifest {manifest_path}: {error}")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("entries"), list):
        die(f"invalid backup manifest {manifest_path}")
    for entry in manifest["entries"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            die(f"invalid backup entry in {manifest_path}")
        relative_path(str(entry["path"]))
    return backup, manifest


def matching_entries(
    manifest: dict[str, Any], paths: list[Path]
) -> list[dict[str, Any]]:
    entries = [
        entry for entry in manifest.get("entries", []) if isinstance(entry, dict)
    ]
    if not paths:
        return entries
    wanted = [path.as_posix().rstrip("/") for path in paths]
    return [
        entry
        for entry in entries
        if any(
            entry.get("path", "") == item
            or str(entry.get("path", "")).startswith(item + "/")
            for item in wanted
        )
    ]


def backup_command(args: argparse.Namespace) -> None:
    target = target_path(args.target)
    paths = [relative_path(item) for item in args.paths] or default_backup_paths(target)
    if not paths:
        die(f"no backup paths found under {target}")
    print("Paths to back up:")
    for path in paths:
        print(f"  {path}")
    require_confirmation(args, "Create backup")
    create_backup(target, paths, "manual")


def restore_command(args: argparse.Namespace) -> None:
    target = target_path(args.target)
    backup, manifest = load_backup(target, args.backup_id)
    paths = [relative_path(item) for item in args.paths]
    entries = matching_entries(manifest, paths)
    if not entries:
        die("no matching paths in backup")
    print(f"Paths to restore from {args.backup_id}:")
    for entry in entries:
        print(f"  {entry['path']}")
    require_confirmation(args, "Restore backup")
    affected = sorted({Path(str(entry["path"])) for entry in entries})
    if any(
        path.exists() or path.is_symlink()
        for path in (target / item for item in affected)
    ):
        create_backup(target, affected, "before-restore")
    for entry in sorted(
        entries, key=lambda item: (str(item["path"]).count("/"), str(item["path"]))
    ):
        relative = Path(str(entry["path"]))
        source = backup / "payload" / relative
        destination = target / relative
        kind = entry.get("type")
        if kind == "directory":
            destination.mkdir(parents=True, exist_ok=True)
            set_mode(destination, entry.get("mode"))
        elif kind == "symlink":
            if destination.exists() or destination.is_symlink():
                remove_entry(destination)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.symlink_to(str(entry["target"]))
        else:
            if not source.is_file() or sha256(source) != entry.get("sha256"):
                die(f"backup checksum mismatch: {relative}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            set_mode(destination, entry.get("mode"))
        if relative == AUTH:
            set_private(destination)
    print(f"Restored {len(entries)} entries from {args.backup_id}")


def list_command(args: argparse.Namespace) -> None:
    root = backup_root(target_path(args.target))
    if not root.is_dir():
        print("No backups.")
        return
    for directory in sorted(
        (path for path in root.iterdir() if path.is_dir()), reverse=True
    ):
        manifest_path = directory / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            count = len(manifest.get("entries", []))
            print(
                f"{directory.name}\t{manifest.get('created_at', '?')}\t{count} entries\t{manifest.get('label', '')}"
            )
        except (OSError, json.JSONDecodeError):
            print(f"{directory.name}\tINVALID MANIFEST")


def delete_command(args: argparse.Namespace) -> None:
    target = target_path(args.target)
    backup, _ = load_backup(target, args.backup_id)
    print(f"Backup to delete: {backup}")
    require_confirmation(args, "Delete backup")
    try:
        shutil.rmtree(backup)
    except OSError as error:
        die(f"cannot delete backup: {error}")
    print(f"Deleted {args.backup_id}")


def parse_duration(value: str) -> dt.timedelta:
    match = re.fullmatch(r"(\d+)\s*([smhdw])", value.lower())
    if not match:
        die("duration must look like 30d, 12h, 45m, or 2w")
    amount_text, unit_code = match.groups()
    amount = parse_int(amount_text, "duration")
    unit = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}[
        unit_code
    ]
    return dt.timedelta(**{unit: amount})


def prune_command(args: argparse.Namespace) -> None:
    if args.keep is None and args.older_than is None:
        die("prune requires --keep N or --older-than duration")
    if args.keep is not None and args.older_than is not None:
        die("prune accepts --keep or --older-than, not both")
    target = target_path(args.target)
    root = backup_root(target)
    directories = []
    if root.is_dir():
        for path in root.iterdir():
            if not path.is_dir() or not (path / "manifest.json").is_file():
                continue
            try:
                manifest = json.loads(
                    (path / "manifest.json").read_text(encoding="utf-8")
                )
                created = dt.datetime.fromisoformat(str(manifest["created_at"]))
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
            directories.append((created, path))
    directories.sort(reverse=True)
    if args.keep is not None:
        doomed = [path for _, path in directories[args.keep :]]
    else:
        if args.older_than is None:
            die("prune requires --older-than duration")
        cutoff = dt.datetime.now(dt.timezone.utc) - parse_duration(str(args.older_than))
        doomed = [path for created, path in directories if created < cutoff]
    if not doomed:
        print("Nothing to prune.")
        return
    print("Backups to delete:")
    for path in doomed:
        print(f"  {path.name}")
    require_confirmation(args, "Prune backups")
    try:
        for path in doomed:
            shutil.rmtree(path)
    except OSError as error:
        die(f"cannot prune backup: {error}")
    print(f"Pruned {len(doomed)} backups")


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
            "no compatible target package manifest, lockfile, and package manager; skipped dependency rebuild"
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
        command = [
            pi,
            "--no-session",
            "--offline",
            "--no-tools",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-lens",
            "-p",
            "Reply with exactly DOTPI_SMOKE_OK",
        ]
        try:
            result = subprocess.run(
                command, env=environment, text=True, capture_output=True, timeout=120
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            die(f"isolated Pi smoke failed: {error}; install rolled back")
        if result.returncode or "DOTPI_SMOKE_OK" not in result.stdout:
            detail = (result.stderr or result.stdout).strip().splitlines()[-1:]
            die(
                f"isolated Pi smoke failed: {' '.join(detail) or 'unexpected response'}; install rolled back"
            )
    print("Pi smoke: OK")


def rollback_partial_install(
    target: Path,
    snapshots: dict[Path, tuple[bytes, int] | None],
    created_extensions: list[Path],
    overwritten_extensions: list[str],
) -> None:
    for relative, snapshot in snapshots.items():
        restore_snapshot(target / relative, snapshot)
    for extension in created_extensions:
        if extension.exists() or extension.is_symlink():
            remove_entry(extension)
    if overwritten_extensions:
        warn(
            "forced extension overwrites could not be rolled back: "
            + ", ".join(overwritten_extensions)
        )


def cherry_pick_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    sources = extension_sources(root)
    selected = select_extensions(args, sources)
    if not selected:
        die("extension install requires --extension filters")
    conflicts = extension_conflicts(target, selected, sources)
    if conflicts and not args.force:
        die(
            f"extension already exists: {', '.join(conflicts)}; use --force to overwrite"
        )
    if conflicts and args.force:
        warn(
            f"--force will overwrite extensions without a recoverable backup: {', '.join(conflicts)}"
        )
    if args.dry_run:
        print("Dry run: no files changed.")
        print("Would copy extensions: " + ", ".join(selected))
        return
    require_confirmation(args, f"Install extensions to {target}")
    created: list[Path] = []
    try:
        for name in selected:
            destination = target / "agent" / "extensions" / name
            if not destination.exists():
                created.append(destination)
            copy_entry(sources[name], destination, overwrite=args.force)
        validate_target(target, [], selected)
    except DotpiError:
        rollback_partial_install(target, {}, created, conflicts if args.force else [])
        raise
    except OSError as error:
        rollback_partial_install(target, {}, created, conflicts if args.force else [])
        die(f"extension install failed: {error}")
    print(f"Installed {len(selected)} extensions; configuration untouched")


def safe_or_cherry_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    sources = extension_sources(root)
    selected = select_extensions(args, sources)
    conflicts = extension_conflicts(target, selected, sources)
    if conflicts and not args.force:
        die(
            f"extension already exists: {', '.join(conflicts)}; use --force to overwrite"
        )
    if conflicts and args.force:
        warn(
            f"--force will overwrite extensions without a recoverable extension backup: {', '.join(conflicts)}"
        )

    json_sources = direct_json_sources(root)
    previews = [
        preview
        for source in json_sources
        if (preview := json_preview(source, target / source.relative_to(root)))
    ]
    print("JSON changes:")
    print("".join(previews) if previews else "  none")
    config_paths = [
        source.relative_to(root)
        for source in json_sources
        if (target / source.relative_to(root)).exists()
    ]
    if args.dry_run:
        print("Dry run: no files changed.")
        print(f"Would back up {len(config_paths)} existing JSON files.")
        print("Would copy extensions: " + (", ".join(selected) if selected else "none"))
        return
    require_confirmation(args, f"Install mode={args.mode} to {target}")
    if config_paths:
        create_backup(target, config_paths, "before-install")

    snapshots = {
        source.relative_to(root): snapshot_file(target / source.relative_to(root))
        for source in json_sources
    }
    created_extensions: list[Path] = []
    overwritten_extensions: list[str] = []
    try:
        for source in json_sources:
            relative = source.relative_to(root)
            destination = target / relative
            atomic_write(destination, source.read_bytes(), mode(source))
        for name in selected:
            destination = target / "agent" / "extensions" / name
            if destination.exists():
                overwritten_extensions.append(name)
            else:
                created_extensions.append(destination)
            copy_entry(sources[name], destination, overwrite=args.force)
        rebuild_dependencies(target)
        validate_target(
            target,
            [source.relative_to(root) for source in json_sources],
            selected,
        )
        smoke(target)
    except DotpiError:
        rollback_partial_install(
            target, snapshots, created_extensions, overwritten_extensions
        )
        raise
    except OSError as error:
        rollback_partial_install(
            target, snapshots, created_extensions, overwritten_extensions
        )
        die(f"install failed: {error}")
    print(f"Installed {len(json_sources)} JSON files and {len(selected)} extensions")


def validate_target(
    target: Path, json_paths: list[Path], extension_names: list[str]
) -> None:
    # Validate only dotpi-owned files; target may contain unrelated extensions.
    for relative in json_paths:
        parse_json(target / relative)
    for name in extension_names:
        extension = target / "agent" / "extensions" / name
        manifest = extension / "package.json"
        if not manifest.is_file():
            die(f"installed extension {name} has no package.json")
        parsed = parse_json(manifest)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("pi"), dict):
            die(f"installed extension {name} has invalid package.json")
        entries = parsed["pi"].get("extensions")
        if not isinstance(entries, list):
            die(f"installed extension {name} has invalid extension list")
        for entry in entries:
            if not (extension / str(entry)).is_file():
                die(f"installed extension {name} entrypoint missing: {entry}")


def doctor_result(name: str, status: str, message: str) -> dict[str, str]:
    return {"name": name, "status": status, "message": message}


def doctor_readable_directory(path: Path) -> tuple[bool, str]:
    try:
        if path.is_symlink():
            return False, "symlink not followed"
        if not path.exists():
            return False, "not found"
        if not path.is_dir():
            return False, "wrong type; expected directory"
        if not os.access(path, os.R_OK | os.X_OK):
            return False, "not readable"
    except OSError as error:
        return False, f"not readable: {error}"
    return True, "readable directory"


def doctor_json_result(path: Path) -> dict[str, str]:
    name = f"json:{path.name}"
    if path.is_symlink():
        return doctor_result(name, "FAIL", f"{path}: symlink not followed")
    if not path.is_file():
        return doctor_result(name, "FAIL", f"{path}: wrong type; expected file")
    try:
        readable = os.access(path, os.R_OK)
    except OSError as error:
        return doctor_result(name, "FAIL", f"{path}: not readable: {error}")
    if not readable:
        return doctor_result(name, "FAIL", f"{path}: not readable")
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return doctor_result(name, "FAIL", f"{path}: invalid JSON: {error}")
    return doctor_result(name, "PASS", f"{path}: valid JSON")


def doctor_entrypoint(extension: Path, entry: Any) -> str | None:
    if not isinstance(entry, str):
        return "entrypoint is not a string"
    relative = Path(entry)
    if relative.is_absolute() or ".." in relative.parts:
        return f"invalid entrypoint path: {entry}"
    current = extension
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            return f"entrypoint symlink not followed: {entry}"
    if not current.is_file():
        return f"entrypoint missing: {entry}"
    try:
        readable = os.access(current, os.R_OK)
    except OSError:
        return f"entrypoint not readable: {entry}"
    if not readable:
        return f"entrypoint not readable: {entry}"
    return None


def doctor_extension_result(extension: Path) -> dict[str, str]:
    name = f"extension:{extension.name}"
    if extension.is_symlink():
        return doctor_result(name, "FAIL", f"{extension}: symlink not followed")
    if not extension.is_dir():
        return doctor_result(
            name, "FAIL", f"{extension}: wrong type; expected directory"
        )
    try:
        readable = os.access(extension, os.R_OK | os.X_OK)
    except OSError as error:
        return doctor_result(name, "FAIL", f"{extension}: not readable: {error}")
    if not readable:
        return doctor_result(name, "FAIL", f"{extension}: not readable")
    manifest_path = extension / "package.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        return doctor_result(name, "FAIL", f"{manifest_path}: missing readable file")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return doctor_result(name, "FAIL", f"{manifest_path}: invalid JSON: {error}")
    if not isinstance(manifest, dict) or not isinstance(manifest.get("pi"), dict):
        return doctor_result(name, "FAIL", f"{manifest_path}: missing pi manifest")
    entries = manifest["pi"].get("extensions")
    if not isinstance(entries, list) or not entries:
        return doctor_result(name, "FAIL", f"{extension}: no pi extension entrypoint")
    for entry in entries:
        if error := doctor_entrypoint(extension, entry):
            return doctor_result(name, "FAIL", f"{extension}: {error}")
    return doctor_result(name, "PASS", f"{extension}: valid manifest and entrypoints")


def doctor_command(args: argparse.Namespace) -> None:
    target = target_path(args.target)
    checks: list[dict[str, str]] = []
    target_ok, target_message = doctor_readable_directory(target)
    checks.append(
        doctor_result(
            "target", "PASS" if target_ok else "FAIL", f"{target}: {target_message}"
        )
    )
    agent = target / "agent"
    if not target_ok:
        checks.append(doctor_result("agent", "SKIP", "target prerequisite failed"))
        checks.append(doctor_result("auth", "SKIP", "agent prerequisite failed"))
        checks.append(doctor_result("config", "SKIP", "agent prerequisite failed"))
        checks.append(doctor_result("extensions", "SKIP", "agent prerequisite failed"))
    else:
        agent_ok, agent_message = doctor_readable_directory(agent)
        checks.append(
            doctor_result(
                "agent", "PASS" if agent_ok else "FAIL", f"{agent}: {agent_message}"
            )
        )
        if not agent_ok:
            checks.append(doctor_result("auth", "SKIP", "agent prerequisite failed"))
            checks.append(doctor_result("config", "SKIP", "agent prerequisite failed"))
            checks.append(
                doctor_result("extensions", "SKIP", "agent prerequisite failed")
            )
        else:
            auth = agent / AUTH.name
            checks.append(
                doctor_result("auth", "PASS", "present; contents not checked")
                if os.path.lexists(auth)
                else doctor_result("auth", "PASS", "absent; optional")
            )
            try:
                json_paths = sorted(
                    path
                    for path in agent.iterdir()
                    if path.name != AUTH.name and path.suffix == ".json"
                )
            except OSError as error:
                checks.append(
                    doctor_result("config", "FAIL", f"cannot list {agent}: {error}")
                )
                json_paths = []
            if json_paths:
                checks.extend(doctor_json_result(path) for path in json_paths)
            else:
                checks.append(
                    doctor_result(
                        "config", "WARN", f"{agent}: no direct config JSON files found"
                    )
                )
            extensions_root = agent / "extensions"
            if not extensions_root.exists() and not extensions_root.is_symlink():
                checks.append(
                    doctor_result("extensions", "PASS", "no installed extensions")
                )
            elif extensions_root.is_symlink() or not extensions_root.is_dir():
                checks.append(
                    doctor_result(
                        "extensions",
                        "FAIL",
                        f"{extensions_root}: invalid extensions directory",
                    )
                )
            else:
                try:
                    readable = os.access(extensions_root, os.R_OK | os.X_OK)
                except OSError as error:
                    checks.append(
                        doctor_result(
                            "extensions",
                            "FAIL",
                            f"{extensions_root}: not readable: {error}",
                        )
                    )
                    readable = False
                if not readable:
                    checks.append(
                        doctor_result(
                            "extensions", "FAIL", f"{extensions_root}: not readable"
                        )
                    )
                else:
                    try:
                        extensions = sorted(
                            path
                            for path in extensions_root.iterdir()
                            if path.is_dir() or path.is_symlink()
                        )
                    except OSError as error:
                        checks.append(
                            doctor_result(
                                "extensions",
                                "FAIL",
                                f"cannot list {extensions_root}: {error}",
                            )
                        )
                        extensions = []
                    checks.extend(doctor_extension_result(path) for path in extensions)
    overall = (
        "FAIL"
        if any(check["status"] == "FAIL" for check in checks)
        else "WARN"
        if any(check["status"] == "WARN" for check in checks)
        else "PASS"
    )
    payload = {"target": str(target), "overall": overall, "checks": checks}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for check in checks:
            print(f"{check['status']} {check['name']}: {check['message']}")
    if overall == "FAIL":
        raise DotpiError(1)


def git_run(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    command = ["git", "-C", str(root), *arguments]
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        return subprocess.CompletedProcess(command, 127, "", str(error))


def git_failure(
    result: subprocess.CompletedProcess[str], action: str, code: int = 2
) -> NoReturn:
    detail = (result.stderr or result.stdout).strip()
    die(f"git {action} failed{(': ' + detail) if detail else ''}", code)


def git_upstream(root: Path) -> tuple[str, str, str]:
    result = git_run(root, "rev-parse", "--symbolic-full-name", "@{u}")
    if result.returncode:
        git_failure(result, "find configured upstream")
    reference = result.stdout.strip()
    prefix = "refs/remotes/"
    if not reference.startswith(prefix) or "/" not in reference[len(prefix) :]:
        die(f"configured upstream is not a remote branch: {reference}")
    remote, branch = reference[len(prefix) :].split("/", 1)
    return remote, branch, reference


def git_relation(root: Path, local: str, remote: str) -> str:
    if local == remote:
        return "same"
    result = git_run(root, "cat-file", "-e", f"{remote}^{{commit}}")
    if result.returncode:
        return "unknown"
    result = git_run(root, "merge-base", "--is-ancestor", local, remote)
    if result.returncode == 0:
        return "behind"
    result = git_run(root, "merge-base", "--is-ancestor", remote, local)
    if result.returncode == 0:
        return "ahead"
    return "diverged"


def update_command(args: argparse.Namespace) -> None:
    root = repo_root()
    status = git_run(root, "status", "--porcelain", "--untracked-files=all")
    if status.returncode:
        git_failure(status, "inspect worktree")
    if status.stdout:
        die("dotpi checkout has local changes; commit or stash them first", 1)
    branch = git_run(root, "symbolic-ref", "--quiet", "--short", "HEAD")
    if branch.returncode:
        die("dotpi checkout is detached; checkout a branch first", 1)
    remote, remote_branch, upstream = git_upstream(root)
    head = git_run(root, "rev-parse", "HEAD")
    if head.returncode:
        git_failure(head, "read HEAD")
    local = head.stdout.strip()
    if args.dry_run:
        remote_result = git_run(
            root, "ls-remote", remote, f"refs/heads/{remote_branch}"
        )
        if remote_result.returncode:
            git_failure(remote_result, "inspect upstream")
        line = remote_result.stdout.strip().splitlines()
        if not line or not line[0].split()[0]:
            die(f"configured upstream has no branch: {remote}/{remote_branch}")
        remote_head = line[0].split()[0]
        relation = git_relation(root, local, remote_head)
        if relation == "same":
            print(f"Already up to date: {branch.stdout.strip()} at {local[:12]}")
        elif relation == "behind":
            count = git_run(root, "rev-list", "--count", f"{local}..{remote_head}")
            suffix = (
                f" ({count.stdout.strip()} commit(s))" if count.returncode == 0 else ""
            )
            print(
                f"Would fast-forward {branch.stdout.strip()} from {local[:12]} to {remote_head[:12]}{suffix}"
            )
        elif relation == "unknown":
            print(
                f"Update available: upstream {remote_head[:12]}; ancestry not verified in dry-run"
            )
        elif relation == "ahead":
            die(
                f"local branch is ahead of configured upstream {upstream}; refusing update",
                1,
            )
        else:
            die(
                f"local branch diverged from configured upstream {upstream}; refusing update",
                1,
            )
        return
    require_confirmation(args, f"Update dotpi from {remote}/{remote_branch}")
    fetched = git_run(root, "fetch", "--no-tags", remote, remote_branch)
    if fetched.returncode:
        git_failure(fetched, "fetch upstream")
    upstream_head = git_run(root, "rev-parse", upstream)
    if upstream_head.returncode:
        git_failure(upstream_head, "read fetched upstream")
    remote_head = upstream_head.stdout.strip()
    relation = git_relation(root, local, remote_head)
    if relation == "same":
        print(f"Already up to date: {branch.stdout.strip()} at {local[:12]}")
        return
    if relation != "behind":
        message = "ahead of" if relation == "ahead" else "diverged from"
        die(
            f"local branch is {message} configured upstream {upstream}; refusing update",
            1,
        )
    merged = git_run(root, "merge", "--ff-only", upstream)
    if merged.returncode:
        git_failure(merged, "fast-forward update")
    print(f"Updated dotpi to {remote_head[:12]}")


def sync_path_specs(args: argparse.Namespace) -> list[tuple[str, Path]]:
    selected: list[tuple[str, Path]] = []
    if args.settings:
        selected.append(("settings.json", Path("agent/settings.json")))
    if args.models:
        selected.append(("models.json", Path("agent/models.json")))
    if not selected:
        die("sync requires --settings and/or --models")
    return selected


def provider_projection(
    value: Any, path: tuple[str, ...] = ()
) -> dict[tuple[str, ...], Any]:
    projection: dict[tuple[str, ...], Any] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = path + (str(key),)
            if str(key).lower() in {"provider", "providers", "defaultprovider"}:
                projection[child_path] = child
            else:
                projection.update(provider_projection(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            projection.update(provider_projection(child, path + (f"[{index}]",)))
    return projection


def structural_diff(
    source: Any, target: Any, path: tuple[str, ...] = ()
) -> list[tuple[str, str]]:
    if isinstance(source, dict) and isinstance(target, dict):
        changes: list[tuple[str, str]] = []
        for key in sorted(set(source) | set(target)):
            child = path + (str(key),)
            if key not in source:
                changes.append(("removed", ".".join(child)))
            elif key not in target:
                changes.append(("added", ".".join(child)))
            else:
                changes.extend(structural_diff(source[key], target[key], child))
        return changes
    if isinstance(source, list) and isinstance(target, list):
        if source == target:
            return []
        return [("changed", ".".join(path) or "<root>")]
    if source != target:
        return [("changed", ".".join(path) or "<root>")]
    return []


def sync_rollback(
    target: Path,
    snapshots: dict[Path, tuple[bytes, int] | None],
    backup: Path,
    original: Exception,
) -> NoReturn:
    rollback_errors: list[str] = []
    for relative, snapshot in snapshots.items():
        if snapshot is None:
            continue
        try:
            restore_snapshot(target / relative, snapshot)
        except (DotpiError, OSError):
            rollback_errors.append(str(target / relative))
    if rollback_errors:
        die(
            f"sync failed ({original}); rollback failed for {', '.join(rollback_errors)}; "
            f"backup retained at {backup}",
            2,
        )
    if isinstance(original, DotpiError):
        raise original
    die(f"sync failed: {original}")


def sync_command(args: argparse.Namespace) -> None:
    root = repo_root()
    target = target_path(args.target)
    ensure_target_safe(target)
    if (
        not target.is_dir()
        or (target / "agent").is_symlink()
        or not (target / "agent").is_dir()
    ):
        die(f"sync target is not an installed Pi target: {target}")
    reports: list[dict[str, Any]] = []
    changes: list[tuple[str, Path, Path, bytes, int]] = []
    provider_blocked = False
    for name, relative in sync_path_specs(args):
        source = root / relative
        destination = target / relative
        if source.is_symlink() or not source.is_file():
            die(f"sync source is missing: {source}")
        if destination.is_symlink():
            reports.append(
                {
                    "name": name,
                    "status": "FAIL",
                    "message": "target is a symlink; refusing to follow",
                }
            )
            continue
        if not destination.exists():
            reports.append(
                {
                    "name": name,
                    "status": "SKIP",
                    "message": "target file missing; install it before sync",
                }
            )
            continue
        if not destination.is_file():
            reports.append(
                {
                    "name": name,
                    "status": "FAIL",
                    "message": "target is not a regular file",
                }
            )
            continue
        source_value = parse_json(source)
        target_value = parse_json(destination)
        differences = structural_diff(source_value, target_value)
        source_providers = provider_projection(source_value)
        target_providers = provider_projection(target_value)
        provider_differences = sorted(
            ".".join(path)
            for path in set(source_providers) | set(target_providers)
            if path not in source_providers
            or path not in target_providers
            or source_providers[path] != target_providers[path]
        )
        if provider_differences:
            provider_blocked = True
        status = (
            "BLOCKED" if provider_differences else "PASS" if not differences else "WARN"
        )
        message = "unchanged" if not differences else f"{len(differences)} change(s)"
        report = {
            "name": name,
            "status": status,
            "message": message,
            "changes": [
                {"status": status_text, "path": f"{name}.{path}"}
                for status_text, path in differences
            ],
            "provider_conflicts": [f"{name}.{path}" for path in provider_differences],
        }
        reports.append(report)
        if differences and not provider_differences:
            changes.append(
                (name, relative, destination, source.read_bytes(), mode(destination))
            )
    overall = (
        "BLOCKED"
        if provider_blocked
        else "FAIL"
        if any(report["status"] == "FAIL" for report in reports)
        else "WARN"
        if any(report["status"] in {"WARN", "SKIP"} for report in reports)
        else "PASS"
    )
    if args.json:
        print(
            json.dumps(
                {"target": str(target), "overall": overall, "files": reports}, indent=2
            )
        )
    else:
        for report in reports:
            print(f"{report['status']} {report['name']}: {report['message']}")
            for change in report.get("changes", []):
                print(f"  {change['status']} {change['path']}")
            for conflict in report.get("provider_conflicts", []):
                print(f"  blocked provider difference: {conflict}")
    if any(report["status"] == "FAIL" for report in reports):
        die("sync could not read selected target files")
    if provider_blocked:
        raise DotpiError(1)
    if not args.apply or not changes:
        return
    require_confirmation(args, f"Apply dotpi configuration sync to {target}")
    changed_paths = [relative for _, relative, _, _, _ in changes]
    backup = create_backup(target, changed_paths, "before-sync", announce=not args.json)
    snapshots = {
        relative: snapshot_file(target / relative) for relative in changed_paths
    }
    try:
        for _, _, destination, content, target_mode in changes:
            atomic_write(destination, content, target_mode)
    except DotpiError as error:
        sync_rollback(target, snapshots, backup, error)
    except OSError as error:
        sync_rollback(target, snapshots, backup, error)
    if args.json:
        print(
            json.dumps(
                {
                    "target": str(target),
                    "overall": "APPLIED",
                    "backup": backup.name,
                    "files": [name for name, *_ in changes],
                },
                indent=2,
            )
        )
    else:
        print(
            f"Applied sync for {len(changes)} file(s); backup retained: {backup.name}"
        )


def clean_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    source_agent = root / "agent"
    include_auth = args.include_auth
    if include_auth and not (source_agent / "auth.json").is_file():
        die("--include-auth requested but agent/auth.json is missing")
    if (
        not include_auth
        and is_interactive(args)
        and (source_agent / "auth.json").is_file()
    ):
        answer = input("Copy example agent/auth.json? [y/N] ").strip().lower()
        include_auth = answer in {"y", "yes"}
    if not include_auth:
        print("Skipping agent/auth.json")
    if args.force:
        warn("clean mode already replaces target; --force is ignored")
    existing = (
        [path.relative_to(target) for path in target.rglob("*")]
        if target.is_dir()
        else []
    )
    if args.dry_run:
        print("Dry run: no files changed.")
        print(f"Would back up the entire target ({len(existing)} entries).")
        print(
            "Would copy all agent content except auth.json."
            if not include_auth
            else "Would copy all agent content including auth.json."
        )
        print(
            "Would copy no extensions."
            if args.no_extensions
            else "Would copy every extension and run validation plus Pi smoke."
        )
        return
    require_confirmation(args, f"Clean install to {target}")
    if target.exists():
        create_backup(target, [Path(".")], "before-clean-install")
    had_target = target.exists()
    rollback_root = Path(tempfile.mkdtemp(prefix="dotpi-clean-rollback-"))
    try:
        if had_target:
            shutil.copytree(target, rollback_root / "old", symlinks=True)
        if target.exists():
            remove_entry(target)
        target.mkdir(parents=True, exist_ok=True)
        for entry in sorted(source_agent.iterdir()):
            if entry.name == "auth.json" and not include_auth:
                continue
            if entry.name == "extensions" and args.no_extensions:
                continue
            copy_entry(entry, target / "agent" / entry.name)
        if include_auth:
            set_private(target / AUTH)
        rebuild_dependencies(target)
        validate_target(
            target,
            [path.relative_to(root) for path in direct_json_sources(root)],
            [] if args.no_extensions else list(extension_sources(root)),
        )
        smoke(target)
    except DotpiError:
        if target.exists():
            remove_entry(target)
        old = rollback_root / "old"
        if old.exists():
            shutil.copytree(old, target, symlinks=True)
        warn("clean install rolled back")
        raise
    except OSError as error:
        if target.exists():
            remove_entry(target)
        old = rollback_root / "old"
        if old.exists():
            shutil.copytree(old, target, symlinks=True)
        warn("clean install rolled back")
        die(f"clean install failed: {error}")
    finally:
        shutil.rmtree(rollback_root, ignore_errors=True)
    print(
        f"Clean-installed dotpi to {target}; backed up {len(existing)} existing entries"
    )


def install_command(args: argparse.Namespace) -> None:
    root = repo_root()
    target = target_path(args.target)
    ensure_target_safe(target)
    validate_source(root, include_extensions=not args.no_extensions)
    if args.include_auth and args.mode != "clean":
        die("--include-auth is valid only with --mode=clean")
    if args.mode == "clean":
        clean_install(args, root, target)
    elif args.mode == "cherry-pick":
        cherry_pick_install(args, root, target)
    else:
        safe_or_cherry_install(args, root, target)


def add_target(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--target", default=None, help="target Pi directory (default: ~/.pi)"
    )


def add_confirmation(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--yes", action="store_true", help="approve non-interactive changes"
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dotpi", description="safe Pi configuration installer and backup tool"
    )
    commands = parser.add_subparsers(dest="command", required=True)

    install = commands.add_parser("install", help="install repository content")
    install.add_argument(
        "--mode", choices=("safe", "clean", "cherry-pick"), required=True
    )
    install.add_argument(
        "--force", action="store_true", help="overwrite existing selected extensions"
    )
    install.add_argument(
        "--include-auth",
        action="store_true",
        help="copy example auth.json in clean mode",
    )
    extension_group = install.add_mutually_exclusive_group()
    extension_group.add_argument(
        "--extension",
        action="append",
        help="extension name or path; repeat or comma-separate",
    )
    extension_group.add_argument(
        "--no-extensions",
        action="store_true",
        help="install configuration without copying extensions",
    )
    install.add_argument(
        "--dry-run", action="store_true", help="preview install without changing files"
    )
    add_target(install)
    add_confirmation(install)
    install.set_defaults(function=install_command)

    doctor = commands.add_parser(
        "doctor", help="check Pi target health without changing files"
    )
    doctor.add_argument(
        "--json", action="store_true", help="emit machine-readable results"
    )
    add_target(doctor)
    doctor.set_defaults(function=doctor_command)

    update = commands.add_parser("update", help="update this dotpi checkout")
    update.add_argument(
        "--dry-run", action="store_true", help="preview without changing Git state"
    )
    add_confirmation(update)
    update.set_defaults(function=update_command)

    sync = commands.add_parser(
        "sync", help="review or apply repository config to an existing Pi target"
    )
    sync.add_argument("--settings", action="store_true", help="review settings.json")
    sync.add_argument("--models", action="store_true", help="review models.json")
    sync_action = sync.add_mutually_exclusive_group()
    sync_action.add_argument(
        "--apply", action="store_true", help="apply reviewed, conflict-free files"
    )
    sync_action.add_argument(
        "--dry-run", action="store_true", help="review without changing files"
    )
    sync.add_argument(
        "--json", action="store_true", help="emit machine-readable results"
    )
    add_target(sync)
    add_confirmation(sync)
    sync.set_defaults(function=sync_command)

    backup = commands.add_parser("backup", help="create protected backup")
    backup.add_argument("paths", nargs="*", help="repository-relative paths")
    add_target(backup)
    add_confirmation(backup)
    backup.set_defaults(function=backup_command)

    restore = commands.add_parser("restore", help="restore backup contents")
    restore.add_argument("backup_id")
    restore.add_argument("paths", nargs="*", help="repository-relative paths")
    add_target(restore)
    add_confirmation(restore)
    restore.set_defaults(function=restore_command)

    listing = commands.add_parser("list", help="list backups")
    add_target(listing)
    listing.set_defaults(function=list_command)

    delete = commands.add_parser("delete", help="delete one backup")
    delete.add_argument("backup_id")
    add_target(delete)
    add_confirmation(delete)
    delete.set_defaults(function=delete_command)

    prune = commands.add_parser(
        "prune", help="delete backups by explicit retention rule"
    )
    group = prune.add_mutually_exclusive_group()
    group.add_argument("--keep", type=int, help="keep newest N backups")
    group.add_argument(
        "--older-than", help="delete backups older than duration, e.g. 30d"
    )
    add_target(prune)
    add_confirmation(prune)
    prune.set_defaults(function=prune_command)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        args.function(args)
    except DotpiError as error:
        raise SystemExit(error.code) from None
    except KeyboardInterrupt:
        print(f"{APP}: error: cancelled", file=sys.stderr)
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
