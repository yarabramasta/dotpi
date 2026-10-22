import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runDoctor } from "./store/doctor.js";
import { openStore } from "./store/store.js";
import { dashboardContent } from "./tools.js";

const HELP = `# specd

Spec-driven development for this repo. Knowledge lives in .spec/store.db (SQLite, gitignored by default).

- /spec — current state of everything (default)
- /spec start <idea> — begin a development cycle (fast-path: spec → plan → tasks → export)
- /spec run <task-id> — run a task through the execution seam (one worker, one worktree, one PR)
- /spec pause — write the resume capsule for in-progress work
- /spec review <checklist-id> — reviewer pass over a requirements checklist
- /spec analyze [cycle-or-spec-id] — cross-artifact consistency review
- /spec doctor — store integrity audit
- /spec help — this text

The pipeline is agent-sequenced and code-gated: I (the agent) drive the stages, and the specd tools refuse anything the store state doesn't allow — like exporting tasks from an unapproved spec.`;

const START_PROMPT = (
	idea: string,
) => `Start a specd development cycle for this idea:

${idea}

Follow the fast-path flow. The specd tools enforce the gates — never work around them.

1. CYCLE — create it: specd_create_item(kind=cycle, title=<short idea>).
2. EXPLORE — ask me once: "any unknowns worth researching first?" If yes, run one web research query and record findings on the cycle: specd_append_event(item=<cycle id>, type=evidence.added, payload={finding}). Then record my decision: specd_append_event(item=<cycle id>, type=explore.decided, payload={decision:"go"|"needs-clarification"|"stop", reason}). A documented "stop" is a valid outcome and ends the cycle; "needs-clarification" loops through more research; only "go" reaches the next step — the tools refuse otherwise.
3. INTERVIEW — ask me targeted questions (use the ask-user-question tool) to fill this template:
   ## Intent
   ## Requirements (numbered, testable)
   ## Acceptance criteria
   ## Out of scope
4. SPEC — specd_create_item(kind=spec, title=…, body=<filled template>, cycle=<cycle id>) — the gate checks the explore decision and links the spec to the cycle.
5. APPROVAL — show me the finished spec and ask for approval. On yes: specd_append_event(item=<spec id>, type=spec.approved). Nothing can be exported before this — the tools will refuse.
6. PLAN — specd_create_item(kind=plan, title=…, body=<short technical approach>), then link it: specd_add_link(from=<plan id>, to=<spec id>, kind=part-of). Record each technical decision: specd_append_event(item=<plan id>, type=decision.made, payload={decision}). Also: if this repo has no constitution item yet, ask me whether to capture the product purpose and principles as one — specd_create_item(kind=constitution, title=…, body=…) — and link it: specd_add_link(from=<plan id>, to=<constitution id>, kind=part-of).
7. TASKS — break the spec into 1–3 tasks: specd_create_item(kind=task, title=…, body=<acceptance criteria>, path_scope=<file paths this task owns>) each, linked with specd_add_link(from=<task id>, to=<spec id>, kind=part-of). If the spec has meaningful ambiguity, also generate a requirements checklist: specd_create_item(kind=checklist, title=…, extra={items:[…]}), linked part-of the spec — I review it via /spec review before implementation runs.
8. EXPORT — ask me whether to export the tasks now. If yes: specd_export(item=<task id>, sink="github" or "null"). First github export needs the project owner and project number — ask me, then pass github_owner + github_project_number once; they persist.
9. RUN — when I want a task implemented: /spec run <task id>.`;

const RUN_PROMPT = (
	task: string,
) => `Run the task ${task} through the M1 execution seam:

1. specd_show(item=${task}) — read the task body (acceptance criteria), path scope, and the linked spec for context. If the history ends with work.paused, read that capsule and resume from it.
2. specd_append_event(item=${task}, type=work.started)
3. Branch name: specd/<task id>-<short-slug-of-title> (example: specd/task-0001-add-login-route).
4. Spawn ONE worker subagent (subagent tool, agent=worker, worktree=true) with a brief containing:
   - the task title, body (acceptance criteria), and path scope
   - the linked spec's intent and acceptance criteria
   - the branch name (the worktree is already isolated)
   - worker rules: implement only inside the path scope; commit to the branch; push the branch; open the PR with gh pr create (base = default branch); NEVER touch main; NEVER force-push; report the PR URL when done.
5. On worker completion: specd_append_event(item=${task}, type=pr.created, payload={url, branch}).
6. Self-check the PR against the task's acceptance criteria. If they pass: specd_append_event(item=${task}, type=work.completed, payload={pr}). If not: tell me exactly what is missing — merging is always my call.`;

