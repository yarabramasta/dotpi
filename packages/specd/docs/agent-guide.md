# Agent Guide — operating specd

This guide is for the AI agent operating specd tools. Follow these rules.

## Store resolution

Before any specd operation, verify a store exists:

```
specd_store(action=status)
```

- If a store is registered or found at `.spec/store.db` → proceed.
- If not → ask the user where it should live using `ask_user_question`:
  1. External — specd-managed (zero footprint): register with `specd_store(action="register", type="external", storePath="~/.pi/agent/stores/{repo-name}")`
  2. External — git repo (shareable): same but `type="external-git"`
  3. In this repo (`.spec/`, gitignored): the default, no registration needed
  4. In this repo (`.spec/`, committed): `type="in-repo"`
- Then add `.spec/` to `.gitignore` if in-repo and gitignored.

## Item kinds

Valid kinds: `spec`, `plan`, `task`, `cycle`, `epic`, `roadmap`, `constitution`, `checklist`, `product`, `domain`, `application`.

`knowledge` is retired. Never create items with `kind="knowledge"` — use the layer kinds instead:
- `product` for SDLC, user stories, compliance, marketing, purpose
- `domain` for use cases, features, flows
- `application` for backend, frontend, infra, architecture, technical

## Gate refusals

When a tool refuses an action, the refusal is correct. Do NOT:

- Retry the same call hoping for a different result
- Bypass the gate with direct SQL
- Edit the store.db file directly

DO:

- Read the refusal message — it says exactly what's missing
- Fix the state: approve the spec, complete the checklist, resolve the collision
- Re-attempt after the state is corrected

## Gate reference

| Gate | Refuses when | Fix |
|---|---|---|
| `specd_export` | Spec not approved | Get the spec approved first |
| `specd_export` | Task already exported | Use the existing export |
| `specd_append_event(work.started)` | Checklist not reviewed | Complete the checklist review |
| `specd_append_event(work.started)` | Scope collision with in-progress task | Wait or adjust scopes |
| `specd_append_event(work.completed)` | No passing review | Run the reviewer, get `passed: true` |
| `specd_append_event(work.completed)` | A failing review has no answering diagnosis | `/spec diagnose <task>` — record `diagnosis.recorded`, fix, re-review |
| `specd_append_event(work.completed)` | A `specGap` diagnosis has no later spec revision | Update the linked spec first: `specd_append_event(type="body.updated")` on it |
| `specd_append_event(diagnosis.recorded)` | Target is not an in-progress task | Diagnose only while the work is open |
| `ensurePlan` | Missing template fields/views | Owner creates the project from the Kanban template in the GitHub UI |

## Naming conventions

Every artifact follows conventional commits. The task's type (from its created payload, default `feat`) and scope (from its path scope) drive all names:

- Branch: `specd/{type}/{ref}-{slug}`
- Issue/PR title: `{type}({scope}): {title}` — subject starts lowercase
- Commits: `{type}({scope}): {subject}` — mandated in the worker brief
- No scope → `{type}: {subject}`

The `specd/` prefix on branches is the tool namespace. Do not remove it.

## Worker brief template

When spawning a worker subagent for `/spec run`, include:

1. The task title, body (acceptance criteria), and path scope
2. The linked spec's intent and acceptance criteria
3. The branch name (from `specd_create_worktree`)
4. The naming rules (conventional commits, PR title format)
5. Worker rules: implement only inside the path scope; commit to the branch; push; NEVER touch main; NEVER force-push; do NOT create the PR

## Reviewer brief template

When spawning a reviewer subagent, include:

1. The task's acceptance criteria
2. The diff range (base branch vs the task branch)
3. Instruction: return a verdict (`passed: true/false`) with findings

Record the verdict: `specd_append_event(item=<task>, type="review.completed", payload={passed: bool, findings: [...]})`

## The fix loop

When a review fails or CI goes red on a running task, run
`/spec diagnose <task-id> [symptom]` instead of fixing blindly:

1. Read the task, its linked spec, and the failing evidence (review findings, CI output).
2. Reproduce the failure until the symptom is precise.
3. Trace the root cause. Decide: is the code wrong, or the spec?
4. Record it: `specd_append_event(item=<task>, type="diagnosis.recorded", payload={symptom, rootCause, evidence: [...], specGap: bool})`
5. If `specGap: true` — revise the linked spec FIRST: `specd_append_event(item=<spec>, type="body.updated", payload={body})`, then tell the user what changed.
6. Fix surgically: every changed line traces to the diagnosis; add a regression test where feasible. Commit conventionally. The task stays in-progress.
7. Re-run the reviewer and record `review.completed`. Every new failure needs a fresh diagnosis — the gate refuses a passing review that doesn't answer the last failure.
8. After repeated failed cycles, stop and pause: `specd_append_event(item=<task>, type="work.paused")` — reassess the approach with the user.

Steps 4–5 are enforced in code, not in this guide. The refusal messages
name the exact missing piece.

## Scope collision

When the start gate refuses due to scope collision:
- Check which task is in-progress and what its scope is: `specd_read(view="show", item=<in-progress-task-id>)`
- If the current task's scope genuinely overlaps → the collision is correct. Wait for the other task to complete, or pause it.
- If the scopes don't actually overlap → the task may need an explicit path scope (unscoped tasks collide with everything). Ask the user for the correct scope, then `specd_append_event(item=<task>, type="body.updated", payload={path_scope: "..."})`.

## Multi-repo references

When the store has references to other stores (D11):

- `specd_read(view="query", store="all")` searches local + referenced stores
- Items from referenced stores are READ-ONLY — never append events to them
- `specd_read(view="show", item=<id>)` searches referenced stores when the item is not found locally, and annotates referenced items with their source store

## Error handling

When a tool returns an error:

1. Read the error message — it contains the reason and often the fix
2. Check the store state: `specd_read(view="show", item=<id>)` or `specd_read(view="dashboard")`
3. If the error is unexpected (not a gate refusal), report it to the user
4. Never silently retry or ignore errors

## What the agent should NEVER do

- Create items with retired kinds
- Bypass gates with direct SQL or file editing
- Force-push to main
- Create PRs from the worker (only after review passes)
- Write to referenced stores (read-only)
- Skip the store-location check on new repos
- Assume the store is in-repo without checking the registry
