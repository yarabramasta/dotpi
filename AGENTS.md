# AGENTS.md — dotpi

Pi loads this file at startup. Keep it lean; details live in README.md and code.

## What this repo is

My Pi configuration kept as code, mirroring `~/.pi`. It is not a generic package
manager — it is a reproducible dotfiles-style setup with guardrails. Two halves:

- `src/dotpi/` — Python installer/manager (`./dotpi` shell launcher → `python3 -m dotpi`)
- `packages/` — TypeScript Pi extensions: `specd`, `grill`, `jina`, `android-cli`
- `.agents/skills/` — vendored agent skills (`karpathy-guidelines`, `write-good-docs`, `flatten-fake-layers`); pi discovers project `.agents/skills/` natively

`agent/` holds the mirrored Pi config (`settings.json`, `models.json`, example
`auth.json`). Each package's own `package.json` declares its entry via
`pi.extensions: ["src/index.ts"]`; the root manifest mirrors that glob.

## Commands

```sh
npm run check        # biome check + tsc --noEmit (run before finishing TS work)
npm test             # vitest, covers packages/**/*.test.ts
npm run format       # biome write
python3 -m unittest discover -s src -t src   # Python suite
```

The workspace is pnpm (`pnpm-workspace.yaml`); the scripts are runner-agnostic
— `pnpm run check` etc. work identically.

Run a single extension's tests from its directory, e.g. `cd packages/grill && npx vitest run`.

## Working on extensions

- TypeScript ESM. Biome enforces tabs + double quotes; run `npm run check`, not your own taste.
- Each package follows the same layout: `src/` for sources, `test/` for vitest
  suites; `src/index.ts` exports `default function <name>Extension(pi: ExtensionAPI)`, plus a `package.json` manifest with `pi.extensions: ["src/index.ts"]`.
- Import sibling modules with explicit `.js` suffixes (`./state.js`), never `.ts`.
- Extension pattern used across packages: keep logic in pure modules (reducers,
  routers, composition functions) with unit tests; keep `src/index.ts`/command
  registration thin. See `packages/grill` (`src/picker-state.ts` reducer + `test/`) for the model. See `packages/specd/` for the store + gates + pipeline pattern (event-sourced, code-enforced).
- UI feedback loop: edit → `/reload` inside a running Pi session → try it. Tests
  first for pure logic; the TUI surface (`pi-tui` overlays, status line) is
  smoke-tested by hand in the reload loop.

## Working on the installer

`src/dotpi` is the mutating side. Its tests use a fixture home — never point a
test or a run at the real `~/.pi` unless explicitly asked. Mutating commands
require `-y` non-interactively by design; do not loosen those guardrails.

## Hard rules

- Never write to `~/.pi` directly. Everything goes through `./dotpi install|sync|backup|restore`.
- `agent/auth.json` is an example with placeholders/env references. Real keys
  stay in the shell environment (`WANDB_API_KEY`, `JINA_API_KEY`, …). Never
  commit or print real credentials.
- `git status -sb` before committing; the repo is mirrored into `~/.pi`, so
  only commit what you mean to install later.
