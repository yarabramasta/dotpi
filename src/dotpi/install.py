"""Install commands: clean, safe, and cherry-pick modes with rollback."""

from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

from .backup import create_backup
from .config import AUTH, ensure_target_safe, repo_root, target_path
from .errors import DotpiError, die, warn
from .fsutil import (
    atomic_write,
    copy_entry,
    mode,
    parse_int,
    remove_entry,
    restore_snapshot,
    set_private,
    snapshot_file,
)
from .interact import is_interactive, require_confirmation
from .jsonio import (
    direct_json_sources,
    extension_sources,
    json_preview,
    parse_json,
    validate_source,
)
from .runtime import rebuild_dependencies, smoke


def select_entries(
    args: argparse.Namespace,
    sources: dict[str, Path],
    noun: str,
    flag_hint: str,
    filters: list[str] | None,
    skip_all: bool,
    required: bool = True,
) -> list[str]:
    if skip_all:
        return []
    names = [item for value in (filters or []) for item in value.split(",") if item]
    if names:
        selected: list[str] = []
        for item in names:
            name = Path(item).name
            if name not in sources:
                die(
                    f"unknown {noun} filter: {item}; "
                    f"choices: {', '.join(sources) or 'none'}"
                )
            if name not in selected:
                selected.append(name)
        return selected
    if not is_interactive(args):
        if required:
            die(f"non-interactive install requires {flag_hint} filters")
        return []
    if not sources:
        return []
    print(f"Available {noun}s:")
    for index, name in enumerate(sources, 1):
        print(f"  {index}. {name}")
    answer = input(
        f"Select {noun}s (comma-separated numbers/names, blank=all): "
    ).strip()
    if not answer:
        return list(sources)
    selected = []
    for item in answer.split(","):
        item = item.strip()
        if item.isdigit():
            index = parse_int(item, f"{noun} selection") - 1
            if not 0 <= index < len(sources):
                die(f"unknown {noun} selection: {item}")
            name = list(sources)[index]
        else:
            name = Path(item).name
        if name not in sources:
            die(f"unknown {noun} selection: {item}")
        if name not in selected:
            selected.append(name)
    return selected


def select_extensions(
    args: argparse.Namespace, sources: dict[str, Path], required: bool = True
) -> list[str]:
    return select_entries(
        args,
        sources,
        "extension",
        "--extension (-e)",
        args.extension,
        args.no_extensions,
        required,
    )


def entry_conflicts(target: Path, selected: list[str], kind: str) -> list[str]:
    return [name for name in selected if (target / "agent" / kind / name).exists()]


def extension_conflicts(target: Path, selected: list[str]) -> list[str]:
    return entry_conflicts(target, selected, "extensions")


def rollback_partial_install(
    target: Path,
    snapshots: dict[Path, tuple[bytes, int] | None],
    created_dirs: list[Path],
    overwritten_names: list[str],
) -> None:
    for relative, snapshot in snapshots.items():
        restore_snapshot(target / relative, snapshot)
    for directory in created_dirs:
        if directory.exists() or directory.is_symlink():
            remove_entry(directory)
    if overwritten_names:
        warn(
            "forced overwrites could not be rolled back: "
            + ", ".join(overwritten_names)
        )


def cherry_pick_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    sources = extension_sources(root)
    selected = select_extensions(args, sources, required=False)
    if not selected:
        die("cherry-pick requires --extension (-e) filters")
    conflicts = extension_conflicts(target, selected)
    if conflicts and not args.force:
        die(
            f"extension already exists: {', '.join(conflicts)}; "
            "use --force (-f) to overwrite"
        )
    if conflicts and args.force:
        warn(
            "--force (-f) will overwrite extensions without a recoverable backup: "
            + ", ".join(conflicts)
        )
    if args.dry_run:
        print("Dry run: no files changed.")
        print("Would copy extensions: " + (", ".join(selected) if selected else "none"))
        return
    require_confirmation(args, f"Install extensions to {target}")
    created: list[Path] = []
    try:
        for name in selected:
            destination = target / "agent" / "extensions" / name
            if not destination.exists():
                created.append(destination)
            copy_entry(sources[name], destination, overwrite=args.force)
        validate_target(target, [], selected)
    except DotpiError:
        rollback_partial_install(target, {}, created, conflicts if args.force else [])
        raise
    except OSError as error:
        rollback_partial_install(target, {}, created, conflicts if args.force else [])
        die(f"install failed: {error}")
    print(f"Installed {len(selected)} extensions; configuration untouched")


