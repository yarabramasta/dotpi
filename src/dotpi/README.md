# dotpi installer

The `src/dotpi` Python package behind the `./dotpi` launcher: install, doctor,
update, sync, and backup management for a Pi target directory (default
`~/.pi`). All mutating commands prompt in a terminal; non-interactive use must
pass `--yes` (`-y`) or stop before changing files.

## Commands

```text
./dotpi install [-m safe|clean|cherry-pick] [-f] [-a] [-e NAME | -n] [-S NAME | -N] [-d] [-t PATH] [-y]
./dotpi doctor [-t PATH] [-j]
./dotpi update [-d] [-y]
./dotpi sync [-s] [-M] [-A | -d] [-j] [-t PATH] [-y]
./dotpi backup [paths...] [-t PATH] [-y]
./dotpi restore BACKUP_ID [paths...] [-t PATH] [-y]
./dotpi list [-t PATH]
./dotpi delete BACKUP_ID [-t PATH] [-y]
./dotpi prune -k N [-t PATH] [-y]
./dotpi prune -o 30d [-t PATH] [-y]
```

Every flag has a short and a long form; both are accepted everywhere and the
examples below use the short form.

| Short | Long | Commands | Meaning |
| --- | --- | --- | --- |
| `-t PATH` | `--target` | all | use a target other than `~/.pi` |
| `-y` | `--yes` | mutating commands | explicit approval for non-interactive operation |
| `-m MODE` | `--mode` | install | `safe` (default), `clean`, or `cherry-pick` |
| `-f` | `--force` | install | allow selected extension or skill overwrite; not recoverable through backups |
| `-a` | `--include-auth` | install | clean mode only; include example `auth.json` |
| `-e NAME[,NAME...]` | `--extension` | install | select extensions by name or path; repeat or comma-separate (`-e jina,wandb`) |
| `-n` | `--no-extensions` | install | install configuration without copying extensions; mutually exclusive with `-e` |
| `-S NAME[,NAME...]` | `--skill` | install | select skills by name; repeat or comma-separate (`-S python-inline-scripts`) |
| `-N` | `--no-skills` | install | install configuration without copying skills; mutually exclusive with `-S` |
| `-d` | `--dry-run` | install, update, sync | preview without changing files, backups, or Git state |
| `-j` | `--json` | doctor, sync | emit machine-readable results |
| `-s` | `--settings` | sync | review `settings.json` |
| `-M` | `--models` | sync | review `models.json` |
| `-A` | `--apply` | sync | apply reviewed, conflict-free files |
| `-k N` | `--keep` | prune | keep newest N backups |
| `-o DUR` | `--older-than` | prune | delete backups older than duration (`30d`, `12h`, `45m`, `2w`) |

Note: `-d` means dry-run here, not the GNU `-n` convention — `-n` is reserved
for `--no-extensions`. The online-install one-shot examples keep long forms for
copy-paste clarity.

## Install modes

### Safe

```sh
./dotpi install
./dotpi install -e jina,wandb
./dotpi install -n
./dotpi install -e jina,wandb -d
./dotpi install -S python-inline-scripts
```

Safe mode:

1. Inspects target.
2. Copies every direct `agent/*.json` except `auth.json`.
3. Shows all JSON differences.
4. Creates a protected backup of existing JSON.
5. Asks for one confirmation, or requires `-y` when non-interactive.
6. Atomically writes JSON and copies selected extensions.
7. Validates files and runs isolated Pi smoke.

Existing selected extensions are refused. Use `--force` (`-f`) to overwrite
them. Forced extension directories are not backed up and cannot be restored by
dotpi if a later check fails. New extension files are removed and JSON is
rolled back on failure.

Without `-e`, interactive safe mode shows an extension menu. Non-interactive
safe mode requires one or more extension filters unless `-n` is used. `-e` and
`-n` cannot be combined.

Skills follow the same selection rules as extensions: without `-S`, interactive
safe mode shows a skill menu after the extension menu; non-interactive safe
mode requires `-S` filters unless `-N` is used. `-S` and `-N` cannot be
combined, but `-e`/`-n` and `-S`/`-N` are independent groups.

`-n` (`--no-extensions`) installs configuration only. Safe and cherry-pick
modes leave target extensions untouched; clean mode skips extension copying.

`-d` (`--dry-run`) previews JSON changes, backup scope, and extension actions
without writing files, creating a backup, rebuilding dependencies, or launching
Pi smoke. It does not require `-y`.

### Clean

```sh
./dotpi install -m clean
./dotpi install -m clean -n
./dotpi install -m clean -N
./dotpi install -m clean -d
./dotpi install -m clean -y
./dotpi install -m clean -a -y
```

Clean mode backs up the entire existing `.pi`, replaces it with this
repository's `agent` tree, and copies every extension from `packages/` and
every skill. `-n` skips extensions and `-N` skips `agent/skills`. It skips
`auth.json` unless:

- interactive mode: you answer the auth prompt; or
- non-interactive mode: you pass `--include-auth` (`-a`).

The full backup is used for clean-install rollback if copying, validation, or
smoke fails.

### Cherry-pick

