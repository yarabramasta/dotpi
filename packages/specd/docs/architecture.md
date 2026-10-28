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

All items, events, and decisions live in a **SQLite database**
(`.spec/store.db`). Every action is an **append-only event**:

```
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
| Complete work | A passing review must exist |
| Re-export | Task must not already be exported |
| Template | Project must have the Kanban template fields and views |

These aren't suggestions. The store **refuses** the action and returns a
plain-language reason. The agent cannot bypass them because the refusal
happens in the tool's execute function, not in the prompt.

## Zero repo footprint

The store lives in `.spec/store.db`, which is gitignored by default.
Nothing is committed to your repo unless you explicitly promote items to
markdown (optional, via the storage system).

This means:
- The "senior won't allow it" scenario is solved — your repo stays clean
- No `.specify/` or `.kiro/` directories polluting the working tree
- The store is per-machine and per-repo (private by default)
- The repo's git history contains code, not planning artifacts

## The execution seam

Each task runs in an **isolated git worktree** on a conventional branch.
A **worker subagent** implements the task inside its path scope, commits,
and pushes. A **reviewer subagent** then reads the diff against the task's
acceptance criteria and gives a verdict.

The completion gate requires a **passing review** — the agent cannot
complete a task that the reviewer rejected. This is the quality gate that
spec-kit's prompt-based workflows can't enforce.

## The github sink

specd integrates with GitHub Projects v2 via the `gh` CLI. The project
is created from the **Kanban template** (which provides the fields, views,
and workflows). specd then:

1. Validates the template (all expected fields and views must exist)
2. Customizes the Status field to 6 workflow columns with colors
3. Adds the `specd` label
4. Maps store statuses to board columns (the statusMap)

When a task starts, the issue moves to In Progress. When it completes,
it moves to Done. When the board shows Done, the store syncs back.
The push and pull are both automated.

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
