"""Review and apply repository configuration onto an existing Pi target."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .backup import create_backup
from .config import ensure_target_safe, repo_root, target_path
from .errors import DotpiError, die
from .fsutil import atomic_write, mode, restore_snapshot, snapshot_file
from .interact import require_confirmation
from .jsonio import parse_json


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
            child_path = (*path, str(key))
            if str(key).lower() in {"provider", "providers", "defaultprovider"}:
                projection[child_path] = child
            else:
                projection.update(provider_projection(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            projection.update(provider_projection(child, (*path, f"[{index}]")))
    return projection


def structural_diff(
    source: Any, target: Any, path: tuple[str, ...] = ()
) -> list[tuple[str, str]]:
    if isinstance(source, dict) and isinstance(target, dict):
        changes: list[tuple[str, str]] = []
        for key in sorted(set(source) | set(target)):
            child = (*path, str(key))
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
) -> None:
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
            f"sync failed ({original}); rollback failed "
            f"for {', '.join(rollback_errors)}; "
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
