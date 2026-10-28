# Handoff — specd src/ restructure + integration testing

## Context

specd is a pi extension for spec-driven development at
`~/Development/dotpi/packages/specd/`. It's feature-complete and
live-verified: event-sourced store, code-enforced gates, github-only sink,
execution seam, layer taxonomy, stage re-entries, naming conventions,
multi-repo references (D11), WAL event log. 153 tests (151 pass, 2 skipped)
across 22 files. All synced to the installed extension.

**Everything below is committed.** Latest commits:
- `33767ab` chore: remove D11 Phase 5 handoff (implemented)
- `ef6ed8a` feat(specd): D11 Phase 5 — multi-repo store references + WAL event log
- `d0f4776` feat(specd): D11 Phase 3 — bootstrap picker
- `0914e08` feat(specd): D11 Phases 2+6 — external store + review improvements
- `dd51c0e` feat(specd): D11 Phase 1 — store registry + path resolution
- `7a4ab60` docs(specd): README + docs
- `173b106` docs(specd): agent guide

## The task: src/ restructure (REQUIRED)

Restructure `packages/specd/` from the current flat layout to a `src/`
directory with proper separation of concerns. The previous worker attempt
timed out because it tried to understand everything before acting — DO NOT
repeat that. Work incrementally: move one directory, update imports,
verify with tsc, then move to the next.

### Current structure (flat)

```
packages/specd/
├── backends/{config,contract,gh,github,null,onboarding,resolve,sync}.ts
├── import/{grill-source,map,run}.ts
├── pipeline/{consistency,gates,schedule}.ts
├── store/{doctor,external,migrate,registry,schema,storage,store}.ts
├── commands.ts (431 lines) — all commands + prompts inline
├── tools.ts (943 lines) — all 18 tool registrations inline
├── dashboard.ts, naming.ts, query.ts, report.ts, index.ts
├── test/ (22 test files)
├── package.json (pi.extensions: "index.ts")
└── tsconfig.json
```

### Target structure

```
packages/specd/
├── src/
│   ├── index.ts                    (entry: registers tools + commands)
│   ├── store/
│   │   ├── index.ts                (re-exports)
│   │   ├── schema.ts, store.ts, registry.ts, external.ts,
│   │   ├── storage.ts, doctor.ts, migrate.ts
│   │   └── projection.ts           (extract from store.ts)
│   ├── pipeline/
│   │   ├── gates.ts, consistency.ts, schedule.ts
│   ├── sinks/
│   │   ├── contract.ts, resolve.ts, sync.ts, onboarding.ts, config.ts
│   │   ├── null.ts
│   │   └── github/{adapter.ts, runner.ts}
│   ├── tools/
│   │   ├── index.ts                (thin dispatcher)
│   │   ├── store-tools.ts          (dashboard, create, append, show, query, remove_link, promote)
│   │   ├── pipeline-tools.ts       (consistency, schedule)
│   │   ├── sink-tools.ts           (configure_sink)
│   │   └── exec-tools.ts           (create_worktree, export, import_*)
│   ├── commands/
│   │   ├── index.ts                (registerCommands — thin)
│   │   └── prompts.ts              (ALL prompt constants moved here)
│   ├── import/{source.ts, map.ts, run.ts}
│   ├── naming.ts, query.ts
│   └── report.ts                   (merge dashboard.ts into this)
├── test/                           (stays, update import paths)
├── package.json                    (pi.extensions → "src/index.ts")
└── tsconfig.json
```

### The approach (incremental — do NOT try to understand everything first)

**Step 1**: Create `src/` and `git mv` the store directory:
```bash
mkdir -p src/store
git mv store/schema.ts src/store/schema.ts
git mv store/store.ts src/store/store.ts
# ... etc for each file
```
Update imports in the moved files and in files that reference them.
Run `npx tsc --noEmit` to verify.

**Step 2**: Move `pipeline/` → `src/pipeline/`. Same process.