```sh
./dotpi install -m cherry-pick -e android-cli -y
./dotpi install -m cherry-pick -e jina -t /tmp/pi -y
./dotpi install -m cherry-pick -S python-inline-scripts -y
```

Cherry-pick copies selected extension and skill directories only, and requires
at least one filter: `-e`, `-S`, or both. It never copies `auth.json`. Existing
selections require `--force` (`-f`).

## Doctor, update, and sync

`doctor` is a quick, read-only preflight. It checks target layout, direct JSON
validity, installed extension manifests/entrypoints, and installed skill
`SKILL.md` files. It never reads `agent/auth.json`, runs package managers, or
launches Pi. Use `-j` (`--json`) for scripts.

`update` fast-forwards this local dotpi checkout from its configured Git
upstream. It refuses dirty, detached, missing-upstream, or diverged states. It
never changes `~/.pi`; use `-d` (`--dry-run`) to query upstream without
changing Git metadata.

`sync` is separate and opt-in. First version reviews or applies existing
`settings.json` and `models.json` only:

```sh
./dotpi sync -s -d
./dotpi sync -s -M -d
./dotpi sync -s -A -y
```

Sync requires explicit file flags and defaults to review-only.
Provider/default-provider or provider-object differences block apply.
Sensitive values and provider URLs are redacted. Missing target files are not
created. Apply creates a protected backup and rolls back all selected files on
failure. Extension code syncing is deferred.

## Backups and restore

Backups live beside the target: `~/.pi-backups` for the default target. Each
timestamped backup contains preserved relative paths, modes, metadata, a
manifest, and SHA-256 checksums. Backup directories are owner-only (`0700`);
`auth.json` is owner-only (`0600`).

```sh
# Default: direct target agent JSON except auth.json
./dotpi backup

# Explicit repository-relative paths
./dotpi backup agent/settings.json agent/models.json -y

./dotpi list
./dotpi restore 20260101T120000Z-ab12cd34 -y
./dotpi restore 20260101T120000Z-ab12cd34 agent/settings.json -y
./dotpi delete 20260101T120000Z-ab12cd34 -y
./dotpi prune -k 5 -y
./dotpi prune -o 30d -y
```

Backup and restore always show their paths and confirm before changing
anything. Restore makes a safety backup of existing destination paths first.
`prune` never runs implicitly and requires exactly one explicit retention rule.

## What gets copied

Tracked direct JSON files under `agent/` are copied literally except
`agent/auth.json`, including model-store and proxy JSON when present. This can
carry machine-specific state. Review it before installation.

Skill directories under `agent/skills/` install like extensions: safe mode
selects them (`-S`/`-N` or the interactive menu), cherry-pick copies exactly
the listed ones, and clean mode copies the whole `agent/skills/` tree unless
`-N`. A skill directory must contain a `SKILL.md`; Pi handles frontmatter
validation at load time.

The installer reads extension sources from `packages/*` (any workspace
directory with a `package.json` and a `pi` manifest) and never copies
`node_modules` or lockfiles to the target. `doctor` warns if an installed
extension contains a leaked `node_modules`.

## Online installation from GitHub

### Recommended: download, review, run

Pin a commit or release, download the archive, inspect it, then run it:

```sh
ref=PINNED_COMMIT
curl -fsSL "https://github.com/yarabramasta/dotpi/archive/${ref}.tar.gz" -o /tmp/dotpi.tar.gz
rm -rf /tmp/dotpi-src
mkdir -p /tmp/dotpi-src
tar -xzf /tmp/dotpi.tar.gz -C /tmp/dotpi-src --strip-components=1
less /tmp/dotpi-src/README.md
less /tmp/dotpi-src/src/dotpi/cli.py
/tmp/dotpi-src/dotpi install --mode=safe --extension jina,wandb
```

Review `agent/` and pin a commit you trust. Do not paste real API keys into
commands or files.

### Optional one-shot install: pinned `curl | sh`

This is convenient, but it executes downloaded shell code. Use only with a
reviewed, immutable commit ref. One-shot safe install with Jina extension and
no skills:

```sh
ref=PINNED_COMMIT
curl -fsSL "https://raw.githubusercontent.com/yarabramasta/dotpi/${ref}/dotpi" | \
  DOTPI_REF="$ref" sh -s -- install --mode=safe --extension jina --no-skills --yes
```

One-shot clean install, with full target backup plus every extension and skill,
skips example auth:

```sh
ref=PINNED_COMMIT
curl -fsSL "https://raw.githubusercontent.com/yarabramasta/dotpi/${ref}/dotpi" | \
  DOTPI_REF="$ref" sh -s -- install --mode=clean --yes
```

Include example auth only when explicitly intended:

```sh
ref=PINNED_COMMIT
curl -fsSL "https://raw.githubusercontent.com/yarabramasta/dotpi/${ref}/dotpi" | \
  DOTPI_REF="$ref" sh -s -- install --mode=clean --include-auth --yes
```

The launcher downloads the same pinned archive into a temporary directory and
invokes its Python implementation. Branch URLs such as `main` can change and
are not recommended. `--yes` is required because piped input is
non-interactive. Never put real API keys in this command or repository.
