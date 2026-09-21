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
    skill_sources,
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


def select_skills(
    args: argparse.Namespace, sources: dict[str, Path], required: bool = True
) -> list[str]:
    return select_entries(
        args,
        sources,
        "skill",
        "--skill (-S)",
        args.skill,
        args.no_skills,
        required,
    )


def entry_conflicts(target: Path, selected: list[str], kind: str) -> list[str]:
    return [name for name in selected if (target / "agent" / kind / name).exists()]


def extension_conflicts(target: Path, selected: list[str]) -> list[str]:
    return entry_conflicts(target, selected, "extensions")


def skill_conflicts(target: Path, selected: list[str]) -> list[str]:
    return entry_conflicts(target, selected, "skills")


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
    skill_map = skill_sources(root)
    selected = select_extensions(args, sources, required=False)
    selected_skills = select_skills(args, skill_map, required=False)
    if not selected and not selected_skills:
        die("cherry-pick requires --extension (-e) and/or --skill (-S) filters")
    conflicts = extension_conflicts(target, selected)
    skill_clashes = skill_conflicts(target, selected_skills)
    if conflicts and not args.force:
        die(
            f"extension already exists: {', '.join(conflicts)}; "
            "use --force (-f) to overwrite"
        )
    if skill_clashes and not args.force:
        die(
            f"skill already exists: {', '.join(skill_clashes)}; "
            "use --force (-f) to overwrite"
        )
    if conflicts and args.force:
        warn(
            "--force (-f) will overwrite extensions without a recoverable backup: "
            + ", ".join(conflicts)
        )
    if skill_clashes and args.force:
        warn(
            "--force (-f) will overwrite skills without a recoverable backup: "
            + ", ".join(skill_clashes)
        )
    if args.dry_run:
        print("Dry run: no files changed.")
        print("Would copy extensions: " + (", ".join(selected) if selected else "none"))
        print(
            "Would copy skills: "
            + (", ".join(selected_skills) if selected_skills else "none")
        )
        return
    require_confirmation(args, f"Install extensions and skills to {target}")
    created: list[Path] = []
    try:
        for name in selected:
            destination = target / "agent" / "extensions" / name
            if not destination.exists():
                created.append(destination)
            copy_entry(sources[name], destination, overwrite=args.force)
        for name in selected_skills:
            destination = target / "agent" / "skills" / name
            if not destination.exists():
                created.append(destination)
            copy_entry(skill_map[name], destination, overwrite=args.force)
        validate_target(target, [], selected, selected_skills)
    except DotpiError:
        rollback_partial_install(
            target, {}, created, (conflicts + skill_clashes) if args.force else []
        )
        raise
    except OSError as error:
        rollback_partial_install(
            target, {}, created, (conflicts + skill_clashes) if args.force else []
        )
        die(f"install failed: {error}")
    print(
        f"Installed {len(selected)} extensions and {len(selected_skills)} skills; "
        "configuration untouched"
    )


def safe_or_cherry_install(args: argparse.Namespace, root: Path, target: Path) -> None:
    sources = extension_sources(root)
    skill_map = skill_sources(root)
    selected = select_extensions(args, sources)
    selected_skills = select_skills(args, skill_map)
    conflicts = extension_conflicts(target, selected)
    skill_clashes = skill_conflicts(target, selected_skills)
    if conflicts and not args.force:
        die(
            f"extension already exists: {', '.join(conflicts)}; "
            "use --force (-f) to overwrite"
        )
    if skill_clashes and not args.force:
        die(
            f"skill already exists: {', '.join(skill_clashes)}; "
            "use --force (-f) to overwrite"
        )
    if conflicts and args.force:
        warn(
            "--force (-f) will overwrite extensions without a recoverable "
            "extension backup: " + ", ".join(conflicts)
        )
    if skill_clashes and args.force:
        warn(
            "--force (-f) will overwrite skills without a recoverable "
            "skill backup: " + ", ".join(skill_clashes)
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
        print(
            "Would copy skills: "
            + (", ".join(selected_skills) if selected_skills else "none")
        )
        return
    require_confirmation(args, f"Install mode={args.mode} to {target}")
    if config_paths:
        create_backup(target, config_paths, "before-install")

    snapshots = {
        source.relative_to(root): snapshot_file(target / source.relative_to(root))
        for source in json_sources
    }
    created_dirs: list[Path] = []
    overwritten_names: list[str] = []
    try:
        for source in json_sources:
            relative = source.relative_to(root)
            destination = target / relative
            atomic_write(destination, source.read_bytes(), mode(source))
        for name in selected:
            destination = target / "agent" / "extensions" / name
            if destination.exists():
                overwritten_names.append(name)
            else:
                created_dirs.append(destination)
            copy_entry(sources[name], destination, overwrite=args.force)
        for name in selected_skills:
            destination = target / "agent" / "skills" / name
            if destination.exists():
                overwritten_names.append(name)
            else:
                created_dirs.append(destination)
            copy_entry(skill_map[name], destination, overwrite=args.force)
        rebuild_dependencies(target)
        validate_target(
            target,
            [source.relative_to(root) for source in json_sources],
            selected,
            selected_skills,
        )
        smoke(target)
    except DotpiError:
        rollback_partial_install(target, snapshots, created_dirs, overwritten_names)
        raise
    except OSError as error:
        rollback_partial_install(target, snapshots, created_dirs, overwritten_names)
        die(f"install failed: {error}")
    print(
        f"Installed {len(json_sources)} JSON files, {len(selected)} extensions, "
        f"and {len(selected_skills)} skills"
    )


def validate_target(
    target: Path,
    json_paths: list[Path],
    extension_names: list[str],
    skill_names: list[str],
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
    for name in skill_names:
        skill = target / "agent" / "skills" / name
        if not (skill / "SKILL.md").is_file():
            die(f"installed skill {name} has no SKILL.md")


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
        print("Would copy no skills." if args.no_skills else "Would copy every skill.")
        print("Validation plus Pi smoke run after copying.")
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
            if entry.name == "skills" and args.no_skills:
                continue
            copy_entry(entry, target / "agent" / entry.name)
        if include_auth:
            set_private(target / AUTH)
        rebuild_dependencies(target)
        validate_target(
            target,
            [path.relative_to(root) for path in direct_json_sources(root)],
            [] if args.no_extensions else list(extension_sources(root)),
            [] if args.no_skills else list(skill_sources(root)),
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
    validate_source(
        root,
        include_extensions=not args.no_extensions,
        include_skills=not args.no_skills,
    )
    if args.include_auth and args.mode != "clean":
        die("--include-auth (-a) is valid only with --mode=clean")
    if args.mode == "clean":
        clean_install(args, root, target)
    elif args.mode == "cherry-pick":
        cherry_pick_install(args, root, target)
    else:
        safe_or_cherry_install(args, root, target)
