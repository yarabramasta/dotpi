# specd — Spec-Driven Development for Pi

Turn your ideas into structured specs, break them into tasks, and execute
through an isolated, review-gated pipeline — all without leaving your pi
session or polluting your repo.

## The idea

Instead of vibe-coding every feature, you describe what to build, specd
guides you through a structured workflow (explore → spec → plan → tasks),
and then executes through an isolated pipeline: each task gets its own
git worktree, a worker implements it, a reviewer checks it against the
acceptance criteria, and only a passing review opens a pull request.

Everything lives in an event-sourced store — a SQLite database that tracks
every decision, every approval, every state transition. The store is the
audit trail. Nothing is committed to your repo unless you want it.

## Quick start

```sh
# in any repo, inside a pi session
/spec start "Add JWT authentication with refresh tokens"
```

specd will:
1. Ask if you want to research before committing (explore)
2. Interview you to create a spec — what you're building and why
3. Ask you to approve the spec
4. Interview you for the technical approach (plan)
5. Break it into tasks with clear scopes
6. Export them to your project board (or store them natively)

Then pick a task and execute:

```sh
/spec run task-0001
```

This creates an isolated worktree, spawns a worker to implement it,
spawns a reviewer to check it against the acceptance criteria, and opens
a PR — only after the review passes.

## The workflow

```
explore → spec → approve → plan → tasks → export → execute → review → done
              ↑                                          │
              └──────── converge (append gaps) ←─────────┘
```

Each stage is gated. The store refuses to export before the spec is
approved, refuses to start work before the checklist is reviewed, and
refuses to complete without a passing review. These aren't suggestions —
they're enforced by the store, not by the agent.

## Commands

| Command | What it does |
|---|---|
| `/spec start <idea>` | Start a full development cycle |
| `/spec run <task>` | Execute a task through the pipeline |
| `/spec clarify <spec>` | Sharpen an existing spec with targeted Q&A |
| `/spec plan <spec>` | Plan an approved spec |
| `/spec tasks <spec>` | Break an approved+planned spec into tasks |
| `/spec constitution` | Create or revisit the project's principles |
| `/spec analyze` | Check cross-artifact consistency |
| `/spec converge` | Find and append missing work |
| `/spec doctor` | Verify store integrity + sink readiness |
| `/spec sink` | Configure your project board |
| `/spec export` | Generate a session report |
| `/spec query` | Search items with filters and insights |

## The board

specd integrates with GitHub Projects. Create a project from the **Kanban**
template in the GitHub UI, then run `/spec sink` to connect it. specd
customizes the Status field to six workflow columns:

> **Backlog** → **Ready** → **In progress** → **In review** → **Done** → **Blocked**

Tasks move through these columns automatically as they progress through
the pipeline. Issues are created with conventional-commit titles
(`feat(auth): add login route`) and the `specd` label.

## The store

All items, events, and decisions live in `.spec/store.db` — a SQLite
database that's gitignored by default. The store is the single source of
truth: every approval, every rejection, every decision is recorded as an
append-only event.

You can inspect it at any time:

```sh
/spec doctor     # verify integrity
/spec query      # search items
```

Optionally, promote items to readable markdown files in the repo:

```sh
/spec storage md-inrepo
```

## Naming

Everything follows conventional commits. Branch names, PR titles, and
commit messages are derived from the task's type and scope:

- Branch: `specd/feat/task-0001-add-login-route`
- PR: `feat(auth): add login route`
- Commit: `feat(auth): add login route`

## Zero footprint

specd doesn't commit anything to your repo. The store is gitignored.
The markdown mirrors (if you enable them) live in `docs/specd/` or an
external directory. Your repo stays clean.

## Best practices

## Docs

| Doc | What it covers |
|---|---|
| [Tutorial](docs/tutorial.md) | Your first cycle — step-by-step from idea to merged PR |
| [Best practices](docs/best-practices.md) | SDD practices: depth choice, spec quality, gates, naming |
| [Prompt guide](docs/prompt-guide.md) | How to prompt effectively: commands, gates, querying |
| [Architecture](docs/architecture.md) | How specd works: event-sourced store, gates, zero footprint |
