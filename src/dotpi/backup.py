"""Protected backups: creation, restore, listing, deletion, retention."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import uuid
from pathlib import Path
from typing import Any

from .config import AUTH, backup_root, relative_path, target_path
from .errors import die
from .fsutil import mode, parse_int, remove_entry, set_mode, set_private, sha256
from .interact import require_confirmation


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
                f"{directory.name}\t{manifest.get('created_at', '?')}"
                f"\t{count} entries\t{manifest.get('label', '')}"
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
        die("prune requires --keep N (-k) or --older-than duration (-o)")
    if args.keep is not None and args.older_than is not None:
        die("prune accepts --keep (-k) or --older-than (-o), not both")
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
            die("prune requires --older-than duration (-o)")
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
