# pi-grill

Socratic planning mode + a repo knowledge base for Pi. Two halves, one store:

- **Grill Me sessions** — `/grill <topic>` interviews you through a picker
  overlay, maintains a shared-understanding checkpoint, and lands outputs as
  tracked atoms or GitHub issues.
- **Grill atom** — a persistent, repo-scoped knowledge base
  (`.pi/knowledge/atoms.db`) that survives sessions: decisions, research,
  plans, requirements, concepts. Agents pick it up with or without a grill
  session.

Everything below is organized by what you actually run.

---

## Planning sessions

### "I want to plan something with structure"

```text
/grill <topic>
```

What happens: a repo dossier (Cymbal + git) is captured automatically for
grounding (`🔥 grill · warming up…` on the status line), then the session
asks focused Socratic questions through a picker (↑/↓ + Enter on suggested
answers, type your own anytime). Your answers accumulate in a **checkpoint**
— the shared understanding both you and the agent work from. Sessions stay
read-only until the mandatory **output-selection phase**: you explicitly
approve what gets produced (GitHub issues, plan atoms, docs — you pick).
After outputs, one read-only reviewer pass verifies checkpoint vs produced
outputs vs edited files (PASS or gap list; gaps get fixed, pass reruns once).

State auto-persists every change; switching model mid-session is safe.

### "Where am I? Show me / steer / stop"

```text
/grill status                    # session status
/grill checkpoint [edit|chat]    # show / edit / print the checkpoint (also /checkpoint)
/grill intent auto|plan|learn|research|content|decide
/grill output <outputs>          # preference only, not approval
/grill research off|ask|auto
/grill subagents on|off          # grounding scouts + reviewer + write delegation
/grill isolation [worktrees|gitbutler|slices|auto]
/grill stop
```

Session toggles override settings defaults for this session only.

### "What did my sessions produce?"

Approved outputs land as typed atoms with edges (design doc, ADR, PRD,
implementation plan, research brief, summary, tutorial outline, test plan,
changelog — you choose in the output-selection phase), GitHub issues, or
repo-tree files. Every session auto-appends a `sess-*` atom citing what it
produced. They're all queryable via the atom store below.

---

## Repo knowledge base

### "Give my repo a memory"

```text
/atom init
```

Scaffolds `.pi/knowledge/` (`atoms.db` + `.gitignore` + `.gitattributes`),
reports workspace shape (monorepo detection), prints the optional textconv
setup line for readable db diffs, and **writes a pointer block into
`AGENTS.md`** so any agent — grill session or not — knows the KB exists.
Idempotent: it updates its own block by marker, skips repos whose AGENTS.md
already mentions `atoms.db`, and creates the file if missing
(`Pointer: created|written|updated|skipped` in the init output).

New decisions don't need a session — record them directly (next case).

### "I'm an agent and need the knowledge — no grill session running"

The KB is never gated behind a session. In pi, the tools are always there:

- `atom_query` — filters: `id=` (returns the **full atom**, body included),
  `type=`, `status=`, `status_not=`, `q=` (FTS5 keyword search over title +
  body), `scope=`, `after=YYYY-MM-DD`, `limit=`, `sort=created|id`
- `atom_digest` — compact counts by type/status, recent sessions, active
  decisions; optional task lens (`task=`)

Without pi at all (other tools, other agents): the `AGENTS.md` pointer tells
you the store exists, and plain sqlite3 works:

```sh
sqlite3 .pi/knowledge/atoms.db \
  "SELECT id,title FROM atoms_fts WHERE atoms_fts MATCH 'kw*'"
```

### "Record a decision / research / plan right now"

```text
/atom create type=decision title=<t> [body=<md>|--edit] [scope=<s>] [sources=<comma-separated>]
```

or the `atom_create` tool. Types: `decision` `research` `plan` `spec` `task`
`session` `validation` `content` `release` `requirement` `concept` `spike`
(ids like `dec-0005`). `--edit` opens the editor for the body; `sources` are
your provenance URLs/refs.

