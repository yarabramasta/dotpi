"""Self-update command: fast-forward through a throwaway git fixture."""

import argparse
import contextlib
import io
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from dotpi import update


class UpdateTests(unittest.TestCase):
    def test_update_fast_forwards_configured_upstream(self):
        if shutil.which("git") is None:
            self.skipTest("git is required")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote.git"
            work = root / "work"
            clone = root / "clone"

            def git(*arguments: str, cwd: Path) -> None:
                subprocess.run(
                    ["git", *arguments],
                    cwd=cwd,
                    check=True,
                    capture_output=True,
                    text=True,
                )

            git("init", "--bare", str(remote), cwd=root)
            git("init", "-b", "main", str(work), cwd=root)
            git("config", "user.email", "test@example.com", cwd=work)
            git("config", "user.name", "Test", cwd=work)
            (work / "version.txt").write_text("one")
            git("add", ".", cwd=work)
            git("commit", "-m", "one", cwd=work)
            git("remote", "add", "origin", str(remote), cwd=work)
            git("push", "-u", "origin", "main", cwd=work)
            git("clone", str(remote), str(clone), cwd=root)
            git("config", "user.email", "test@example.com", cwd=clone)
            git("config", "user.name", "Test", cwd=clone)
            (work / "version.txt").write_text("two")
            git("commit", "-am", "two", cwd=work)
            git("push", cwd=work)

            original_root = update.repo_root
            update.repo_root = lambda: clone
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    update.update_command(argparse.Namespace(dry_run=True, yes=False))
                    update.update_command(argparse.Namespace(dry_run=False, yes=True))
            finally:
                update.repo_root = original_root
            self.assertEqual((clone / "version.txt").read_text(), "two")


if __name__ == "__main__":
    unittest.main()
