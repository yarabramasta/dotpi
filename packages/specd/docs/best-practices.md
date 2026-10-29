# SDD Best Practices with specd

## When to use which depth

| Scenario | Use | Why |
|---|---|---|
| Bug fix, small feature | Fast-path | One spec, one plan, 1–2 tasks. The ladder is overkill. |
| New feature, unclear scope | Fast-path + explore | Research first, then commit to the spec. |
| Large feature, multiple components | Epic/roadmap | Decompose into ordered slices, implement one at a time. |
| Cross-repo change | Epic/roadmap | One spec describes behavior, multiple repos implement their slice. |

## Writing specs that actually work

1. **Separate what from how.** The spec answers "what are we building and why?" The plan answers "how are we building it?" If your spec mentions frameworks or databases, it's leaking implementation.

2. **Make requirements testable.** Each requirement should be verifiable. "The system returns a 401 response when the access token is expired" — not "the system should handle auth well."

3. **Acceptance criteria are the contract.** The reviewer checks the implementation against these. If they're vague, the review is vague. Write them like test assertions.

4. **Out of scope prevents scope creep.** Write what you're NOT building. It's the first thing the agent (and you) will forget.

5. **Answer the explore questions honestly.** The direction you give during explore seeds everything downstream. If you say "users are mobile-first," the agent will design for mobile. If you say "enterprise compliance matters," the architecture will reflect that.

## Gate discipline

The gates exist because AI agent compliance is unreliable. When a gate refuses:

1. **Don't work around it.** The refusal means the store state doesn't support the action yet.
2. **Fix the state, not the gate.** Approve the spec. Complete the checklist. Resolve the scope collision.
3. **Read the message.** It tells you exactly what's missing and why.

The gates are the value proposition — they prevent the agent from doing things out of order, which is the #1 failure mode of AI-assisted development.

## The review loop is your quality gate

The reviewer subagent reads the diff and checks it against the task's acceptance criteria. When it reports findings:

1. **Diagnose before fixing** — `/spec diagnose <task>` records the symptom, root cause, and whether the spec itself was wrong.
2. **Fix the blockers** (P0) before proceeding — these prevent merge.
3. **Address the suggestions** (lower priority) — they improve quality.
4. **Re-run the review** — only a passing review unlocks completion, and the gate requires a diagnosis after every failure. A blind retry is refused.
5. **Update the spec when the diagnosis says so** — a `specGap` finding means the requirement was wrong. Revise the spec before completing; fixes keep code and spec aligned, not code alone.

## Scope discipline

Each task has a `path_scope` — the files it's allowed to touch. This prevents:
- Two workers editing the same files simultaneously
- The agent making changes outside the task's intent
- Unreviewed changes sneaking into the PR

Keep scopes disjoint for parallel work. Use `[P]` markers for tasks that can run concurrently.

## Naming conventions

Everything follows conventional commits. This isn't cosmetic — it makes the git history scannable and the intent clear:

- Branch: `specd/feat/task-0001-add-login-route` — you know what it is before opening it
- PR: `feat(auth): add login route` — scannable in the PR list
- Commit: `feat(auth): add login route` — consistent with the PR

The `specd/` prefix on branches is the tool namespace — like `dependabot/` or `renovate/`. It tells you the branch was machine-managed, and enables the reset sweep to clean up after test cycles.

## The layer taxonomy

When capturing knowledge during explore, choose the right layer:

- **product** — things about the product itself: user stories, compliance, marketing, pricing
- **domain** — how the business works: use cases, flows, features (behavior, not implementation)
- **application** — how the code works: architecture, frameworks, data models, infrastructure

This taxonomy makes the knowledge searchable. When you're implementing a feature, you query the domain layer for behavior context and the application layer for technical context.

## Convergence

After implementation, run `/spec converge` to check for gaps. The convergence loop:

1. Assesses the implementation against the spec's acceptance criteria
2. Reports gaps as new tasks (append-only — it doesn't rewrite anything)
3. Reports `done: true` only when all gaps are closed

Run it after each slice to keep the epic honest.
