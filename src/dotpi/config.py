"""Repository and target path rules."""

from __future__ import annotations

from pathlib import Path

from .errors import die

AUTH = Path("agent/auth.json")
DEFAULT_TARGET = Path.home() / ".pi"


def repo_root() -> Path:
    # Package lives in <repo>/src/dotpi/, so the repository root is three levels up.
    return Path(__file__).resolve().parent.parent.parent


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


def ensure_target_safe(target: Path) -> None:
    if target in {Path("/"), Path.home().resolve()}:
        die(f"refusing unsafe target: {target}")
