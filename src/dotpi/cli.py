"""Command-line interface: argument parsing and dispatch."""

from __future__ import annotations

import argparse
import sys

from .backup import (
    backup_command,
    delete_command,
    list_command,
    prune_command,
    restore_command,
)
from .doctor import doctor_command
from .errors import APP, DotpiError
from .install import install_command
from .sync import sync_command
from .update import update_command


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