### "Change something"

```text
/atom update <id> [body=<md>|--edit] [status=<s>] [scope=<s>] [sources=<comma-separated>]
```

Bodies revise in place (revisions are normal). `sources=[]` (empty) clears
provenance. If the atom is **promoted**, every change regenerates its md
export automatically — the repo file never drifts.

To replace a decision, don't overwrite history: create a new atom and
`/atom link <new> <old> supersedes` — the flip marks the old one superseded.

### "Make this visible in the repo" / "Actually, hide it again"

```text
/atom promote <id> [docs/path.md]   # md export into the repo tree
/atom demote <id> [<id>…]           # reverse: status → accepted, export deleted
```

Promotion is explicit and rare: decisions export to
`docs/decisions/<slug>.md`, everything else to `docs/atoms/<slug>.md`
(collision-safe `-2` suffixes; `docs_path` overrides). Demotion is bulk-ready
but takes explicit ids only — no filter sweeps, so a fat finger can't gut the
store. Demoted atoms stay fully searchable in the db.

### "Connect things"

```text
/atom link <from> <to> <kind>
```

Edge kinds: `supersedes` `refined-by` `depends-on` `produced-by` `cited`
`promoted-to` `part-of`.

### "Is everything healthy?"

```text
/atom doctor [--strict]
```

Checks schema version, empty bodies, orphan edges. `--strict` additionally
flags promoted decisions with no `sources` — record provenance at creation
(or `atom update <id> sources=…`) so citations stay traceable.

### "What's in the store?"

```text
/atom show <id>                  # full atom: meta + body
/atom query <type=…> <status=…|status!=…> <q=…> <scope=…> <after=…> <limit=…> <sort=…>
/atom digest [--task <text>]     # ~1KB digest; --task filters to matching atoms + their edges
```

### "I have an old repo with kb.db + nodes/"

One-shot converter, run from a dotpi checkout against the target repo:

```sh
npx tsx packages/grill/atom/migrate.ts <repo>    # or bun
```

Builds `atoms.db`, repoints stale promotion targets, writes exports for
promoted atoms, deletes `nodes/` + `kb.db`, upgrades the scaffold files. Old
KBs are never auto-read.

---

## Agent tools (registered in every pi session)

| Tool | Job |
| --- | --- |
| `atom_query` | find atoms (`id=` = full fetch); all filters above |
| `atom_create` | record an atom without a session |
| `atom_update` | revise body/status/scope/sources; promoted exports regenerate |
| `atom_promote` / `atom_demote` | opt-in repo-tree export / its rollback |
| `atom_digest` | orientation: counts, recent sessions, task lens |
| `atom_link` | typed edges between atoms |
| `atom_backfill` | set an atom's `scope` after creation |

The store is the underlying backend for atom-marked grill outputs: approved
outputs land as typed atoms with edges, never as stray md files.

---

## Under the hood (only what a case needs)

- Single SQLite store: `.pi/knowledge/atoms.db` — STRICT tables, bodies
  in-db, FTS5 virtual table kept in sync by triggers (zero per-query file
  reads), `schema_version = "2"` guard.
- `.gitignore` = `*` + `!atoms.db` (+ WAL/journal ignores); `.gitattributes`
  = `atoms.db diff=sqlite3` — readable diffs via optional textconv; merges
  stay binary, the single-writer/agent-owned model is the mitigation.
- Statuses: `draft` `accepted` `promoted` `superseded`. Scopes label
  monorepo packages.

## Settings

`~/.pi/agent/grill.json` or project `.pi/grill.json` (wins; trust-gated):

```json
{ "subagents": true, "collapseKey": "ctrl+]", "isolation": "auto", "atom": true }
```

`/grill atom off` disables the KB for the session; `/grill subagents on|off`
and `/grill isolation <backend>` override per session.
