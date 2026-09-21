"""JSON reading, previews, and repository source validation."""

from __future__ import annotations

import difflib
import json
from pathlib import Path
from typing import Any

from .config import AUTH
from .errors import die


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
    packages = root / "packages"
    if not packages.is_dir():
        return {}
    return {
        path.name: path
        for path in sorted(packages.iterdir())
        if path.is_dir() and (path / "package.json").is_file()
    }


def skill_sources(root: Path) -> dict[str, Path]:
    skills = root / "agent" / "skills"
    if not skills.is_dir():
        return {}
    return {path.name: path for path in sorted(skills.iterdir()) if path.is_dir()}


def validate_source(
    root: Path, include_extensions: bool = True, include_skills: bool = True
) -> None:
    if not (root / "agent").is_dir():
        die("repository has no agent directory")
    for path in direct_json_sources(root):
        parse_json(path)
    auth = root / AUTH
    if auth.exists():
        parse_json(auth)
    if include_extensions:
        for name, extension in extension_sources(root).items():
            manifest_path = extension / "package.json"
            if not manifest_path.is_file():
                die(f"extension {name} has no package.json")
            manifest = parse_json(manifest_path)
            if not isinstance(manifest, dict) or not isinstance(
                manifest.get("pi"), dict
            ):
                die(f"extension {name} package.json has no pi manifest")
            entries = manifest["pi"].get("extensions")
            if not isinstance(entries, list) or not entries:
                die(f"extension {name} has no pi extension entrypoint")
            for entry in entries:
                entry_path = extension / str(entry)
                if not entry_path.is_file():
                    die(f"extension {name} entrypoint is missing: {entry}")
    if not include_skills:
        return
    for name, skill in skill_sources(root).items():
        if not (skill / "SKILL.md").is_file():
            die(f"skill {name} has no SKILL.md")


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
