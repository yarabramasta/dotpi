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

## Store location and footprint

specd supports two store locations, and the "zero footprint" claim depends
on which one you use:

### In-repo store (`.spec/` inside the repo)

```
.spec/
├── .gitignore          ← committed (tells git to ignore store.db)
├── events.jsonl        ← committed (the audit trail, text, mergeable)
└── store.db            ← gitignored (rebuilt from events)
```

The senior reviewing the repo **sees** `.spec/` with a `.gitignore` and an
`events.jsonl`. This is visible footprint — fine for your own repos, not
for the "senior won't allow it" scenario.

### External store (the zero-footprint option)

The store lives OUTSIDE the repo as its own git repository:

```
your-repo/                                ← zero specd files
~/.pi/agent/stores/{repo-name}/           ← the store (its own git repo)
├── .gitignore                            ← in the store repo, not yours
├── .specd-store.yaml                     ← in the store repo
├── events.jsonl                          ← in the store repo
└── store.db                              ← gitignored
```

The senior reviewing your repo sees **nothing**. The store, its git
history, its events — all live in a separate repository. This is the
"senior won't allow it" solution.

### Choosing

| Scenario | Use |
|---|---|
| Your own repo, team shares specs | In-repo (committed) |
| Your own repo, private planning | In-repo (gitignore events too) |
| Someone else's repo, "senior says no" | **External** |
| Multi-repo product (shared knowledge) | **External** (one store, multiple repos) |

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
