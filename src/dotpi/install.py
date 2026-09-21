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


def select_extensions(args: argparse.Namespace, sources: dict[str, Path]) -> list[str]:
    if args.no_extensions:
        return []
    filters = [
        item for value in (args.extension or []) for item in value.split(",") if item
    ]
    if filters:
        selected: list[str] = []
        for item in filters:
            name = Path(item).name
            if name not in sources:
                die(
                    f"unknown extension filter: {item}; "
                    f"choices: {', '.join(sources) or 'none'}"
                )
            if name not in selected:
                selected.append(name)
        return selected
    if not is_interactive(args):
        die("non-interactive install requires --extension (-e) filters")
    if not sources:
        return []
    print("Available extensions:")
    for index, name in enumerate(sources, 1):
        print(f"  {index}. {name}")
    answer = input(
        "Select extensions (comma-separated numbers/names, blank=all): "
    ).strip()
    if not answer:
        return list(sources)
    selected = []
    for item in answer.split(","):
        item = item.strip()
        if item.isdigit():
            index = parse_int(item, "extension selection") - 1
            if not 0 <= index < len(sources):
                die(f"unknown extension selection: {item}")
            name = list(sources)[index]
        else:
            name = Path(item).name
        if name not in sources:
            die(f"unknown extension selection: {item}")
        if name not in selected:
            selected.append(name)
    return selected


def extension_conflicts(
    target: Path, selected: list[str], sources: dict[str, Path]
) -> list[str]:
    return [
        name for name in selected if (target / "agent" / "extensions" / name).exists()
    ]


def rollback_partial_install(
    target: Path,
    snapshots: dict[Path, tuple[bytes, int] | None],
    created_extensions: list[Path],
    overwritten_extensions: list[str],
) -> None:
    for relative, snapshot in snapshots.items():
        restore_snapshot(target / relative, snapshot)
    for extension in created_extensions:
        if extension.exists() or extension.is_symlink():
            remove_entry(extension)
    if overwritten_extensions:
        warn(
            "forced extension overwrites could not be rolled back: "
            + ", ".join(overwritten_extensions)
        )


def cherry_pick_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    sources = extension_sources(root)
    selected = select_extensions(args, sources)
    if not selected:
        die("extension install requires --extension (-e) filters")
    conflicts = extension_conflicts(target, selected, sources)
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
        print("Would copy extensions: " + ", ".join(selected))
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
        die(f"extension install failed: {error}")
    print(f"Installed {len(selected)} extensions; configuration untouched")


def safe_or_cherry_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    sources = extension_sources(root)
    selected = select_extensions(args, sources)
    conflicts = extension_conflicts(target, selected, sources)
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
    previews = [
        preview
        for source in json_sources
        if (preview := json_preview(source, target / source.relative_to(root)))
    ]
    print("JSON changes:")
    print("".join(previews) if previews else "  none")
    config_paths = [
        source.relative_to(root)
        for source in json_sources
        if (target / source.relative_to(root)).exists()
    ]
    if args.dry_run:
        print("Dry run: no files changed.")
        print(f"Would back up {len(config_paths)} existing JSON files.")
        print("Would copy extensions: " + (", ".join(selected) if selected else "none"))
        return
    require_confirmation(args, f"Install mode={args.mode} to {target}")
    if config_paths:
        create_backup(target, config_paths, "before-install")

    snapshots = {
        source.relative_to(root): snapshot_file(target / source.relative_to(root))
        for source in json_sources
    }
    created_extensions: list[Path] = []
    overwritten_extensions: list[str] = []
    try:
        for source in json_sources:
            relative = source.relative_to(root)
            destination = target / relative
            atomic_write(destination, source.read_bytes(), mode(source))
        for name in selected:
            destination = target / "agent" / "extensions" / name
            if destination.exists():
                overwritten_extensions.append(name)
            else:
                created_extensions.append(destination)
            copy_entry(sources[name], destination, overwrite=args.force)
        rebuild_dependencies(target)
        validate_target(
            target,
            [source.relative_to(root) for source in json_sources],
            selected,
        )
        smoke(target)
    except DotpiError:
        rollback_partial_install(
            target, snapshots, created_extensions, overwritten_extensions
        )
        raise
    except OSError as error:
        rollback_partial_install(
            target, snapshots, created_extensions, overwritten_extensions
        )
        die(f"install failed: {error}")
    print(f"Installed {len(json_sources)} JSON files and {len(selected)} extensions")


def validate_target(
    target: Path, json_paths: list[Path], extension_names: list[str]
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
            else "Would copy every extension and run validation plus Pi smoke."
        )
        return
    require_confirmation(args, f"Clean install to {target}")
    if target.exists():
        create_backup(target, [Path(".")], "before-clean-install")
    had_target = target.exists()
    rollback_root = Path(tempfile.mkdtemp(prefix="dotpi-clean-rollback-"))
    try:
        if had_target:
            shutil.copytree(target, rollback_root / "old", symlinks=True)
        if target.exists():
            remove_entry(target)
        target.mkdir(parents=True, exist_ok=True)
        for entry in sorted(source_agent.iterdir()):
            if entry.name == "auth.json" and not include_auth:
                continue
            if entry.name == "extensions" and args.no_extensions:
                continue
            copy_entry(entry, target / "agent" / entry.name)
        if include_auth:
            set_private(target / AUTH)
        rebuild_dependencies(target)
        validate_target(
            target,
            [path.relative_to(root) for path in direct_json_sources(root)],
            [] if args.no_extensions else list(extension_sources(root)),
        )
        smoke(target)
    except DotpiError:
        if target.exists():
            remove_entry(target)
        old = rollback_root / "old"
        if old.exists():
            shutil.copytree(old, target, symlinks=True)
        warn("clean install rolled back")
        raise
    except OSError as error:
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
