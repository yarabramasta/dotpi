# Architecture — how specd works

## The problem with file-based workflows

Most spec-driven tools generate markdown files in your repo. The workflow
goes: generate files → the agent reads them → the agent follows instructions.

This has structural problems:

1. **Markdown sprawl** — 8+ files per feature, repetitive and tedious to review
2. **Agent compliance is unreliable** — the agent doesn't always follow the
   instructions in the files. It ignores notes, generates duplicates, mixes
   functional and technical concerns.
3. **Stale templates** — when the tool updates, every repo's copies are
   outdated
4. **No integrity guarantee** — nothing verifies that the files match the
   intended state
5. **No audit trail** — decisions are scattered across markdown, not
   structured data

specd takes a different approach.

## The event-sourced store

All items, events, and decisions live in a **SQLite database** inside a
specd store. The default in-repo location is `.spec/store.db`; the store
can also live outside the repo at a registered external path. Every
action is an **append-only event**:

```text
created → explore.decided → question.answered → spec.approved →
decision.made → task.exported → work.started → review.completed →
pr.created → work.completed
```

Projections (the current state of each item) are computed by replaying
the event history. The **doctor** verifies that the stored projections
match what the replay produces — any drift is flagged.

This means:
- **The history is immutable.** You can see every decision, every
  approval, every state transition.
- **The state is always consistent.** The projection is derived from
  events; if they disagree, the doctor catches it.
- **The store is queryable.** Search by kind, status, text, or links.
- **Nothing is lost.** Pause a task, come back weeks later — the capsule
  and event history have full context.

## Code-enforced gates

Most tools gate the workflow through prompt instructions — the agent is
asked to follow a checklist, and "hopefully" it does. specd's gates are
**in the code**:

| Gate | What the store enforces |
|---|---|
| Export | Task must be linked to an approved spec |
| Start work | Checklist must be reviewed + no scope collision |
| Complete work | Passing review that answers every failure with a diagnosis; a spec-gap diagnosis waits for the spec revision |
| Re-export | Task must not already be exported |
| Template | Project must have the Kanban template fields and views |

These aren't suggestions. The store **refuses** the action and returns a
plain-language reason. The agent cannot bypass them because the refusal
happens in the tool's execute function, not in the prompt.

## Store location and footprint

specd supports three placement modes. See [Store placement and
migration](../../docs/store-placement.md) for the migration runbook; the
summary here is:

### In-repo store (`.spec/` inside the repo)

```text
.spec/
├── .gitignore          ← committed (tells git to ignore everything else)
├── events.jsonl        ← gitignored (machine-local)
└── store.db            ← gitignored (rebuilt from events)
```

The only tracked file is `.gitignore`. This mode is supported but
machine-local — `events.jsonl` is not committed.

### External store (the zero-footprint option)

The store lives OUTSIDE the repo:

```text
your-repo/                                ← zero specd files
~/.pi/agent/stores/{repo-name}/           ← the store
├── .gitignore                            ← in the store, not the repo
├── .specd-store.yaml                     ← marker
├── events.jsonl                          ← tracked in the external store's own git repo; external-git adds a remote
└── store.db                              ← gitignored
```

The repo stays clean. External is the recommended default for new repos.
Use `external-git` when you need the store to be its own cloneable,
shareable git repo.

### Choosing

|Scenario|Use|
|---|---|
|New repo, personal/solo|`external`|
|New repo, team sharing|`external-git`|
|Constraint forces store inside repo|`in-repo` (machine-local)|
|Someone else's repo, "senior says no"|`external` or `external-git`|
|Multi-repo product (shared knowledge)|`external-git` (one store, multiple repos)|

## The execution seam

Each task runs in an **isolated git worktree** on a conventional branch.
A **worker subagent** implements the task inside its path scope, commits,
and pushes. A **reviewer subagent** then reads the diff against the task's
acceptance criteria and gives a verdict.

The completion gate requires a **passing review** — the agent cannot
complete a task that the reviewer rejected. This is the quality gate that
spec-kit's prompt-based workflows can't enforce.

A failing review starts a structured fix loop instead of an improvised
one. The agent records a **diagnosis** on the task — symptom, root
cause, evidence, and whether the spec itself was wrong (`specGap`) —
via `/spec diagnose`. The gate counts a passing review only once a
diagnosis answers the last failure, so blind retries are refused in
code. A specGap diagnosis holds completion until the linked spec is
revised: bugs that reveal spec gaps update the spec, not just the code.

## The github sink

specd integrates with GitHub Projects v2 via the `gh` CLI. The project
is created from the **Kanban template** (which provides the fields, views,
and workflows). specd then:

1. Validates the template (all expected fields and views must exist)
2. Customizes the Status field to 6 workflow columns with colors
3. Adds the `specd` label
4. Maps store statuses to board columns (the statusMap)

When a task starts, the issue moves to In Progress. When it completes
with its PR still open, it moves to In review — Done waits for the
merge. Read-back sync watches the PR: once it merges, the store records
it (`pr.merged`) and the issue lands in Done. The push and pull are both
automated.

## Why not file generation?

spec-kit generates files because it's a CLI — it has no runtime presence
in the agent. It can only communicate through files, which is why it
creates `.specify/`, `.github/prompts/`, and `specs/` directories.

specd is a **pi extension** — it has a runtime presence with tools, gates,
and structured state. It doesn't need to generate files because the
extension IS the interface. The store IS the context. The gates ARE the
workflow.

The tradeoff: specd requires pi. But for pi users, the extension approach
provides structure, enforcement, and integrity that file-based tools can't.
