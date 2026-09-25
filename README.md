# dotpi

My Pi configuration, kept as code instead of hidden inside `~/.pi`.

This repository backs up, installs, and restores my Pi harness setup across machines. It carries Pi settings and models, W&B custom OpenAI-compatible provider configuration, Jina web-search tooling, and Android CLI tooling. It is not a generic Pi package manager: it is my reproducible dotfiles-style configuration with guardrails before anything touches `~/.pi`.

Repository root mirrors `~/.pi`. The installer previews changes, protects backups, asks before destructive work, and verifies each install with an isolated Pi smoke session.

## Quick start

```sh
git clone git@github.com:yarabramasta/dotpi.git
cd dotpi
./dotpi install
```

`./dotpi` is a shell launcher for the `src/dotpi` Python package (`python3 -m dotpi`). Python 3, Pi, and common macOS/Linux tools are required. Install runs offline checks, then one isolated Pi smoke session. Missing Pi or a failed smoke check rolls the install back. `install` defaults to safe mode; pass `-m clean` or `-m cherry-pick` for the destructive or selective modes.

Use a fixture instead of your real home while testing:

```sh
./dotpi install -m clean -t /tmp/dotpi-fixture -y
```

Run the Python test suite:

```sh
python3 -m unittest discover -s src -t src
```

Check or refresh dotpi without touching your Pi target:

```sh
./dotpi doctor
./dotpi update -d
```

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

Existing selected extensions are refused. Use `--force` (`-f`) to overwrite them. Forced extension directories are not backed up and cannot be restored by dotpi if a later check fails. New extension files are removed and JSON is rolled back on failure.

Without `-e`, interactive safe mode shows an extension menu. Non-interactive safe mode requires one or more extension filters unless `-n` is used. `-e` and `-n` cannot be combined.

Skills follow the same selection rules as extensions: without `-S`, interactive safe mode shows a skill menu after the extension menu; non-interactive safe mode requires `-S` filters unless `-N` is used. `-S` and `-N` cannot be combined, but `-e`/`-n` and `-S`/`-N` are independent groups.

`-n` (`--no-extensions`) installs configuration only. Safe and cherry-pick modes leave target extensions untouched; clean mode skips extension copying.

`-d` (`--dry-run`) previews JSON changes, backup scope, and extension actions without writing files, creating a backup, rebuilding dependencies, or launching Pi smoke. It does not require `-y`.

### Clean

```sh
./dotpi install -m clean
./dotpi install -m clean -n
./dotpi install -m clean -N
./dotpi install -m clean -d
./dotpi install -m clean -y
./dotpi install -m clean -a -y
```

Clean mode backs up the entire existing `.pi`, replaces it with this repository's `agent` tree, and copies every extension from `packages/` and every skill. `-n` skips extensions and `-N` skips `agent/skills`. It skips `auth.json` unless:

- interactive mode: you answer the auth prompt; or
- non-interactive mode: you pass `--include-auth` (`-a`).

The full backup is used for clean-install rollback if copying, validation, or smoke fails.

### Cherry-pick

```sh
./dotpi install -m cherry-pick -e android-cli -y
./dotpi install -m cherry-pick -e jina -t /tmp/pi -y
./dotpi install -m cherry-pick -S python-inline-scripts -y
```

Cherry-pick copies selected extension and skill directories only, and requires at least one filter: `-e`, `-S`, or both. It never copies `auth.json`. Existing selections require `--force` (`-f`).

## Commands

All mutating commands prompt in a terminal. Non-interactive commands must pass `--yes` (`-y`) or stop before changing files.

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

Every flag has a short and a long form; both are accepted everywhere and the examples above use the short form.

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

Note: `-d` means dry-run here, not the GNU `-n` convention — `-n` is reserved for `--no-extensions`. The online-install one-shot examples below keep long forms for copy-paste clarity.

## Doctor, update, and sync

`doctor` is a quick, read-only preflight. It checks target layout, direct JSON validity, installed extension manifests/entrypoints, and installed skill `SKILL.md` files. It never reads `agent/auth.json`, runs package managers, or launches Pi. Use `-j` (`--json`) for scripts.

`update` fast-forwards this local dotpi checkout from its configured Git upstream. It refuses dirty, detached, missing-upstream, or diverged states. It never changes `~/.pi`; use `-d` (`--dry-run`) to query upstream without changing Git metadata.

`sync` is separate and opt-in. First version reviews or applies existing `settings.json` and `models.json` only:

```sh
./dotpi sync -s -d
./dotpi sync -s -M -d
./dotpi sync -s -A -y
```

Sync requires explicit file flags and defaults to review-only. Provider/default-provider or provider-object differences block apply. Sensitive values and provider URLs are redacted. Missing target files are not created. Apply creates a protected backup and rolls back all selected files on failure. Extension code syncing is deferred.

## Backups and restore

Backups live beside the target: `~/.pi-backups` for the default target. Each timestamped backup contains preserved relative paths, modes, metadata, a manifest, and SHA-256 checksums. Backup directories are owner-only (`0700`); `auth.json` is owner-only (`0600`).

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

Backup and restore always show their paths and confirm before changing anything. Restore makes a safety backup of existing destination paths first. `prune` never runs implicitly and requires exactly one explicit retention rule.

## What gets copied

Tracked direct JSON files under `agent/` are copied literally except `agent/auth.json`, including model-store and proxy JSON when present. This can carry machine-specific state. Review it before installation.

Skill directories under `agent/skills/` install like extensions: safe mode selects them (`-S`/`-N` or the interactive menu), cherry-pick copies exactly the listed ones, and clean mode copies the whole `agent/skills/` tree unless `-N`. A skill directory must contain a `SKILL.md`; Pi handles frontmatter validation at load time.

