# Store placement and migration

**Type:** How-to (decision guide + runbook)  
**Audience:** Operators choosing where specd keeps state, and maintainers migrating existing repos to an external store  
**Scope:** Store placement modes, per-mode file map, migration from in-repo `.spec/` to an external store, and verification

## Supported placement modes

Three modes are supported. The event-sourced store is the source of truth in every mode.

| Mode | Where the store lives | Registration |
|---|---|---|
| `in-repo` | `<repo>/.spec/` | Not required; used as fallback when no registry entry exists |
| `external` | `~/.pi/agent/stores/<repo-name>/` or any absolute path | `{ type: "external", storePath: "<abs>" }` in `~/.pi/agent/specd-stores.json` |
| `external-git` | Same as `external`, with a git remote | `{ type: "external-git", storePath: "<abs>", remote: "<url>" }` in the registry |

`external` is the recommended default for new repos. `in-repo` is supported but machine-local.

## Decision guide

| Situation | Recommended mode | Why |
|---|---|---|
| New repo, personal/solo | `external` | Zero specd files in the repo; no `.gitignore` noise |
| New repo, team sharing | `external-git` | The store is its own git repo you can push or clone |
| Existing repo with committed `.spec/` | Migrate to `external` or `external-git` | In-repo stores are now machine-local; tracked `events.jsonl` is obsolete |
| Constraint forces store inside repo | `in-repo` | `.spec/.gitignore` ignores everything except itself |

## Per-mode file map

### In-repo store

Path: `<repo>/.spec/`

| File | Purpose | In git? |
|---|---|---|
| `.gitignore` | `*` `!.gitignore` | **Yes** — the only tracked file specd may leave in the repo |
| `events.jsonl` | Event-sourced WAL | No (gitignored) |
| `store.db` | SQLite projection | No (gitignored) |
| `store.db-wal`, `store.db-shm` | SQLite transient files | No (gitignored) |

No store file — including `events.jsonl` — is tracked in the repo. The old practice of committing `events.jsonl` or using "chore: sync specd events db manifest" commits is obsolete for in-repo stores.

### External / external-git store

Path: `~/.pi/agent/stores/<repo-name>/` (recommended) or any absolute path.

```text
~/.pi/agent/stores/<repo-name>/
├── .specd-store.yaml  (marker)
├── .gitignore         (* / !.gitignore / !events.jsonl)
├── events.jsonl       (tracked in the external store's own git repo; external-git adds a remote)
└── store.db           (gitignored, rebuilt from events)
```

The code repo itself has **zero** specd files in `external` and `external-git` modes.

### Registry

The machine-local registry maps repo paths to store locations:

```text
~/.pi/agent/specd-stores.json
```

If `$PI_CODING_AGENT_DIR` is set, the registry is at `$PI_CODING_AGENT_DIR/specd-stores.json` instead. The registry is never committed.

### Worktree awareness

Store resolution maps any linked git worktree back to its main repository before looking up the registry. A `/spec run` worktree and the main checkout share one store regardless of mode.

## Migration runbook: in-repo `.spec/` → external

Use this procedure for dotpi, lingua-lair, stoa, or any repo with an existing in-repo store.

### Preconditions

- Run from the repo's main checkout (not a `/spec run` worktree).
- `<repo>/.spec/events.jsonl` exists.
- The target directory does not already hold a specd store.

### Steps

1. Choose a target path. The recommended convention is:

   ```sh
   ~/.pi/agent/stores/<repo-name>
   ```

2. Migrate:

   ```sh
   specd_store(action="migrate", storePath="/Users/<you>/.pi/agent/stores/<repo-name>")
   ```

   What it does:

   - Creates the external store directory, `.specd-store.yaml` marker, and a local git repo.
   - Replays the source `.spec/events.jsonl` into a fresh `store.db`.
   - Copies the `links` table — links are not event-sourced, so replay alone cannot restore them.
   - Verifies item/event/link counts and projected statuses match the source before any destructive step.
   - Commits the migrated `events.jsonl` in the external store's own git repo **before** flipping the registry.
   - Flips the registry entry to `{ type: "external", storePath: "<abs>" }`.
   - Removes the in-repo `.spec/` directory.
   - Strips any stale `!.spec/` re-inclusion from the repo root `.gitignore`.

3. (Optional) Convert to `external-git` by re-registering with a remote:

   ```sh
   specd_store(action="register", type="external-git", storePath="/absolute/path/to/store", remote="git@github.com:<owner>/<repo-name>-specd.git")
   ```

### Verification checklist

- [ ] `specd_store(action="status")` shows `type=external` and the expected path.
- [ ] `specd_read(view="dashboard")` shows the item status summary; migration itself verifies item/event/link counts internally and refuses on mismatch.
- [ ] The repo root has no `.spec/` directory.
- [ ] `git status --porcelain` in the repo shows only `.gitignore` modified and `.spec/` deleted.
- [ ] The external store has a git commit `migrate specd store events` (`git -C <store> log --oneline`).

### Commit the cleanup

Run this once from the code repo:

```sh
git add -A && git commit -m "chore: migrate specd store to external"
```

This is the one intentional dirty moment of migration. After this commit the code repo is clean again and everyday specd commands will not touch it.

### Per-repo commands

Use the repo name in the recommended store path.

#### dotpi

```sh
specd_store(action="migrate", storePath="/Users/<you>/.pi/agent/stores/dotpi")
```

#### lingua-lair

```sh
specd_store(action="migrate", storePath="/Users/<you>/.pi/agent/stores/lingua-lair")
```

#### stoa

```sh
specd_store(action="migrate", storePath="/Users/<you>/.pi/agent/stores/stoa")
```

### Safety

- **Idempotent** — re-running on an already-migrated repo is a no-op.
- **Verify-before-flip** — if item/event/link counts or projected statuses do not match, migration refuses and leaves `.spec/` intact.
- **Refuse target collision** — if the target already holds a specd store, migration refuses.

## Zero-dirty-tree guarantee

For every placement mode during normal operation:

- **In-repo**: specd writes only under `.spec/`. Only `.spec/.gitignore` may be tracked; all other store files are gitignored.
- **External / external-git**: specd writes only inside the configured external directory. The code repo is untouched.

Event appends, store registration, and everyday specd commands do not dirty the code repo's working tree. The registry file itself lives outside the repo. Migration is the exception: it intentionally deletes `.spec/` and edits the repo root `.gitignore`, leaving the tree dirty until the operator runs the commit step above.