**Step 3**: Move `backends/` → `src/sinks/` (rename github.ts → github/adapter.ts,
gh.ts → github/runner.ts). Same process.

**Step 4**: Move `import/` → `src/import/`. Same process.

**Step 5**: Move standalone files (naming.ts, query.ts, report.ts) → `src/`.
Merge `dashboard.ts` into `report.ts`. Delete dashboard.ts.

**Step 6**: Split `tools.ts` (943 lines) into domain files under `src/tools/`:
- `store-tools.ts`: dashboard, create_item, append_event, show, query, remove_link, promote
- `pipeline-tools.ts`: consistency, schedule
- `sink-tools.ts`: configure_sink, store_status, register_store, add_reference
- `exec-tools.ts`: create_worktree, export, import_preview, import_apply, import_revert
- `index.ts`: thin dispatcher that imports and calls each domain's register function

**Step 7**: Split `commands.ts` (431 lines) into:
- `src/commands/prompts.ts`: ALL prompt template constants (START_PROMPT, RUN_PROMPT, etc.)
- `src/commands/index.ts`: the command registration + handlers

**Step 8**: Create `src/index.ts` as the entry point. Update the root
`index.ts` to re-export from `./src/index.js`. Update `package.json`
`pi.extensions` to `"src/index.ts"`.

**Step 9**: Update ALL test import paths in `test/` (the relative paths change).

**Step 10**: Full verification:
```bash
npx tsc --noEmit          # from packages/specd/
npx vitest run            # from packages/specd/ — ALL 130+ tests must pass
npm run check             # from the repo root — biome + tsc clean
```

### Rules

- Use `git mv` (preserves history)
- TypeScript ESM, tabs + double quotes (biome), `.js` import suffixes
- Do NOT change any logic — pure structural refactor
- Verify with tsc after EACH step, not just at the end
- If a step breaks, fix it before moving to the next

## After the restructure

1. Update `AGENTS.md` (already references specd — verify the structure description)
2. Verify `README.md` (already simplified)
3. Sync: `./dotpi install -e specd -N -f -y` from the repo root
4. Integration testing on the lingua-lair repos — these are related
   multi-repo projects (backend + mobile clients), making them the ideal
   playground for the D11 multi-repo store references. Use dummy product
   scenarios (NOT the actual lingua-lair product):

   Setup: create ONE shared external store (external-git) that all four
   repos reference. Each repo's specd session reads the shared knowledge
   (constitution, domain items, cross-cutting specs) while owning its own
   implementation-specific tasks.

   - lingua-lair-core: "Add a CLI config validator" (exercises the
     execution seam on a real codebase)
   - lingua-lair-android: "Add a settings persistence layer" (exercises
     the store picker on an existing project — this repo has real code)
   - lingua-lair-ios: "Add a local notification scheduler" (same pipeline,
     different stack — proves specd is stack-agnostic)
   - lingua-lair-flutter: "Add an offline-first data sync" (exercises
     the multi-repo reference: this repo queries the shared store for
     the domain knowledge captured during the core repo's cycle)

   The multi-repo reference test is the KEY scenario: run /spec start in
   lingua-lair-flutter, register the shared store as a reference, then
   specd_query(store="all") should return items from both the local store
   and the shared knowledge store. The agent should be able to read the
   constitution and domain knowledge from the shared store while creating
   flutter-specific tasks locally.

## Key patterns

- Store: event-sourced SQLite, append-only events, projections by replay
- WAL: every appendEvent also writes to events.jsonl (committed, text);
  store.db is gitignored (rebuilt by replay on fresh clone)
- Gates: code-enforced (the store refuses illegal transitions)
- Naming: conventional commits (naming.ts: branchName, ccTitle, scopeOf)
- Registry: ~/.pi/agent/specd-stores.json maps repos → store locations
- The contract test bans vendor names in vocabularies
