# Your First specd Cycle

A step-by-step walkthrough: from idea to merged PR. This is what a complete
specd cycle looks like in practice.

## Prerequisites

- pi session running in your project directory
- `gh` CLI authenticated (`gh auth status`)
- A GitHub repo with a project board created from the **Kanban** template

## Step 1 — Start the cycle

```
/spec start "Add rate limiting to the public API"
```

specd creates a cycle and asks about depth:

> **How deep should this cycle go?**
> ❯ Fast-path (one spec → one plan → 1–3 tasks)
>   Epic/roadmap ladder (multiple slices, ordered)

For a focused feature, pick **Fast-path**.

## Step 2 — Explore

specd asks whether you want to research before committing:

> **Any unknowns worth researching first?**

If the idea touches unfamiliar territory, say yes — the agent searches the
web and captures findings as evidence. For a well-understood feature, skip.

Then answer the direction questions:

> **What are we building?** "Rate limiting middleware for the public API
> using a token bucket algorithm, with per-client limits and a
> Retry-After header."

> **Who uses it?** "External API consumers hitting the public endpoints."

> **Constraints?** "Must work with the existing auth middleware. No new
> dependencies beyond the standard library."

> **What does done look like?** "Rate limits enforced, 429 responses with
> Retry-After, per-client tracking, configurable limits."

## Step 3 — The spec

The agent interviews you and creates a spec. You'll see:

```
Created spec-0001 — Rate limiting for the public API
```

The spec has:
- **Intent** — what and why
- **Requirements** — numbered, testable statements
- **Acceptance criteria** — the reviewer checks against these
- **Out of scope** — what you're NOT building

Review it. If something's wrong, say so — the agent revises and re-files.
When you're satisfied:

> **Approve spec-0001?** → **Approve**

The store records `spec.approved`. The export gate is now unlocked.

## Step 4 — The plan

The agent interviews for the technical approach:

> **What language/framework?** "Go, using the standard library's
> `sync.Map` for per-client state."

> **Where does the rate limit state live?** "In-memory per instance.
> For multi-instance deployments, we'd need Redis — out of scope for v1."

Each decision is recorded as a `decision.made` event on the plan. The
constitution (if one exists) is checked for alignment.

```
Created plan-0001 — Rate limiting implementation plan
```

## Step 5 — Tasks

The agent breaks the plan into tasks:

```
Created task-0001 — Rate limiter middleware core
  path scope: src/middleware/ratelimit.go
  type: feat
Created task-0002 — Per-client tracking + Retry-After headers
  path scope: src/middleware/ratelimit.go, src/handlers/api.go
  type: feat
```

Tasks have **path scopes** (which files they're allowed to touch) and
**conventional types** (feat, fix, chore). Disjoint scopes can run in
parallel — overlapping scopes are serialized.

## Step 6 — Export

```
/spec sink          (if not configured yet)
specd_export(item="task-0001", sink="github")
```

The task becomes a GitHub issue:

> **feat(task-0001): rate limiter middleware core** — placed in **Backlog**

The issue title follows conventional commits. The `specd` label is applied.
The board's Status column is set from the statusMap.

## Step 7 — Execute

```
/spec run task-0001
```

This is where the magic happens:

1. **Worktree created** — an isolated copy of the repo on a conventional branch
   ```
   specd/feat/task-0001-rate-limiter-middleware-core
   ```

2. **Worker spawned** — a subagent implements the task inside the path scope.
   It writes the code, writes tests, commits, and pushes. It does NOT
   create the PR.

3. **Reviewer spawned** — a second subagent reads the diff against the
   task's acceptance criteria. It returns findings:
   ```
   P0: Missing Retry-After header in the 429 response
   ```

4. **Gate fires** — the review failed, so completion is refused. The
   agent diagnoses first:
   ```
   /spec diagnose task-0001 "429 response missing Retry-After header"
   ```
   It records the root cause (and whether the spec itself was wrong),
   fixes the issue, and pushes again.

5. **Re-review** — the reviewer re-checks:
   ```
   Reviewer verdict: PASSED, no blockers.
   ```

6. **PR created** — from the worktree branch:
   ```
   feat(task-0001): rate limiter middleware core
   ```

7. **Completed** — `work.completed` recorded. The board item moves to
   **In review** and lands in **Done** when the PR merges.

## Step 8 — Merge

Review the PR like any other code change. The difference: the
implementation was already checked against the spec's acceptance criteria
by the reviewer, and the board tracked the task through every stage.

Merge. The board column moves to **Done**.

## Step 9 — Convergence

```
/spec converge <spec-id>
```

The agent checks: did the implementation cover all acceptance criteria?
Are there exported tasks that aren't done? It appends missing work as new
tasks and reports convergence status.

## What just happened

You went from a one-line idea to a reviewed, tested, merged PR — with:
- A structured spec that captures intent
- A plan with recorded decisions
- Tasks with clear scopes and conventional naming
- An isolated worktree per task
- A reviewer that checks against acceptance criteria
- A board tracking progress automatically
- An audit trail of every decision and state transition

And your repo has zero specd artifacts — the store lives outside the code.
