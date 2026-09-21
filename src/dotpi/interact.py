"""Interactive confirmation policy."""

from __future__ import annotations

import argparse
import sys

from .errors import die


def is_interactive(args: argparse.Namespace) -> bool:
    return bool(sys.stdin.isatty() and sys.stdout.isatty())


def require_confirmation(args: argparse.Namespace, action: str) -> None:
    if args.yes:
        return
    if not is_interactive(args):
        die(f"non-interactive {action} requires --yes (-y); no changes made")
    try:
        answer = input(f"{action}. Continue? [y/N] ").strip().lower()
    except EOFError:
        die(f"non-interactive {action} requires --yes (-y); no changes made")
    if answer not in {"y", "yes"}:
        die("cancelled; no changes made", 1)
