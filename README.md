# dotpi

My Pi configuration, kept as code instead of hidden inside `~/.pi`. Backs up,
installs, and restores my Pi harness setup across machines. Not a generic Pi
package manager — a reproducible dotfiles-style setup with guardrails: the
installer previews changes, protects backups, asks before destructive work,
and verifies each install with an isolated Pi smoke session.

## Quick start

```sh
git clone git@github.com:yarabramasta/dotpi.git
cd dotpi
./dotpi install          # safe mode: diff, backup, confirm, smoke check
```

Requires Python 3, Pi, and common macOS/Linux tools. `./dotpi` is a shell
launcher for the `src/dotpi` Python package (`python3 -m dotpi`). Missing Pi
or a failed smoke check rolls the install back.

Test against a fixture instead of your real home:

```sh
./dotpi install -m clean -t /tmp/dotpi-fixture -y
```

## Commands

All mutating commands prompt in a terminal; non-interactive use requires `-y`.
Full flag reference, install modes, and online-install recipes:
[src/dotpi/README.md](src/dotpi/README.md).

```text
./dotpi install     # modes: safe (default) | clean | cherry-pick
./dotpi doctor      # read-only target preflight
./dotpi update      # fast-forward this checkout from Git upstream
./dotpi sync        # review/apply settings.json + models.json (opt-in)
./dotpi backup | list | restore | delete | prune   # backup management
```

Extensions are selectable (`-e`/`-n`); without filters,
interactive mode shows menus. Extensions: `specd`, `grill`, `jina`,
`android-cli`, `wandb` — see each package's README for what it does.

## What gets installed

`agent/` mirrors `~/.pi/agent` and is the installer's source of truth. Tracked
files under `agent/` are mirrored by `./dotpi install` (clean mode copies the
whole tree; safe mode copies JSON files and skips `auth.json`); `./dotpi sync
-s -M` updates only `settings.json` and `models.json` in place. Agents live
under `agent/agents/` and are discovered by Pi from `~/.pi/agent/agents` after
install. Extensions come from `packages/*`. Tracked JSON can carry
machine-specific state — review before installing.

## API keys and auth

Tracked `agent/auth.json` is an example with placeholders/environment
references; never commit real credentials. Configure keys through environment
variables before starting Pi:

```sh
export WANDB_API_KEY='...' WANDB_API_BASE_URL='...' JINA_API_KEY='...'
```

Keep real keys in your shell environment or another local secret store. Get a
Jina key from the [Jina AI API dashboard](https://jina.ai/api-dashboard/).

## Repository layout

```text
packages/               extensions (pnpm workspace; real sources)
  specd/                Spec-driven development extension (pi-specd)
  grill/                Socratic planning extension (pi-grill)
  jina/                 Jina web tools (pi-jina-web)
  android-cli/          Android tooling extension (pi-android-cli)
  wandb/                W&B custom provider extension (pi-wandb-inference)
agent/                  mirrors ~/.pi/agent (installer source)
  settings.json models.json auth.json
.agents/skills/         vendored agent skills (karpathy-guidelines, write-good-docs, flatten-fake-layers)
dotpi                   POSIX sh bootstrap for the Python CLI
src/dotpi               installer/backup/sync CLI (Python)
```

`.agents/skills/` carries vendored agent skills — pi discovers project
`.agents/skills/` natively (no wiring needed). Install more with
`npx skills add <repo> --skill <name>`; sources are tracked so fresh clones
get the same skill set.

Workspace wiring: `pnpm-workspace.yaml` globs `packages/*`; root
`devDependencies` pin the toolchain exactly while extension packages declare
them as `peerDependencies: "*"`. The repo root `package.json` also carries a
`pi` manifest, so the whole repository installs as a pi package:

```sh
pi install git:github.com/yarabramasta/dotpi@v1   # pin a ref
```

## Development workflow

This repo uses `specd` for its own planning and execution. `grill`,
`jina`, `android-cli`, and `wandb` are installable Pi extensions under
`packages/`, just like `specd`.

## Dev workflow

```sh
corepack pnpm install        # one-time
pnpm run check               # biome lint + tsc --noEmit
pnpm test                    # vitest across packages
pnpm run format              # biome autofix
python3 -m unittest discover -s src -t src   # dotpi CLI tests
./dotpi doctor               # target preflight
```

## Install from GitHub (one-shot)

```sh
ref=PINNED_COMMIT   # review the ref first; never pipe unreviewed shell
curl -fsSL "https://raw.githubusercontent.com/yarabramasta/dotpi/${ref}/dotpi" | \
  DOTPI_REF="$ref" sh -s -- install --mode=safe --extension jina --yes
```

`--yes` is required because piped input is non-interactive. The safer
download-review-run recipe and all mode/flag details:
[src/dotpi/README.md](src/dotpi/README.md).
