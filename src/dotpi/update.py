"""Self-update of this dotpi checkout through its configured git upstream."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path
from typing import NoReturn

from .config import repo_root
from .errors import die
from .interact import require_confirmation


def git_run(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    command = ["git", "-C", str(root), *arguments]
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError as error:
        return subprocess.CompletedProcess(command, 127, "", str(error))


def git_failure(
    result: subprocess.CompletedProcess[str], action: str, code: int = 2
) -> NoReturn:
    detail = (result.stderr or result.stdout).strip()
    die(f"git {action} failed{(': ' + detail) if detail else ''}", code)


def git_upstream(root: Path) -> tuple[str, str, str]:
    result = git_run(root, "rev-parse", "--symbolic-full-name", "@{u}")
    if result.returncode:
        git_failure(result, "find configured upstream")
    reference = result.stdout.strip()
    prefix = "refs/remotes/"
    if not reference.startswith(prefix) or "/" not in reference[len(prefix) :]:
        die(f"configured upstream is not a remote branch: {reference}")
    remote, branch = reference[len(prefix) :].split("/", 1)
    return remote, branch, reference


def git_relation(root: Path, local: str, remote: str) -> str:
    if local == remote:
        return "same"
    result = git_run(root, "cat-file", "-e", f"{remote}^{{commit}}")
    if result.returncode:
        return "unknown"
    result = git_run(root, "merge-base", "--is-ancestor", local, remote)
    if result.returncode == 0:
        return "behind"
    result = git_run(root, "merge-base", "--is-ancestor", remote, local)
    if result.returncode == 0:
        return "ahead"
    return "diverged"


def update_command(args: argparse.Namespace) -> None:
    root = repo_root()
    status = git_run(root, "status", "--porcelain", "--untracked-files=all")
    if status.returncode:
        git_failure(status, "inspect worktree")
    if status.stdout:
        die("dotpi checkout has local changes; commit or stash them first", 1)
    branch = git_run(root, "symbolic-ref", "--quiet", "--short", "HEAD")
    if branch.returncode:
        die("dotpi checkout is detached; checkout a branch first", 1)
    remote, remote_branch, upstream = git_upstream(root)
    head = git_run(root, "rev-parse", "HEAD")
    if head.returncode:
        git_failure(head, "read HEAD")
    local = head.stdout.strip()
    if args.dry_run:
        remote_result = git_run(
            root, "ls-remote", remote, f"refs/heads/{remote_branch}"
        )
        if remote_result.returncode:
            git_failure(remote_result, "inspect upstream")
        line = remote_result.stdout.strip().splitlines()
        if not line or not line[0].split()[0]:
            die(f"configured upstream has no branch: {remote}/{remote_branch}")
        remote_head = line[0].split()[0]
        relation = git_relation(root, local, remote_head)
        if relation == "same":
            print(f"Already up to date: {branch.stdout.strip()} at {local[:12]}")
        elif relation == "behind":
            count = git_run(root, "rev-list", "--count", f"{local}..{remote_head}")
            suffix = (
                f" ({count.stdout.strip()} commit(s))" if count.returncode == 0 else ""
            )
            print(
                f"Would fast-forward {branch.stdout.strip()} "
                f"from {local[:12]} to {remote_head[:12]}{suffix}"
            )
        elif relation == "unknown":
            print(
                f"Update available: upstream {remote_head[:12]}; "
                "ancestry not verified in dry-run"
            )
        elif relation == "ahead":
            die(
                f"local branch is ahead of configured upstream {upstream}; "
                "refusing update",
                1,
            )
        else:
            die(
                f"local branch diverged from configured upstream {upstream}; "
                "refusing update",
                1,
            )
        return
    require_confirmation(args, f"Update dotpi from {remote}/{remote_branch}")
    fetched = git_run(root, "fetch", "--no-tags", remote, remote_branch)
    if fetched.returncode:
        git_failure(fetched, "fetch upstream")
    upstream_head = git_run(root, "rev-parse", upstream)
    if upstream_head.returncode:
        git_failure(upstream_head, "read fetched upstream")
    remote_head = upstream_head.stdout.strip()
    relation = git_relation(root, local, remote_head)
    if relation == "same":
        print(f"Already up to date: {branch.stdout.strip()} at {local[:12]}")
        return
    if relation != "behind":
        message = "ahead of" if relation == "ahead" else "diverged from"
        die(
            f"local branch is {message} configured upstream {upstream}; "
            "refusing update",
            1,
        )
    merged = git_run(root, "merge", "--ff-only", upstream)
    if merged.returncode:
        git_failure(merged, "fast-forward update")
    print(f"Updated dotpi to {remote_head[:12]}")
