# Storage Guide — scenarios, setup, and disaster recovery

How specd stores your data, what happens when things go wrong, and how to
set it up for your situation.

## The two files that matter

| File | What it is |
|---|---|
| `events.jsonl` | The source of truth — one JSON line per event (decisions, approvals, state changes) |
| `store.db` | The derived projection — a SQLite database computed by replaying the events |

You version the source (events), not the build output (the database). This
is the event-sourcing pattern applied to version control.

For the current placement modes, see [Store placement and migration](../../docs/store-placement.md).
In-repo stores are machine-local: only `.spec/.gitignore` may be tracked;
`events.jsonl`, `store.db`, and transient files are gitignored. External
stores live outside the repo and are registered in the machine-local
`~/.pi/agent/specd-stores.json` file.

## Markdown mirror modes

These modes control where readable markdown mirrors go. They are separate
from the store placement modes.

| Mode | Where md mirrors live | Use case |
|---|---|---|
| `db-only` | Nowhere | Development — fast, no file pollution |
| `md-inrepo` | `docs/specd/<id>.md` in the repo | Sharing specs in PRs |
| `md-external` | A directory you choose | Cross-repo scenarios |

## Where the store lives

When you run `/spec start` in a repo without a store, specd asks:

### Option 1 — In this repo

The store lives at `.spec/` inside the repo. The `.gitignore` inside
`.spec/` ignores every file except itself, so no store data is committed.

```text
.spec/
├── .gitignore          (committed; ignores everything in this directory)
├── events.jsonl        (gitignored — machine-local)
└── store.db            (gitignored — rebuilt from events)
```

**Best for**: a constraint that forces the store inside the repo.

**After a Mac wipe**: the events are lost because they are not committed.
Restore `.spec/events.jsonl` from a backup or migrate to an external store
before moving machines.

### Option 2 — External, specd-managed (zero footprint)

The store lives at `~/.pi/agent/stores/{repo-name}/`. Your repo has
ZERO specd-related files.

```text
~/.pi/agent/stores/my-android-app/
├── .specd-store.yaml   (marker)
├── .gitignore          (in the external store)
├── events.jsonl        (tracked in the external store's own git repo; external-git adds a remote)
└── store.db            (gitignored, rebuilt from events)
```

**Best for**: the default for new repos — your repo stays clean.

**After a Mac wipe**: the events are in the external directory, which is
NOT in the repo. Back it up separately or use Option 3.

### Option 3 — External, git repo (shareable)

The store lives as its own git repository. Push it to GitHub, clone it on
any machine. Multiple repos can share one store by referencing it.

```text
~/.pi/agent/stores/my-product-specd/     ← this IS a git repo
├── .specd-store.yaml
├── .gitignore
├── events.jsonl                          ← committed to the external store repo
└── store.db                              ← gitignored

backend-api      → references this store
android-app      → references this store
ios-app          → references this store
```

**Best for**: team scenarios, multi-repo products, and zero-footprint needs.

**After a Mac wipe**: clone the code repo, clone the store repo (you need
to know its URL), run `/spec connect` or register manually. The store is
rebuilt from the events.

## Scenario guide

### "I'm starting a new personal project"

Use **Option 2** (external, specd-managed). The repo stays clean.

### "I'm working on someone else's repo and can't add files"

Use **Option 2** or **Option 3** (external / external-git). Your repo
stays clean and the store is outside it.

### "I'm building a multi-repo product"

Use **Option 3** with one shared store. All repos reference the same
knowledge base. One spec describes behavior — all repos implement their
slice.

### "I want to share specs with my team"

Use **Option 3**. Push the store repo to GitHub. Teammates clone it and
register. Spec changes are reviewable via PRs.

### "I just want to try specd without committing to it"

Use **Option 2** (external, managed). Zero footprint, easy to delete
(`rm -rf ~/.pi/agent/stores/{repo-name}/`).

### "I have an old in-repo store with committed events.jsonl"

Migrate it to an external store. See
[Store placement and migration](../../docs/store-placement.md).

## Disaster recovery

### "I wiped my Mac and cloned my repo"

| Store location | What to do |
|---|---|
| In-repo (machine-local) | The events are lost. Restore `.spec/` from a backup or start fresh |
| External git repo | Clone the code repo → clone the store repo → register → the store auto-rebuilds |
| External (no remote) | The store is lost. Start fresh |

**The event log is your backup.** As long as the events survive, the
store can be rebuilt.

### "I need to move to a new machine"

1. Clone the code repo
2. If the store is external-git: clone the store repo too
3. Register the store with `specd_store(action="register")`
4. `openStore` replays `events.jsonl` if `store.db` is missing
5. Everything is back

### "I want to share my store with a teammate"

1. Push the store repo to a git host (GitHub, GitLab, etc.)
2. Teammate clones the store repo: `git clone <url> ~/.pi/agent/stores/{name}/`
3. Teammate registers: `specd_store(action="register", type="external-git", storePath=…, remote=<url>)`
4. Teammate runs `/spec doctor` to verify

## The registry

The mapping between repos and stores lives at
`~/.pi/agent/specd-stores.json`:

```json
{
  "/Users/you/Development/backend-api": {
    "type": "external-git",
    "storePath": "/Users/you/.pi/agent/stores/backend-api",
    "remote": "git@github.com:you/backend-api-specd.git"
  }
}
```

This file is machine-local. After a wipe, re-register (or include the
store URL in your notes).

## What specd does NOT commit to the code repo

- `store.db` — binary, derived, rebuilt from events
- `store.db-wal` — transient SQLite write-ahead log
- `store.db-shm` — transient SQLite shared memory
- `events.jsonl` — machine-local in in-repo stores

In an in-repo store, only `.spec/.gitignore` may be tracked. In external
stores, `events.jsonl` is tracked in the external store's own git repo;
`external-git` adds a remote.

## Child-session write guard (no-specd-store-writes)

A specd store is a durable shared artifact, so enforcement of "child
receives no store tools" deliberately does NOT rest on session identity:
a session UUID is ephemeral and conversation-scoped, and binding ownership
to it either locks out legitimate sessions (whoever binds first wins) or
is stolen by whichever session opens the store first. Instead, the guard
keys on the one artifact specd itself creates for spawned workers: the
convention task worktree (`<repo>-specd-<kind>-<id>`, made by
`specd_start_work`).

All mutating specd tools (`specd_append_event`, `specd_create_item`,
`specd_add_link`, `specd_remove_link`, `specd_promote`, `specd_export`,
`specd_start_work`, `specd_import` (apply/revert), `specd_configure_sink`,
`specd_store` register/reference actions, and `specd_open_pr`) refuse
calls whose cwd is a task worktree with a `no-specd-store-writes` error
that tells the child to report results to the parent session, which
records all specd events. Reads stay open from child contexts — children
may inspect the store because worktrees resolve back to the same store
as the main checkout. The two slash-command write paths (`/spec storage`,
`/spec export`) are deliberately unguarded: slash commands exist only in
the parent TUI, which spawned children do not have.

`specd_read(view=dashboard)` performs a read-back sync that can append
events (exported tasks whose sink item closed become done); from a child
context that sync is skipped, so the read view stays read-only for
children. (Stale `meta` rows from earlier session-binding experiments are
ignored.)

This makes the "child receives no store tools" enforcement reliable even
when ambient extension loading gives a spawned session access to the specd
tool names — the guard in the store/tool layer is what actually refuses
writes.
