"""Filesystem primitives: hashing, modes, copying, snapshots, atomic writes."""

from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import stat
import tempfile
from pathlib import Path
from typing import Any

from .errors import die


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


# Workspace build artifacts must never reach the Pi target; extension sources
# live in packages/<name> and node_modules (if any) stays behind.
COPY_IGNORE = shutil.ignore_patterns(
    "node_modules",
    ".pnpm",
    "pnpm-lock.yaml",
    "package-lock.json",
    "*.tsbuildinfo",
)


def copy_entry(source: Path, destination: Path, overwrite: bool = False) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_symlink():
        # Repo-relative symlink: install real content, never a dangling link.
        source = source.resolve()
    if source.is_dir():
        if destination.exists() and not overwrite:
            die(f"path exists: {destination}")
        if destination.exists():
            remove_entry(destination)
        # symlinks=False dereferences inner symlinks so the target gets
        # real files instead of repo-relative links.
        shutil.copytree(
            source,
            destination,
            symlinks=False,
            ignore=COPY_IGNORE,
            copy_function=shutil.copy2,
        )
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
