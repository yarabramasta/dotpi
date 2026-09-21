"""Health checks against an installed Pi target, read-only."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

from .config import AUTH, target_path
from .errors import DotpiError


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
            name,
            "FAIL",
            f"{extension}: wrong type; expected directory",
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
