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
6. Tests: registry references, query across stores, show from referenced
   store, read-only enforcement.

## Acceptance criteria

- A repo can reference one or more external stores
- `specd_query(store="all")` returns items from the local store AND all
  referenced stores (annotated)
- `specd_show` finds items in referenced stores when not found locally
- Referenced stores are read-only from the referencing session
- Doctor stays clean for both the local store and referenced stores
- All existing tests still pass
