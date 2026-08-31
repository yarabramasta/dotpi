# dotpi

My Pi configuration, kept as code instead of hidden inside `~/.pi`.

This repository backs up, installs, and restores my Pi harness setup across machines. It carries Pi settings and models, W&B custom OpenAI-compatible provider configuration, Jina web-search tooling, and Android CLI tooling. It is not a generic Pi package manager: it is my reproducible dotfiles-style configuration with guardrails before anything touches `~/.pi`.

Repository root mirrors `~/.pi`. The installer previews changes, protects backups, asks before destructive work, and verifies each install with an isolated Pi smoke session.

## Quick start

```sh
git clone git@github.com:yarabramasta/dotpi.git
cd dotpi
./dotpi install --mode=safe
```

`./dotpi` is a shell launcher for `dotpi.py`. Python 3, Pi, and common macOS/Linux tools are required. Install runs offline checks, then one isolated Pi smoke session. Missing Pi or a failed smoke check rolls the install back.

Use a fixture instead of your real home while testing:

```sh
./dotpi install --mode=clean --target=/tmp/dotpi-fixture --yes
```

Check or refresh dotpi without touching your Pi target:

```sh
./dotpi doctor
./dotpi update --dry-run
```

## Install modes

### Safe

```sh
./dotpi install --mode=safe
./dotpi install --mode=safe --extension jina,wandb
./dotpi install --mode=safe --no-extensions
./dotpi install --mode=safe --extension jina,wandb --dry-run
```

Safe mode:

1. Inspects target.
2. Copies every direct `agent/*.json` except `auth.json`.
3. Shows all JSON differences.
4. Creates a protected backup of existing JSON.
5. Asks for one confirmation, or requires `--yes` when non-interactive.
6. Atomically writes JSON and copies selected extensions.
7. Validates files and runs isolated Pi smoke.

Existing selected extensions are refused. Use `--force` to overwrite them. Forced extension directories are not backed up and cannot be restored by dotpi if a later check fails. New extension files are removed and JSON is rolled back on failure.

Without `--extension`, interactive safe mode shows an extension menu. Non-interactive safe mode requires one or more extension filters unless `--no-extensions` is used. `--extension` and `--no-extensions` cannot be combined.

`--no-extensions` installs configuration only. Safe and cherry-pick modes leave target extensions untouched; clean mode excludes `agent/extensions` from replacement.

`--dry-run` previews JSON changes, backup scope, and extension actions without writing files, creating a backup, rebuilding dependencies, or launching Pi smoke. It does not require `--yes`.

### Clean

```sh
./dotpi install --mode=clean
./dotpi install --mode=clean --no-extensions
./dotpi install --mode=clean --dry-run
./dotpi install --mode=clean --yes
./dotpi install --mode=clean --include-auth --yes
```

Clean mode backs up the entire existing `.pi`, replaces it with this repository's `agent` tree, and copies every extension. It skips `auth.json` unless:

- interactive mode: you answer the auth prompt; or
- non-interactive mode: you pass `--include-auth`.

The full backup is used for clean-install rollback if copying, validation, or smoke fails.

### Cherry-pick

```sh
./dotpi install --mode=cherry-pick --extension android-cli --yes
./dotpi install --mode=cherry-pick --extension agent/extensions/jina --target=/tmp/pi --yes
```

Cherry-pick copies selected extension directories only. It never copies `auth.json`. Existing extensions require `--force`.

## Commands

All mutating commands prompt in a terminal. Non-interactive commands must pass `--yes` or stop before changing files.

```text
./dotpi install --mode=safe|clean|cherry-pick [options]
./dotpi doctor [--target PATH] [--json]
./dotpi update [--dry-run] [--yes]
./dotpi sync [--settings] [--models] [--apply] [--target PATH] [--yes]
./dotpi backup [paths...] [--target PATH] [--yes]
./dotpi restore BACKUP_ID [paths...] [--target PATH] [--yes]
./dotpi list [--target PATH]
./dotpi delete BACKUP_ID [--target PATH] [--yes]
./dotpi prune --keep N [--target PATH] [--yes]
./dotpi prune --older-than 30d [--target PATH] [--yes]
```

Useful install options:

- `--target PATH` — use target other than `~/.pi`.
- `--extension NAME[,NAME...]` — select extensions by name or path. Repeat it as needed.
- `--no-extensions` — install configuration without copying extensions; mutually exclusive with `--extension`.
- `--include-auth` — clean mode only; include example `auth.json`.
- `--force` — allow selected extension overwrite; not recoverable through extension backups.
- `--yes` — explicit approval for non-interactive operation.
- `--dry-run` — preview install without changing files or running validation.

