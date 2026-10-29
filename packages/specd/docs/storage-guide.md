# Storage Guide — scenarios, setup, and disaster recovery

How specd stores your data, what happens when things go wrong, and how to
set it up for your situation.

## The two files that matter

| File | What it is | Git status |
|---|---|---|
| `events.jsonl` | The source of truth — one JSON line per event (decisions, approvals, state changes) | **Committed** — text, mergeable, diffable |
| `store.db` | The derived projection — a SQLite database computed by replaying the events | **Gitignored** — binary, rebuilt from the events |

You version the source (events), not the build output (the database). This
is the event-sourcing pattern applied to version control.

## The three storage modes

| Mode | Where md mirrors live | Use case |
|---|---|---|
| `db-only` | Nowhere | Development — fast, no file pollution |
| `md-inrepo` | `docs/specd/<id>.md` in the repo | Sharing specs in PRs |
| `md-external` | A directory you choose | Cross-repo scenarios |

The mode controls where **markdown mirrors** go — the store and events
are always present regardless of mode.

## Where the store lives

When you run `/spec start` in a repo without a store, specd asks:

### Option 1 — In this repo (default)

The store lives at `.spec/store.db` inside the repo. The `.gitignore`
ignores the database but commits the events.

```
.spec/
├── .gitignore          (ignores store.db, WAL, SHM)
├── events.jsonl        (committed — the audit trail)
└── store.db            (gitignored — rebuilt from events)
```

**Best for**: your own repos where you want the planning history versioned
with the code.

**After a Mac wipe**: clone the repo → the events are there → the store is
rebuilt automatically. Nothing is lost.

### Option 2 — External, specd-managed (zero footprint)

The store lives at `~/.pi/agent/stores/{repo-name}/`. Your repo has
ZERO specd-related files.

```
~/.pi/agent/stores/my-android-app/
├── .specd-store.yaml   (marker)
├── .gitignore
├── events.jsonl
└── store.db
```

**Best for**: the "senior won't allow it" scenario — your repo stays
completely clean.

**After a Mac wipe**: the events are in the external directory, which is
NOT in the repo. You need a separate backup (or the external dir should
be a git repo — see Option 3).

### Option 3 — External, git repo (shareable)

The store lives as its own git repository. Push it to GitHub, clone it on
any machine. Multiple repos can share one store.

```
~/.pi/agent/stores/my-product-specd/     ← this IS a git repo
├── .specd-store.yaml
├── .gitignore
├── events.jsonl                          ← committed to this repo
└── store.db                              ← gitignored

backend-api      → references this store
android-app      → references this store
ios-app          → references this store
```

**Best for**: team scenarios (multiple developers share specs via
push/pull), multi-repo products (one knowledge base, multiple code repos),
and the "senior won't allow it" scenario (zero footprint + versioned).

**After a Mac wipe**: clone the code repo, clone the store repo (you need
to know its URL), run `/spec connect` or register manually. The store is
rebuilt from the events.

## Scenario guide

### "I'm starting a new personal project"

Use **Option 1** (in-repo). The events travel with the repo. Simple.

### "I'm working on someone else's repo and can't add files"

Use **Option 3** (external git repo). Your repo stays clean. The store
is versioned separately.

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

## Disaster recovery

### "I wiped my Mac and cloned my repo"

| Store location | What to do |
|---|---|
| In-repo (committed) | Clone the repo → the events are there → the store auto-rebuilds |
| In-repo (gitignored) | The events are lost. Restore from backup or start fresh |
| External git repo | Clone the code repo → clone the store repo → register → the store auto-rebuilds |
| External (no git) | The store is lost. Start fresh |

**The event log is your backup.** As long as the events survive, the
store can be rebuilt.

### "I need to move to a new machine"

1. Clone the code repo
2. If the store is external-git: clone the store repo too
3. Run `/spec connect` or register the store path
4. `openStore` replays the events if store.db is missing
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

## What specd does NOT commit

- `store.db` — binary, derived, rebuilt from events
- `store.db-wal` — transient SQLite write-ahead log
- `store.db-shm` — transient SQLite shared memory

Everything else (events, md mirrors, the marker file) can be committed.

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
may inspect the store they resolve (a child in a task worktree resolves
its own fresh `.spec` copy there; committed in-repo stores resolve via
the repo). The two slash-command write paths (`/spec storage`,
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
