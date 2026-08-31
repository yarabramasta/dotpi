import argparse
import contextlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import dotpi


class DoctorAndSyncTests(unittest.TestCase):
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

            original_root = dotpi.repo_root
            dotpi.repo_root = lambda: clone
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    dotpi.update_command(argparse.Namespace(dry_run=True, yes=False))
                    dotpi.update_command(argparse.Namespace(dry_run=False, yes=True))
            finally:
                dotpi.repo_root = original_root
            self.assertEqual((clone / "version.txt").read_text(), "two")

    def test_structural_diff_ignores_object_order_but_not_null(self):
        self.assertEqual(dotpi.structural_diff({"b": 2, "a": 1}, {"a": 1, "b": 2}), [])
        self.assertEqual(
            dotpi.structural_diff({"value": None}, {}), [("added", "value")]
        )

    def test_provider_projection_detects_provider_fields(self):
        source = {
            "defaultProvider": "openai",
            "providers": {"openai": {"baseUrl": "x"}},
        }
        target = {
            "defaultProvider": "openai",
            "providers": {"openai": {"baseUrl": "y"}},
        }
        self.assertNotEqual(
            dotpi.provider_projection(source), dotpi.provider_projection(target)
        )

    def test_doctor_missing_target_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(
                target=str(Path(directory) / "missing"), json=False
            )
            with (
                contextlib.redirect_stdout(io.StringIO()),
                self.assertRaises(dotpi.DotpiError) as raised,
            ):
                dotpi.doctor_command(args)
            self.assertEqual(raised.exception.code, 1)

    def test_sync_review_does_not_write(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "agent").mkdir()
            source = Path("agent/settings.json")
            destination = target / source
            shutil.copy2(source, destination)
            data = json.loads(destination.read_text())
            data["theme"] = "fixture-theme"
            destination.write_text(json.dumps(data))
            before = destination.read_bytes()
            args = argparse.Namespace(
                target=str(target),
                settings=True,
                models=False,
                apply=False,
                dry_run=True,
                json=False,
                yes=False,
            )
            with contextlib.redirect_stdout(io.StringIO()) as output:
                dotpi.sync_command(args)
            self.assertEqual(destination.read_bytes(), before)
            self.assertIn("changed", output.getvalue())

    def test_sync_apply_creates_backup_and_preserves_target_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "agent").mkdir()
            source = Path("agent/settings.json")
            destination = target / source
            shutil.copy2(source, destination)
            data = json.loads(destination.read_text())
            data["theme"] = "fixture-theme"
            destination.write_text(json.dumps(data))
            target_mode = destination.stat().st_mode & 0o777
            args = argparse.Namespace(
                target=str(target),
                settings=True,
                models=False,
                apply=True,
                dry_run=False,
                json=False,
                yes=True,
            )
            with contextlib.redirect_stdout(io.StringIO()):
                dotpi.sync_command(args)
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            self.assertEqual(destination.stat().st_mode & 0o777, target_mode)
            backups = list(target.parent.glob(f"{target.name}-backups/*"))
            self.assertEqual(len(backups), 1)


if __name__ == "__main__":
    unittest.main()
