"""Shared failure paths: CLI label, error type, and abort helpers."""

from __future__ import annotations

import sys
from typing import NoReturn

APP = "dotpi"


class DotpiError(Exception):
    def __init__(self, code: int):
        super().__init__()
        self.code = code


def die(message: str, code: int = 2) -> NoReturn:
    print(f"{APP}: error: {message}", file=sys.stderr)
    raise DotpiError(code)


def warn(message: str) -> None:
    print(f"{APP}: warning: {message}", file=sys.stderr)
