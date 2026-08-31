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


def create_backup(target: Path, paths: list[Path], label: str) -> Path:
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