const PAUSE_PROMPT = `Pause the active work: write the resume capsule. For each in-progress item, run specd_append_event(item=<item id>, type=work.paused, payload={decisions: […], openQuestions: […], evidence: […], nextStep: "…"}) — summarize from our conversation. Then confirm what was parked so I can pick it up later (or hand it off).`;

const REVIEW_PROMPT = (id: string) => `Review the requirements checklist ${id}:

1. specd_show(item=${id}) — read the checklist items and which are already checked.
2. Present each unchecked item to me (ask-user-question) and ask whether it passes as a requirements-quality criterion — is the requirement testable, unambiguous, complete?
3. For each item I approve: specd_append_event(item=${id}, type=checklist.item.checked, payload={index: <n>}). Checked items are reviewer decisions about requirements quality — they are NOT implementation work, and implementation is blocked while any remain unchecked.
4. When every item is checked, confirm the checklist is complete and offer the next step.`;

const ANALYZE_PROMPT = (
	scope: string,
) => `Run a cross-artifact consistency review${scope ? ` scoped to ${scope}` : " (whole store)"}:

1. specd_consistency(${scope ? `item=${scope}` : ""}) — the mechanical findings: coverage gaps, gate blockers, parallel path-scope overlaps. Report them verbatim first.
2. Semantic pass — read the spec, plan, and task bodies in scope and check for: contradictions between artifacts, duplicated requirements, ambiguous or untestable requirements, tasks whose path scope contradicts the plan, decisions made in the plan but absent from the spec.
3. Present everything grouped by severity (critical / warning / note) and propose a fix for each finding.
4. Fix at the SOURCE artifact only — a spec problem is fixed in the spec, never patched in a task; downstream artifacts get regenerated after a source fix. Ask me before rewriting anything.`;

function firstWord(args: string): string {
	return args.trim().split(/\s+/)[0] ?? "";
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("spec", {
		description:
			"Spec-driven development: start a cycle, run a task, current state, doctor",
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			const sub = firstWord(trimmed);
			const rest = trimmed.slice(sub.length).trim();
			if (sub === "help") {
				pi.sendMessage({
					customType: "specd-help",
					content: HELP,
					display: true,
				});
				return;
			}
			if (sub === "start") {
				let idea = rest;
				if (!idea && ctx.hasUI) {
					const edited = await ctx.ui.editor(
						"What should we build? (the cycle starts from this idea)",
						"",
					);
					if (!edited?.trim()) {
						ctx.ui.notify("Cancelled cycle start.", "info");
						return;
					}
					idea = edited.trim();
				}
				if (!idea) {
					ctx.ui.notify("Usage: /spec start <idea>", "warning");
					return;
				}
				pi.sendUserMessage(START_PROMPT(idea));
				return;
			}
			if (sub === "run") {
				const task = rest;
				if (!task) {
					ctx.ui.notify("Usage: /spec run <task-id>", "warning");
					return;
				}
				pi.sendUserMessage(RUN_PROMPT(task));
				return;
			}
			if (sub === "pause") {
				pi.sendUserMessage(PAUSE_PROMPT);
				return;
			}
			if (sub === "review") {
				const id = rest;
				if (!id) {
					ctx.ui.notify("Usage: /spec review <checklist-id>", "warning");
					return;
				}
				pi.sendUserMessage(REVIEW_PROMPT(id));
				return;
			}
			if (sub === "analyze") {
				pi.sendUserMessage(ANALYZE_PROMPT(rest));
				return;
			}
			try {
				const store = await openStore(ctx.cwd);
				if (sub === "doctor") {
					const findings = runDoctor(store);
					const text = findings.length
						? findings.map((f) => `- ${f.kind}: ${f.detail}`).join("\n")
						: "clean — the store matches its event history.";
					pi.sendMessage({
						customType: "specd-doctor",
						content: `# specd doctor\n\n${text}`,
						display: true,
					});
					return;
				}
				if (sub === "" || sub === "status" || sub === "dashboard") {
					pi.sendMessage({
						customType: "specd-dashboard",
						content: await dashboardContent(store),
						display: true,
					});
					return;
				}
				ctx.ui.notify(
					`Unknown /spec command: ${sub}. Try /spec help.`,
					"warning",
				);
			} catch (error) {
				ctx.ui.notify(
					`specd error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
