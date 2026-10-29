# Prompt Guide — using specd effectively

## The golden rule

specd's gates enforce the workflow. Your prompts don't need to say "make sure the spec is approved" — the store refuses export without approval. Focus your prompts on **content quality**, not process compliance.

## Starting a cycle

```
/spec start "Add JWT authentication with refresh tokens"
```

Be specific about the idea. The agent will ask clarifying questions during explore. The more context you give upfront, the better the spec.

**During explore**: answer the direction questions (purpose, users, constraints, v1 boundary). These seed the entire derivation.

**Depth choice**: fast-path for focused changes, epic/roadmap for anything spanning multiple components or repos.

## The approval gates

You'll be asked to approve at key transitions:
- Spec approval — "does this capture what we're building?"
- Export — "are these tasks right?"
- Review — "does the implementation match the spec?"

These are YOUR decisions. The agent records them as events. Don't rubber-stamp.

## Running tasks

```
/spec run task-0001
```

The agent handles the full seam: worktree, worker, reviewer, PR. You review the PR like any other code change. The completion gate requires a passing review — the agent can't skip it.

## When things go wrong

| Situation | What to do |
|---|---|
| Gate refuses | Read the message — it says what's missing |
| Worker produces nothing | Check if the task was interrupted; /spec pause captures state |
| Review fails | `/spec diagnose <task>` — diagnose, record, fix, re-review. The gate requires the diagnosis |
| CI fails on the task's PR | Same loop: `/spec diagnose <task>` |
| Scope collision | Another task is in-progress with overlapping files |
| Unknown item | Use specd_read(view="query") to find the right id |

## Querying the store

```
specd_read(view="query", kind="task", status="exported")
specd_read(view="query", of="spec-0001", insight=true)
specd_read(view="query", q="login route")
specd_read(view="query", kind="product")
```

The insight mode gives one-line digests. For a single match, it adds the full event history and link list.

## Sink setup

```
/spec sink
```

1. Create the project from the **Kanban template** in the GitHub UI first
2. Then configure: owner + project number
3. The template gate validates the fields and views
4. ensurePlan customizes the Status field to the 6 layer options
5. Set the statusMap: exported → Ready, in-progress → In Progress, done → Done. Optional `in-review` key maps where a done task's still-open PR sits (default: In review).

## Stage re-entries

You don't need to re-run the full flow to revisit a stage:

```
/spec clarify spec-0001     # sharpen an approved spec
/spec plan spec-0002        # plan an approved spec
/spec tasks spec-0002       # break it into tasks
/spec constitution          # revisit the foundation
```

These are doors into the pipeline at any stage. The gates still enforce ordering.

## What NOT to do

- Don't create items with a retired kind — use the layer kinds (`product`, `domain`, `application`).
- Don't export before the spec is approved — the gate will refuse.
- Don't skip the review — completion requires it.
- Don't edit the store.db directly — use the tools. The event history is the audit trail.

## The store is your memory

Every decision, every approval, every state transition is recorded as an append-only event. When you come back to a project after weeks:

1. `/spec` — the dashboard shows the current state of everything
2. `specd_read(view="query", of="epic-0001")` — what's connected to this epic?
3. `specd_read(view="show", item="spec-0001")` — what did we decide and why?
4. `/spec doctor` — is the store healthy?

The store remembers what you decided even when you don't.

## The execution seam in detail

When you run `/spec run task-0001`, here's what happens:

1. **Worktree**: specd creates an isolated git worktree on a conventional branch
2. **Worker**: a subagent implements the task inside the path scope, commits, and pushes — it does NOT create the PR
3. **Reviewer**: a second subagent reads the diff against the acceptance criteria and gives a verdict
4. **Gate**: only a passing review unlocks completion
5. **PR**: the agent creates the PR from the worktree branch
6. **Board**: the issue moves on your GitHub project board automatically

You review the PR like any other code change. The difference: the implementation was already checked against the spec's acceptance criteria by the reviewer.

## The fix loop

When a review or CI run fails on a running task, the fix path is a
command, not improvisation:

```
/spec diagnose task-0001 "429 response missing Retry-After header"
```

The agent reproduces the failure, traces it to a root cause, and records
a diagnosis on the task — symptom, root cause, evidence, and whether the
spec itself was wrong. Then it fixes and re-runs the reviewer. The
completion gate enforces the order: a passing review only counts once a
diagnosis answers the last failure, and every new failure needs a fresh
diagnosis. Blind retries are refused in code.

When the diagnosis says the spec was wrong (`specGap`), the spec is
revised before anything else — the completion gate holds the task until
the linked spec has an update recorded after the diagnosis. Fixes keep
code and spec aligned.

Not every fix needs this — the loop is for failures:

- Work that fits the task's acceptance criteria is just work. No command.
- A requirement the task doesn't cover becomes a new task (`/spec converge` finds these too).
- Trivia can stay ad-hoc — converge folds it into the store later.

## Pausing and resuming

If you need to stop mid-task:

```
/spec pause
```

This captures a capsule — the current decisions, open questions, evidence, and next step. When you resume:

```
/spec run task-0001
```

The agent reads the capsule and continues from where you left off. Nothing is lost.

## Convergence

After implementing a slice, run:

```
/spec converge epic-0001
```

This checks: are all the spec's acceptance criteria covered? Are there exported tasks that aren't done? Are there slices that haven't been started? It appends missing work as new tasks — the loop continues until convergence reports done.

## The big picture

specd is designed for the developer who wants structure without bureaucracy:

- **Small change?** Fast-path: one spec, one plan, one task, ship it.
- **Big feature?** Epic/roadmap: decompose, order the slices, implement one at a time.
- **Team project?** The store captures decisions that outlive the session.
- **Existing project?** Zero footprint — the store lives outside your repo.
- **Multiple repos?** One shared store, referenced by each repo.

The workflow scales with the problem. The gates scale with the risk.