def safe_or_cherry_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    sources = extension_sources(root)
    selected = select_extensions(args, sources)
    conflicts = extension_conflicts(target, selected)
    if conflicts and not args.force:
        die(
            f"extension already exists: {', '.join(conflicts)}; "
            "use --force (-f) to overwrite"
        )
    if conflicts and args.force:
        warn(
            "--force (-f) will overwrite extensions without a recoverable "
            "extension backup: " + ", ".join(conflicts)
        )

    json_sources = direct_json_sources(root)
    agent_defs_dir = root / "agent" / "agents"
    agent_docs = sorted(agent_defs_dir.glob("*.md")) if agent_defs_dir.is_dir() else []
    previews = [
        preview
        for source in json_sources
        if (preview := json_preview(source, target / source.relative_to(root)))
    ]
    print("JSON changes:")
    print("".join(previews) if previews else "  none")
    if agent_docs:
        print("Agent definitions:")
        for doc in agent_docs:
            destination = target / "agent" / "agents" / doc.name
            state = "update" if destination.exists() else "create"
            print(f"  {state} agent/agents/{doc.name}")
    config_paths = [
        source.relative_to(root)
        for source in json_sources
        if (target / source.relative_to(root)).exists()
    ]
    if args.dry_run:
        print("Dry run: no files changed.")
        print(f"Would back up {len(config_paths)} existing JSON files.")
        if agent_docs:
            print(f"Would copy {len(agent_docs)} agent definition file(s).")
        print("Would copy extensions: " + (", ".join(selected) if selected else "none"))
        return
    require_confirmation(args, f"Install mode={args.mode} to {target}")
    if config_paths:
        create_backup(target, config_paths, "before-install")

    snapshots = {
        source.relative_to(root): snapshot_file(target / source.relative_to(root))
        for source in json_sources
    }
    for doc in agent_docs:
        snapshots[Path("agent") / "agents" / doc.name] = snapshot_file(
            target / "agent" / "agents" / doc.name
        )
    created_dirs: list[Path] = []
    overwritten_names: list[str] = []
    try:
        for source in json_sources:
            relative = source.relative_to(root)
            destination = target / relative
            atomic_write(destination, source.read_bytes(), mode(source))
        for doc in agent_docs:
            destination = target / "agent" / "agents" / doc.name
            atomic_write(destination, doc.read_bytes(), mode(doc))
        for name in selected:
            destination = target / "agent" / "extensions" / name
            if destination.exists():
                overwritten_names.append(name)
            else:
                created_dirs.append(destination)
            copy_entry(sources[name], destination, overwrite=args.force)
        rebuild_dependencies(target)
        validate_target(
            target,
            [source.relative_to(root) for source in json_sources],
            selected,
        )
        smoke(target)
    except DotpiError:
        rollback_partial_install(target, snapshots, created_dirs, overwritten_names)
        raise
    except OSError as error:
        rollback_partial_install(target, snapshots, created_dirs, overwritten_names)
        die(f"install failed: {error}")
    print(f"Installed {len(json_sources)} JSON files and {len(selected)} extensions")


def validate_target(
    target: Path,
    json_paths: list[Path],
    extension_names: list[str],
) -> None:
    # Validate only dotpi-owned files; target may contain unrelated extensions.
    for relative in json_paths:
        parse_json(target / relative)
    for name in extension_names:
        extension = target / "agent" / "extensions" / name
        manifest = extension / "package.json"
        if not manifest.is_file():
            die(f"installed extension {name} has no package.json")
        parsed = parse_json(manifest)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("pi"), dict):
            die(f"installed extension {name} has invalid package.json")
        entries = parsed["pi"].get("extensions")
        if not isinstance(entries, list):
            die(f"installed extension {name} has invalid extension list")
        for entry in entries:
            if not (extension / str(entry)).is_file():
                die(f"installed extension {name} entrypoint missing: {entry}")


