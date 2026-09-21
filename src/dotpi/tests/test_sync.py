"""Sync command: structural diff, provider guard, review and apply."""

import argparse
import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from dotpi import sync


class SyncDiffTests(unittest.TestCase):
    def test_structural_diff_ignores_object_order_but_not_null(self):
        self.assertEqual(sync.structural_diff({"b": 2, "a": 1}, {"a": 1, "b": 2}), [])
        self.assertEqual(
            sync.structural_diff({"value": None}, {}), [("added", "value")]
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
            sync.provider_projection(source), sync.provider_projection(target)
        )


class SyncCommandTests(unittest.TestCase):
    def test_sync_review_does_not_write(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "agent").mkdir()
            source = sync.repo_root() / "agent/settings.json"
            destination = target / "agent/settings.json"
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
                sync.sync_command(args)
            self.assertEqual(destination.read_bytes(), before)
            self.assertIn("changed", output.getvalue())

    def test_sync_apply_creates_backup_and_preserves_target_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            (target / "agent").mkdir()
            source = sync.repo_root() / "agent/settings.json"
            destination = target / "agent/settings.json"
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
                sync.sync_command(args)
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            self.assertEqual(destination.stat().st_mode & 0o777, target_mode)
            backups = list(target.parent.glob(f"{target.name}-backups/*"))
            self.assertEqual(len(backups), 1)


if __name__ == "__main__":
    unittest.main()
