"""Install command: staging swap, runtime preservation, agent mirroring."""

import argparse
import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path

from dotpi import install
from dotpi.errors import DotpiError

STUB_PI = "#!/bin/sh\nexit 0\n"


def install_args(target: Path, mode: str) -> argparse.Namespace:
    return argparse.Namespace(
        target=str(target),
        mode=mode,
        include_auth=False,
        no_extensions=True,
        extension=[],
        force=False,
        dry_run=False,
        yes=True,
    )


class CleanInstallTests(unittest.TestCase):
    def setUp(self):
        self._previous_pi = os.environ.get("DOTPI_PI")

    def tearDown(self):
        if self._previous_pi is None:
            os.environ.pop("DOTPI_PI", None)
        else:
            os.environ["DOTPI_PI"] = self._previous_pi

    def make_target_with_runtime(self, directory: Path) -> tuple[Path, Path]:
        target = directory / "pi-home"
        agent = target / "agent"
        (agent / "bin").mkdir(parents=True)
        (agent / "install").mkdir()
        (agent / "sessions").mkdir()
        stub = agent / "bin" / "pi"
        stub.write_text(STUB_PI)
        stub.chmod(0o755)
        (agent / "install" / "current-version").write_text("1.0.0\n")
        (agent / "sessions" / "seed.jsonl").write_text("{}\n")
        return target, stub

    def test_clean_install_preserves_runtime_and_installs_agents(self):
        with tempfile.TemporaryDirectory() as directory:
            target, stub = self.make_target_with_runtime(Path(directory))
            os.environ["DOTPI_PI"] = str(stub)
            with contextlib.redirect_stdout(io.StringIO()):
                install.install_command(install_args(target, "clean"))
            # dotpi-managed content landed
            self.assertTrue((target / "agent" / "settings.json").is_file())
            self.assertTrue((target / "agent" / "agents" / "specd-worker.md").is_file())
            self.assertTrue(
                (target / "agent" / "agents" / "specd-reviewer.md").is_file()
            )
            # unmanaged runtime + user state survived the swap
            self.assertTrue((target / "agent" / "bin" / "pi").is_file())
            self.assertTrue(
                (target / "agent" / "install" / "current-version").is_file()
            )
            self.assertTrue((target / "agent" / "sessions" / "seed.jsonl").is_file())
            # the smoke run actually launched the stub
            self.assertTrue(stub.is_file())

    def test_clean_install_rolls_back_when_smoke_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            target, _ = self.make_target_with_runtime(Path(directory))
            broken = Path(directory) / "broken-pi"
            broken.write_text("#!/bin/sh\nexit 3\n")
            broken.chmod(0o755)
            os.environ["DOTPI_PI"] = str(broken)
            with self.assertRaises(DotpiError):
                with contextlib.redirect_stdout(io.StringIO()):
                    with contextlib.redirect_stderr(io.StringIO()):
                        install.install_command(install_args(target, "clean"))
            # the live target is untouched: old settings still present, repo
            # agents NOT installed
            self.assertTrue((target / "agent" / "bin" / "pi").is_file())
            self.assertFalse((target / "agent" / "agents").exists())


class SafeInstallTests(unittest.TestCase):
    def setUp(self):
        self._previous_pi = os.environ.get("DOTPI_PI")

    def tearDown(self):
        if self._previous_pi is None:
            os.environ.pop("DOTPI_PI", None)
        else:
            os.environ["DOTPI_PI"] = self._previous_pi

    def test_safe_install_mirrors_agent_definitions(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "pi-home"
            (target / "agent").mkdir(parents=True)
            stub = Path(directory) / "stub-pi"
            stub.write_text(STUB_PI)
            stub.chmod(0o755)
            os.environ["DOTPI_PI"] = str(stub)
            with contextlib.redirect_stdout(io.StringIO()):
                install.install_command(install_args(target, "safe"))
            self.assertTrue((target / "agent" / "agents" / "specd-worker.md").is_file())
            self.assertTrue(
                (target / "agent" / "agents" / "specd-reviewer.md").is_file()
            )


if __name__ == "__main__":
    unittest.main()
