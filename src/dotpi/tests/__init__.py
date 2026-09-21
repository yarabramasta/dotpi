"""Test suite for the dotpi package.

Runs via `python3 -m unittest discover -s src -t src`.
The path bootstrap below also makes direct invocations work
(`python3 -m unittest dotpi.tests.test_doctor` from the repository root).
"""

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[2]
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
