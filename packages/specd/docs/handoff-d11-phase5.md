# Handoff — D11 Phase 5: Multi-repo store references

## Context

specd is a pi extension for spec-driven development. It has an event-sourced
SQLite store (`.spec/store.db`), code-enforced gates, and a github-only sink.
Phases 1–4 of D11 (worksets) are implemented:

- **Store registry** (`store/registry.ts`): maps repo paths → store locations
  at `~/.pi/agent/specd-stores.json`. `openStore(cwd)` checks the registry
  first via `resolveStoreDir(cwd)`, then falls back to `{cwd}/.spec/`.
- **External store creation** (`store/external.ts`): `createExternalStore` +
  `ensureExternalStore` — creates the store dir as a standalone git repo with
  a `.specd-store.yaml` marker.
- **Bootstrap picker** (`tools.ts`): `specd_store_status` + `specd_register_store`
  tools. The START_PROMPT step 0 asks the user where the store should live.
- **Connect flow**: covered by `specd_register_store` + bash git clone.

## What Phase 5 needs to implement

**Multi-repo references**: one shared knowledge store (constitution, product/
domain knowledge, cross-cutting specs) read by multiple code repos.

The scenario: the lingua-lair project has lingua-lair-core, lingua-lair-android,
lingua-lair-ios, lingua-lair-flutter — all implementing the same product.
One store holds the shared knowledge (constitution, domain items, behavior
specs). Each code repo references that store so its specd session can query
the shared knowledge alongside its own local items.

### The design

1. **Registry extension**: a repo's registry entry gains a `references` array
   pointing to other stores:
   ```json
   {
     "/path/to/lingua-lair-core": {
       "type": "external-git",
       "storePath": "~/.pi/agent/stores/lingua-lair-core",
       "references": ["~/.pi/agent/stores/lingua-lair-specd"]
     }
   }
   ```
   The referenced store is READ-ONLY from the referencing repo's perspective.

2. **`specd_query` extension**: add a `store` parameter. When `store` is
   "all", query the local store AND all referenced stores. When `store` is
   a specific path, query only that store. Default: local only.

3. **`specd_show` extension**: when an item id is not found locally, search
   the referenced stores. Return the item with a `(from: {store-path})`
   annotation.

4. **A `specd_add_reference` tool**: adds a reference to another store
   (path or git URL). Clones if needed, registers the reference.

5. **The dashboard** can optionally show referenced-store items (marked
   with a 📎 prefix or similar).

### What NOT to do

- Do NOT merge items from referenced stores into the local store — they
  stay separate.
- Do NOT allow writes to referenced stores from a referencing session —
  read-only.
- Do NOT create circular references.

### The events.jsonl companion (critical context)

Every `appendEvent` also appends the event as a JSON line to
`events.jsonl` (same directory as store.db). This is the write-ahead-log
pattern:

- `events.jsonl` = the source of truth (text, mergeable, committed to git)
- `store.db` = the derived projection (binary, gitignored, rebuilt by replay)

`openStore` checks: if `store.db` is missing but `events.jsonl` exists,
replay the events to rebuild the store. This means the event history
survives a Mac wipe + fresh clone (the JSONL travels with the repo or
the store's own git repo).

**For the "senior won't allow it" scenario**: the store lives as an
external git repo. The `events.jsonl` is committed to the STORE repo,
not the code repo. The code repo stays completely clean (zero footprint).
After a Mac wipe: clone the code repo, clone the store repo (you need
to know its URL), register, and the store is rebuilt from events.

### The storage scenarios (context for design decisions)

| Scenario | Store location | events.jsonl | Code repo |
|---|---|---|---|
| Fresh project, solo | In-repo (`.spec/`) | Committed to the code repo | Clean GitHub (store.db gitignored) |
| Existing, has permission | In-repo (`.spec/`) | Committed or gitignored | Same |
| Senior says no | External git repo | Committed to the store repo | Zero footprint |
| Multi-repo product | One shared external git repo | Committed to the store repo | All code repos clean |

Phase 5 references MUST respect this: the referenced store has its own
events.jsonl and its own git history. The referencing repo reads from it
but never writes to it.

### The boundary

The referencing repo sees:
- Its own items: full access (create, append, export, execute)
- Referenced stores' items: read-only (query, show, dashboard display)

## Current codebase state

- **Location**: `~/Development/dotpi/packages/specd/`
- **Tests**: 130 total (128 pass, 2 skipped)
- **Key files**:
  - `store/registry.ts` — the registry (readRegistry, writeRegistry,
    registerStore, lookupStore, resolveStoreDir)
  - `store/store.ts` — openStore (uses resolveStoreDir), createItem,
    appendEvent, projectItem, doctor
  - `store/external.ts` — createExternalStore, ensureExternalStore
  - `query.ts` — queryItems, insightLine, renderInsight
  - `tools.ts` — all 18 tool registrations
  - `commands.ts` — all command registrations + prompts
- **Patterns**: TypeScript ESM, tabs + double quotes (biome), `.js` import
  suffixes, pure modules + thin tool registration, code-enforced gates
- **Run checks**: `npx tsc --noEmit` from packages/specd/,
  `npx vitest run` from packages/specd/, `npm run check` from repo root
- **Sync**: `./dotpi install -e specd -N -f -y` from repo root

## Implementation steps

1. Extend `store/registry.ts`: add `references?: string[]` to
   `StoreRegistryEntry`. Add `resolveReferenceStores(repoPath): string[]`
   that returns the referenced store paths.
2. Extend `query.ts`: `queryItems` accepts a `stores: SpecdStore[]` param.
   When multiple stores are provided, query all and annotate results with
   their source. `renderInsight` shows the source for referenced items.
3. Add `specd_add_reference` tool in `tools.ts`: takes a store path or git
   URL. Clones if needed (bash git clone), registers the reference in the
   registry.
4. Extend `specd_store_status` to show references.
5. Extend `specd_show`: if the item is not found locally, search referenced
   stores (read-only).
6. Events.jsonl awareness: when reading from a referenced store, its
   events.jsonl is the source (the store.db may or may not exist — replay
   if needed). Do NOT write to the referenced store's events.jsonl.
7. Tests: registry references, query across stores, show from referenced
   store, read-only enforcement.

## Acceptance criteria

- A repo can reference one or more external stores
- `specd_query(store="all")` returns items from the local store AND all
  referenced stores (annotated)
- `specd_show` finds items in referenced stores when not found locally
- Referenced stores are read-only from the referencing session
- Doctor stays clean for both the local store and referenced stores
- All existing tests still pass
