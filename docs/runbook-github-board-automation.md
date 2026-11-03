# GitHub board automation runbook

**Type:** How-to  
**Audience:** Operators connecting a specd cycle to a GitHub board  
**Scope:** Configure board-side automations so issues and PRs move through lanes without manual nudging.

specd creates issues and updates the **Status** field through the GitHub API, but three automations can only be enabled in the GitHub UI — GitHub exposes no API to manage them. Apply this runbook once per project.

## Hosting styles

- **Issues-only repo** (no project): tasks live as repo issues only. Board workflows do not apply; skip steps that mention the project.
- **GitHub Projects v2 board**: tasks are issues tracked inside the project. Enable all steps below.

## Prerequisites

- The repo is connected to specd via `/spec sink`.
- For Projects v2: a project created from the **Kanban** template.

## 1. Create the project from the Kanban template (Projects v2 only)

1. Go to **Projects → New project** in the repo or organization.
2. Select the **Kanban** template.
3. Save the project and note its number for `/spec sink`.

## 2. Enable the built-in workflows

These workflows are **UI-only**; GitHub provides no API to configure them.

1. Open the project board.
2. Click the **⋯** menu next to the view name → **Workflows**.
3. Under **Default workflows**, open each workflow and click **Edit**:
   - **Item closed → Done**
   - **Pull request merged → Done**
4. For each, click **Save and turn on workflow**.

What this does: when an issue is closed, its project item moves to **Done**; when a PR is merged, its linked item also moves to **Done**. This converges the board even when no agent session is running.

## 3. Configure the auto-add filter

Auto-add is also **UI-only**; GitHub provides no API for it.

1. In the project, open **⋯ → Workflows**.
2. Select **Auto-add to project** → **Edit**.
3. Enable the workflow and add a filter: `repo:<owner>/<name>` for each repository whose issues should enter this board.
4. Click **Save and turn on workflow**.

What this does: every issue specd creates in the filtered repos is added to the project automatically, usually in the board's default Status column.

## Verification

Run `/spec doctor`. The GitHub sink row should end with `Board-side automation runbook: docs/runbook-github-board-automation.md`. The agent checks API-reachable settings; confirm these UI-only workflows manually in **Project settings → Workflows**.

## Notes

- Workflows are configured **per project**.
- Auto-add filters match **per repository**; add every repo that exports tasks to the board.
- GitHub's built-in defaults are: issue/PR **closed** → **Done**, and PR **merged** → **Done**.
