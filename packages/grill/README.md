# pi-grill

Socratic planning mode for Pi. `/grill <topic>` interviews you through a picker
overlay — the Question tab with the answer choices, plus read-only Checkpoint,
Grounding, and Review tabs — while maintaining a shared-understanding
checkpoint (show or edit it anytime with `/grill checkpoint` or
`/checkpoint`). Sessions stay read-only until you explicitly approve output
production in the output-selection phase. Grounding is automatic: a compact
repo dossier (Cymbal + git) is captured at session start (`🔥 grill · warming
up…` on the status line while it runs).

```text
/grill <topic>
/grill stop
/grill status
/grill checkpoint [edit|chat]
/grill intent auto|plan|learn|research|content|decide
/grill output <outputs>       # preference only, not approval
/grill research off|ask|auto
/grill atom on|off|init|doctor|query|digest
/grill subagents on|off
/grill isolation [worktrees|gitbutler|slices|auto]
```

With the subagent integration on (default; `/grill subagents` overrides per
session), approved file writes can be delegated to a writer subagent per output
batch under an isolation backend — git worktrees, GitButler, or plain slices,
auto-resolved from repo state (`/grill isolation` overrides per session). After
outputs, one read-only reviewer pass verifies the checkpoint against produced
outputs and edited files (PASS or gap list; gaps are fixed and the pass reruns
once). Settings defaults (`subagents`, `collapseKey`, `isolation`, `atom`) live
in `~/.pi/agent/grill.json`; a project `.pi/grill.json` wins.

## Grill atom

The grill extension also ships **grill atom** — a persistent, repo-scoped
atomic knowledge graph (renamed from "grill kb") so decisions, research,
plans, and summaries survive the session instead of being lost to the
conversation (the documented grill-with-docs gap: "where did all my other
decisions go?"). Philosophy: Socratic interviewing stays the primitive; the
atom is its stateful layer, and a graduation model keeps repos code-shaped —
cheap working memory in `.pi/knowledge/` (git-ignored by default), explicit
promotion moves accepted substance to durable homes (short Y-statement ADRs,
GitHub issues, repo docs). Canon stays one page and immutable;
superseded-not-edited.

```text
.pi/knowledge/
  .gitignore        # "*" — self-contained ignore; delete this file to commit the kb
  kb.db             # SQLite — single source of truth (nodes, edges, statuses, pointers)
  nodes/<id>.md     # body only, filename = id, zero frontmatter (grep-able)
```

`kb.db` holds ALL metadata (id `dec-0031`/`res-0007`/`req-0004`/`spk-0002`,
type `decision|research|plan|spec|task|session|validation|content|release|
requirement|concept|spike`, status `draft|accepted|promoted|superseded`, scope
for monorepo packages, `promoted_to`, `github_issue`/`github_project` refs,
`sources`); bodies live beside it as plain md — no frontmatter, so there is no
second source of truth. STRICT tables + foreign keys reject dangling edges and
duplicate ids at write time; grill is the single writer, `doctor` catches human
hand-edits. Graph absorb imports `docs/reference/graph/*.yaml` (types
`fr|nfr`→requirement, `flow-stage|layer|entity`→concept, `spike`→spike; edges
`superseded-by`/`supersedes`→supersedes,
`revised-by`/`refined-by`/`reworks`→refined-by, `gates`/`flows-into`→depends-on,
`sources`/`proves`→cited, `part-of`→part-of) idempotently at `init`.

```text
/atom init              # scan docs/adr (cap 50) + workspaces + docs/reference/graph; seed canon nodes, graph atoms, edges
/atom doctor [--fix] [--strict]  # db↔md consistency; --strict flags promoted decisions with NULL provenance
/atom query type=decision status=draft q=auth
/atom digest [--task <text>]     # ~1KB digest; --task lens filters to matching atoms + their edges
/grill atom on|off      # session toggle (settings: { "atom": true|false }, default on; deprecated "kb" key still read)
```

AI sessions call the native tools directly — no MCP server:

```text
atom_query(type?, status?, q?, scope?)   # find atoms + their canon paths
atom_digest(task?)                          # compact digest; task lens filters to matching atoms + edges
atom_link(from, to, kind)                # typed edge (supersedes, depends-on, …)
atom_backfill(id, issue?, project?, scope?)  # fill provenance columns
```

`/kb` and `/grill kb <sub>` are deprecated aliases of `/atom` and
`/grill atom <sub>` (removed in the next release). Bootstrap by repo shape:
fresh scaffolds skip `init` (first grill session seeds the atom); docs-only and
existing-grill repos run `/atom init` first so prior ADRs become citable canon
refs; monorepos keep ONE atom base at the git root with per-node `scope`; huge
codebases stay bounded (ADR cap 50, capped digest, one AGENTS.md pointer line).
The knowledge base is the underlying backend for atom-marked output
destinations (design doc, ADR, PRD, implementation plan, research brief,
summary, tutorial outline, test plan, changelog): those outputs land as typed
atoms with edges, revisions edit node bodies in place, and every session
auto-appends a `sess-*` node citing what it produced. Promotion to repo-tree
files (e.g. `docs/adr/NNN-slug.md`) runs through the output-selection phase —
never implicit. GitHub is composed refs-only: the atom never mirrors
issue/board state.
