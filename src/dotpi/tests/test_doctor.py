"""Doctor command: read-only health checks against a Pi target."""

import argparse
import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from dotpi import doctor
from dotpi.errors import DotpiError


class DoctorTests(unittest.TestCase):
    def test_doctor_missing_target_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(
                target=str(Path(directory) / "missing"), json=False
            )
            with (
                contextlib.redirect_stdout(io.StringIO()),
                self.assertRaises(DotpiError) as raised,
            ):
                doctor.doctor_command(args)
            self.assertEqual(raised.exception.code, 1)


if __name__ == "__main__":
    unittest.main()