Extensions currently include:

- `android-cli`
- `grill`
- `jina`
- `wandb`

The `jina` extension registers the usual promoted tools plus a set of unpromoted convention-name aliases — `web_search`, `fetch_content`, `get_search_content`, and `source_check` — backed by the same Jina endpoints (search, reader, and a naive textual claim check). These aliases are callable by built-in pi-subagents such as `researcher` and `evidence-auditor` whose definitions strict-allowlist those convention names, without needing per-agent overrides. They are intentionally hidden from the default system-prompt tool prose; this setup assumes `pi-web-access` is not installed. If `pi-web-access` were ever added, Pi's silent first-registration-wins behavior means load order would decide which provider each name resolves to. The aliases deliberately do not implement deep search, LLM-backed source verification, or collision handling.

The `grill` extension adds a Socratic planning mode to Pi:

```text
/grill <topic>
/grill stop
/grill status
/grill checkpoint [edit|chat]
/grill intent auto|plan|learn|research|content|decide
/grill output <outputs>
/grill research off|ask|auto
/grill subagents on|off
```

Grill Me maintains a shared-understanding checkpoint, presents structured answer choices, and can use Cymbal or installed read-only scouts for grounding. It keeps interview mode read-only until you explicitly select and approve output production. The answer picker overlay has a Question tab (the choices) plus read-only Checkpoint, Grounding, and Review tabs — switch with Tab/←→ and scroll overflowed tab content with ↑/↓; the edge arrows (`↑` `↕` `↓`) mark remaining overflow. While the startup repo dossier is captured (Cymbal structure + git), the status line shows `🔥 grill · warming up…` so the quiet startup gap is visible instead of looking dead. When the subagent integration is on (default, `/grill subagents on|off`), an end-of-process reviewer pass runs after approved outputs are produced: `grill_run_reviewer` spawns one read-only reviewer through the pi-subagents RPC to verify the session stayed in sync — checkpoint decisions vs produced outputs vs edited files — and returns PASS or a gap list. Gaps are fixed and the pass reruns once; the two-round cap is hard. If no eligible reviewer exists or the run fails, the pass is skipped and the output phase finishes without it.

In the output phase, Grill Me can delegate approved file writes to a write-capable subagent. After you approve outputs, if write-capable subagents are discovered (via `grill_set_writers`), a picker asks whether to delegate file writes to a writer subagent or have the parent write directly. Delegation is per output batch — there is no persistent toggle. When delegating, the parent is blocked from `edit`/`write` and spawns the writer with `subagent({ agent, output, task })`, scoped to the approved output paths; the parent keeps CLI mutations (e.g. `gh issue create`, `git`) for non-file outputs. The reviewer pass runs after the writer (or after direct parent writes). If no write-capable subagent exists or the writer fails, the parent falls back to writing directly. `/checkpoint` is an alias for the current Grill Me checkpoint. Install it independently with `--extension grill`.

The W&B extension lives at `packages/wandb/`, with `index.ts` and a `package.json` manifest. It adds a session-derived `cache_salt` only to W&B provider requests.

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

## Repository layout

Extension and skill sources are managed as a pnpm workspace; the `agent/` tree mirrors `~/.pi/agent` and stays the installer's source of truth:

```text
packages/               workspace packages (real sources)
  grill/                Socratic planning extension (pi-grill)
  jina/                 Jina web tools (pi-jina-web)
  wandb/                W&B provider extension (pi-wandb-inference)
  android-cli/          Android tooling extension (pi-android-cli)
agent/                  mirrors ~/.pi/agent (installer source)
  skills/               skills (installed by dotpi)
  settings.json models.json auth.json
dotpi                   POSIX sh bootstrap for the Python CLI
src/dotpi               installer/backup/sync CLI (Python)
```

Workspace wiring: `pnpm-workspace.yaml` globs `packages/*`; root `devDependencies` pin the toolchain exactly (biome, TypeScript, pi-* type packages, typebox, vitest) while extension packages declare them as `peerDependencies: "*"` — the pattern the pi package docs mandate for bundled core packages. `tsc --noEmit` (strict) and `vitest` run against the whole workspace. The repo root `package.json` also carries a `pi` manifest, so the whole repository is installable as a pi package:

```sh
pi install git:github.com/yarabramasta/dotpi@v1
```

That clones the repo, installs its dependencies, and loads every extension and skill through the manifest — no npm registry or PAT required. Pin a ref; `pi update --extensions` reconciles the clone to it.

The `dotpi` installer reads extension sources from `packages/*` (any workspace directory with a `package.json` and a `pi` manifest) and never copies `node_modules` or lockfiles to the target. `doctor` warns if an installed extension contains a leaked `node_modules`.

## Dev workflow

```sh
corepack pnpm install        # one-time (pnpm via corepack)
pnpm run check               # biome lint + tsc --noEmit
pnpm test                    # vitest across packages
pnpm run format              # biome autofix
python3 -m unittest discover -s src -t src   # dotpi CLI tests
./dotpi doctor               # target preflight
```

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

Review `agent/` and pin a commit you trust. Do not paste real API keys into commands or files.

### Optional one-shot install: pinned `curl | sh`

This is convenient, but it executes downloaded shell code. Use only with a reviewed, immutable commit ref. One-shot safe install with Jina extension and no skills:

```sh
ref=PINNED_COMMIT
curl -fsSL "https://raw.githubusercontent.com/yarabramasta/dotpi/${ref}/dotpi" | \
  DOTPI_REF="$ref" sh -s -- install --mode=safe --extension jina --no-skills --yes
```

One-shot clean install, with full target backup plus every extension and skill, skips example auth:

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