def clean_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    source_agent = root / "agent"
    include_auth = args.include_auth
    if include_auth and not (source_agent / "auth.json").is_file():
        die("--include-auth (-a) requested but agent/auth.json is missing")
    if (
        not include_auth
        and is_interactive(args)
        and (source_agent / "auth.json").is_file()
    ):
        answer = input("Copy example agent/auth.json? [y/N] ").strip().lower()
        include_auth = answer in {"y", "yes"}
    if not include_auth:
        print("Skipping agent/auth.json")
    if args.force:
        warn("clean mode already replaces target; --force (-f) is ignored")
    existing = (
        [path.relative_to(target) for path in target.rglob("*")]
        if target.is_dir()
        else []
    )
    if args.dry_run:
        print("Dry run: no files changed.")
        print(f"Would back up the entire target ({len(existing)} entries).")
        print(
            "Would copy all agent content except auth.json."
            if not include_auth
            else "Would copy all agent content including auth.json."
        )
        print(
            "Would copy no extensions."
            if args.no_extensions
            else "Would copy every extension."
        )
        print("Validation plus Pi smoke run before swapping the target.")
        return
    require_confirmation(args, f"Clean install to {target}")
    rollback_root = Path(tempfile.mkdtemp(prefix="dotpi-clean-rollback-"))
    staging = rollback_root / "staging"
    swapped = False
    try:
        staging_agent = staging / "agent"
        staging_agent.mkdir(parents=True)
        for entry in sorted(source_agent.iterdir()):
            if entry.name == "auth.json" and not include_auth:
                continue
            copy_entry(entry, staging_agent / entry.name)
        if not args.no_extensions:
            extensions_target = staging_agent / "extensions"
            for name, source in extension_sources(root).items():
                copy_entry(source, extensions_target / name)
        if include_auth:
            set_private(staging_agent / AUTH)
        rebuild_dependencies(staging)
        validate_target(
            staging,
            [path.relative_to(root) for path in direct_json_sources(root)],
            [] if args.no_extensions else list(extension_sources(root)),
        )
        # Stage-validate-swap: the Pi runtime (agent/bin, agent/install) lives
        # inside the target tree, so the live target must survive until the
        # new tree passes the smoke run — deleting it first destroys the
        # launcher the smoke test launches (and the running installation).
        smoke(staging)
        had_target = target.exists()
        if had_target:
            create_backup(target, [Path(".")], "before-clean-install")
            shutil.copytree(target, rollback_root / "old", symlinks=True)
            remove_entry(target)
        shutil.copytree(staging, target, symlinks=True)
        swapped = True
        # Preserve unmanaged target entries the repo does not provide: the
        # runtime itself (bin, install, npm) and session history. Clean
        # semantics govern dotpi-managed content, not the host runtime. These
        # are copied verbatim — bypassing COPY_IGNORE — because npm-installed
        # package trees (agent/npm/node_modules) are host state, not repo
        # content, and dropping them breaks every installed pi package.
        if had_target:
            old_agent = rollback_root / "old" / "agent"
            if old_agent.is_dir():
                for entry in sorted(old_agent.iterdir()):
                    destination = target / "agent" / entry.name
                    if destination.exists():
                        continue
                    if entry.is_dir():
                        shutil.copytree(entry, destination, symlinks=True)
                    else:
                        copy_entry(entry, destination)
    except DotpiError:
        if swapped:
            if target.exists():
                remove_entry(target)
            old = rollback_root / "old"
            if old.exists():
                shutil.copytree(old, target, symlinks=True)
            warn("clean install rolled back")
        raise
    except OSError as error:
        if swapped:
            if target.exists():
                remove_entry(target)
            old = rollback_root / "old"
            if old.exists():
                shutil.copytree(old, target, symlinks=True)
            warn("clean install rolled back")
        die(f"clean install failed: {error}")
    finally:
        shutil.rmtree(rollback_root, ignore_errors=True)
    print(
        f"Clean-installed dotpi to {target}; backed up {len(existing)} existing entries"
    )


def install_command(args: argparse.Namespace) -> None:
    root = repo_root()
    target = target_path(args.target)
    ensure_target_safe(target)
    validate_source(root, include_extensions=not args.no_extensions)
    if args.include_auth and args.mode != "clean":
        die("--include-auth (-a) is valid only with --mode=clean")
    if args.mode == "clean":
        clean_install(args, root, target)
    elif args.mode == "cherry-pick":
        cherry_pick_install(args, root, target)
    else:
        safe_or_cherry_install(args, root, target)