## Doctor, update, and sync

`doctor` is a quick, read-only preflight. It checks target layout, direct JSON validity, and installed extension manifests/entrypoints. It never reads `agent/auth.json`, runs package managers, or launches Pi. Use `--json` for scripts.

`update` fast-forwards this local dotpi checkout from its configured Git upstream. It refuses dirty, detached, missing-upstream, or diverged states. It never changes `~/.pi`; use `--dry-run` to query upstream without changing Git metadata.

`sync` is separate and opt-in. First version reviews or applies existing `settings.json` and `models.json` only:

```sh
./dotpi sync --settings --dry-run
./dotpi sync --settings --models --dry-run
./dotpi sync --settings --apply --yes
```

Sync requires explicit file flags and defaults to review-only. Provider/default-provider or provider-object differences block apply. Sensitive values and provider URLs are redacted. Missing target files are not created. Apply creates a protected backup and rolls back all selected files on failure. Extension code syncing is deferred.

## Backups and restore

Backups live beside the target: `~/.pi-backups` for the default target. Each timestamped backup contains preserved relative paths, modes, metadata, a manifest, and SHA-256 checksums. Backup directories are owner-only (`0700`); `auth.json` is owner-only (`0600`).

```sh
# Default: direct target agent JSON except auth.json
./dotpi backup

# Explicit repository-relative paths
./dotpi backup agent/settings.json agent/models.json --yes

./dotpi list
./dotpi restore 20260101T120000Z-ab12cd34 --yes
./dotpi restore 20260101T120000Z-ab12cd34 agent/settings.json --yes
./dotpi delete 20260101T120000Z-ab12cd34 --yes
./dotpi prune --keep 5 --yes
./dotpi prune --older-than 30d --yes
```

Backup and restore always show their paths and confirm before changing anything. Restore makes a safety backup of existing destination paths first. `prune` never runs implicitly and requires exactly one explicit retention rule.

## What gets copied

Tracked direct JSON files under `agent/` are copied literally except `agent/auth.json`, including model-store and proxy JSON when present. This can carry machine-specific state. Review it before installation.

Extensions currently include:

- `android-cli`
- `jina`
- `wandb`

The W&B extension is folder-based at `agent/extensions/wandb/`, with `index.ts` and `package.json`. It adds a session-derived `cache_salt` only to W&B provider requests.

## API keys and auth

The tracked `agent/auth.json` is an example containing placeholders/environment references. Never commit real credentials.

Configure keys through environment variables before starting Pi:

```sh
export WANDB_API_KEY='...'
export WANDB_API_BASE_URL='...'
export JINA_API_KEY='...'
```

The W&B provider configuration uses `$WANDB_API_KEY` and `$WANDB_API_BASE_URL`. The Jina extension checks `JINA_API_KEY` first, then its configured `auth.json` value. Keep real keys in your shell environment or another local secret store. Review model and provider JSON before sharing this repository.

Get a Jina API key from the [Jina AI API dashboard](https://jina.ai/api-dashboard/): sign in, open **API Key & Billing**, create or copy a key, then export it before starting Pi:

```sh
export JINA_API_KEY='...'
```

Never commit the actual key. Rotate or revoke it from the same dashboard if exposed.

## Dependencies

Dotpi has no root package manifest or lockfile. After copying, dotpi checks the target for a package manifest, lockfile, and compatible package manager. It runs the declared manager when all are available; otherwise it warns and continues. Dependency rebuild failures are warnings. Pi availability and smoke failure are not warnings: they fail and roll back installation.

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
less /tmp/dotpi-src/dotpi.py
/tmp/dotpi-src/dotpi install --mode=safe --extension jina,wandb
```

Review `agent/` and pin a commit you trust. Do not paste real API keys into commands or files.

### Optional one-shot install: pinned `curl | sh`

This is convenient, but it executes downloaded shell code. Use only with a reviewed, immutable commit ref. One-shot safe install with Jina extension:

```sh
ref=PINNED_COMMIT
curl -fsSL "https://raw.githubusercontent.com/yarabramasta/dotpi/${ref}/dotpi" | \
  DOTPI_REF="$ref" sh -s -- install --mode=safe --extension jina --yes
```

One-shot clean install, with full target backup and every extension, skips example auth:

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

The launcher downloads the same pinned archive into a temporary directory and invokes its Python implementation. Branch URLs such as `main` can change and are not recommended. `--yes` is required because piped input is non-interactive. Never put real API keys in this command or repository.
