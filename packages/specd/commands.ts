import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ONBOARDING,
	readinessMatrix,
	SINK_IDS,
} from "./src/sinks/onboarding.js";
import { renderSessionReport, sessionReportFilename } from "./report.js";
import { runDoctor } from "./src/store/doctor.js";
import {
	readStorageConfig,
	STORAGE_MODES,
	type StorageMode,
	saveStorageConfig,
} from "./src/store/storage.js";
import { openStore } from "./src/store/store.js";
import { dashboardContent } from "./tools.js";

const HELP = `# specd

Spec-driven development for this repo. Knowledge lives in .spec/store.db (SQLite, gitignored by default).

- /spec — current state of everything (default)
- /spec start <idea> — begin a development cycle (fast-path: spec → plan → tasks → export)
- /spec run <task-id> — run a task through the execution seam (one worker, one worktree, reviewer-signed PR)
- /spec run — run all not-done tasks in parallel waves (specd_schedule: phase-ordered, scope-collision-serialized)
- /spec converge <spec-or-cycle-id> — convergence loop: assess gaps, append missing work, repeat until converged
- /spec pause — write the resume capsule for in-progress work
- /spec review <checklist-id> — reviewer pass over a requirements checklist
- /spec analyze [cycle-or-spec-id] — cross-artifact consistency review
- /spec sink — configure the sink: workspace coords, lanes, statusMap (preview then apply)
- /spec constitution — create/review/update the constitution standalone
- /spec clarify <spec-id> — targeted clarification loop on an existing spec
- /spec plan <spec-id> — plan an approved spec (interview → plan item → decisions)
- /spec tasks <spec-id> — break an approved+planned spec into tasks
- /spec storage [mode [path]] — show or set the storage mode (db-only | md-inrepo | md-external <path>); specd_promote writes md mirrors per mode
- /spec connect github — guided onboarding for the github sink
- /spec doctor — store integrity audit + sink readiness matrix
- /spec export [path] — write a self-contained HTML report of the store (items, event timelines, links, doctor) for handoff
- /spec help — this text

The pipeline is agent-sequenced and code-gated: I (the agent) drive the stages, and the specd tools refuse anything the store state doesn't allow — like exporting tasks from an unapproved spec.`;

const START_PROMPT = (
	idea: string,
) => `Start a specd development cycle for this idea:

${idea}

Follow the fast-path flow. The specd tools enforce the gates — never work around them.

0. STORE CHECK — call specd_store_status. If a store exists, continue. If not, ask me where it should live (ask-user-question): External specd-managed (zero footprint, register with specd_register_store type=external storePath=~/.pi/agent/stores/{repo-name}) · External git repo (shareable, type=external-git) · In this repo (.spec/ gitignored, the default) · In this repo (.spec/ committed, type=in-repo). Then add .spec/ to .gitignore if in-repo and gitignored.

1. CYCLE — create it: specd_create_item(kind=cycle, title=<short idea>).
2. EXPLORE — ask me once: "any unknowns worth researching first?" If yes, run one web research query and record findings on the cycle: specd_append_event(item=<cycle id>, type=evidence.added, payload={finding}). Then record my decision: specd_append_event(item=<cycle id>, type=explore.decided, payload={decision:"go"|"needs-clarification"|"stop", reason}). A documented "stop" is a valid outcome and ends the cycle; "needs-clarification" loops through more research; only "go" reaches the next step — the tools refuse otherwise.
3. INTERVIEW — first ask me how deep this cycle should go: fast-path (default: one spec → plan → 1–3 tasks) or the epic/roadmap ladder (for big multi-slice efforts: specd_create_item kind=epic → kind=roadmap linked part-of it → ordered per-slice specs linked part-of the roadmap — record slice order with specd_add_link kind=depends-on → then plan+tasks per slice; /spec analyze will check the ladder). Then ask me targeted questions (use the ask-user-question tool) to fill this template:
   ## Intent
   ## Requirements (numbered, testable)
   ## Acceptance criteria
   ## Out of scope
4. SPEC — specd_create_item(kind=spec, title=…, body=<filled template>, cycle=<cycle id>) — the gate checks the explore decision and links the spec to the cycle.
5. APPROVAL — show me the finished spec and ask for approval. On yes: specd_append_event(item=<spec id>, type=spec.approved). Nothing can be exported before this — the tools will refuse.
6. PLAN — specd_create_item(kind=plan, title=…, body=<short technical approach>), then link it: specd_add_link(from=<plan id>, to=<spec id>, kind=part-of). Record each technical decision: specd_append_event(item=<plan id>, type=decision.made, payload={decision}). Also: if this repo has no constitution item yet, ask me whether to capture the product purpose and principles as one — specd_create_item(kind=constitution, title=…, body=…) — and link it: specd_add_link(from=<plan id>, to=<constitution id>, kind=part-of). If a constitution already exists, link the plan to it — consistency checks every plan for a constitution anchor.
7. SINK SETUP — if the sink is not null, interview me once for the sink setup (ask-user-question): workspace coords (github: owner + project number), lanes, label taxonomy, naming convention. Then specd_configure_sink(sink=…, workspace={…} for non-github sinks, github_owner=…, github_project_number=…, lanes=[…], labels=[…], naming=…). This previews what would change. Show me the preview, and on my OK re-run with apply=true — it is idempotent, so re-runs converge. If the sink is null, skip this step.
VALID ITEM KINDS: spec · plan · task · cycle · epic · roadmap · constitution · checklist · product (product-layer knowledge) · domain (business & domain knowledge) · application (technical knowledge). The knowledge kind is retired — use the layer kinds instead.

8. TASKS — break the spec into 1–3 tasks: specd_create_item(kind=task, title=…, body=<acceptance criteria>, path_scope=<file paths this task owns>, extra={type:'feat'|'fix'|'chore'|'docs'|'test'|'refactor'|'perf'}) each — the conventional type drives branch/issue/PR/commit naming — linked with specd_add_link(from=<task id>, to=<spec id>, kind=part-of). If the spec has meaningful ambiguity, also generate a requirements checklist: specd_create_item(kind=checklist, title=…, extra={items:[…]}), linked part-of the spec — I review it via /spec review before implementation runs.
9. EXPORT — ask me whether to export the tasks now. If yes: specd_export(item=<task id>, sink=<sink id>). Ported sinks: null, github. For github the first export needs the project owner and project number — ask me, then pass github_owner + github_project_number once; they persist. The sink setup (if applied) drives the export title, labels, and lane placement.
10. RUN — when I want a task implemented: /spec run <task id>.`;

const CONSTITUTION_PROMPT = `Create/review/update the constitution (the product layer's anchor):

1. specd_query(kind="constitution") — check if one exists.
2. If none: interview me for the product purpose + principles, then specd_create_item(kind="constitution", title=…, body=…).
3. If one exists: show it, ask what to change (principles, purpose, scope), record specd_append_event(item=<id>, type="body.updated", payload={body: <revised>}).
4. Re-check: specd_consistency() — every plan should anchor to the constitution.

The constitution IS the product layer's anchor — product-layer knowledge items (kind=product) inform it; it governs all plans.`;

const CLARIFY_PROMPT = (
	specId: string,
) => `Targeted clarification loop on the spec ${specId}:

1. specd_show(item=${specId}) — read the current spec body and its event history.
2. Ask me which focus area to clarify (scope boundary, acceptance criteria, requirements, out of scope) or accept free-form questions.
3. For each answer: specd_append_event(item=${specId}, type="body.updated", payload={body: <revised spec body>}) — the spec body evolves in place.
4. Record significant answers as evidence: specd_append_event(item=${specId}, type="evidence.added", payload={finding: "…"}).
5. Re-run specd_consistency(item=${specId}) to verify alignment.
6. If the spec was already approved and the meaning changed materially: specd_append_event(item=${specId}, type="spec.reopened"), revise, then re-approve.

The spec stays the source of truth — clarify sharpens it, never overwrites it.`;

const PLAN_ENTRY_PROMPT = (
	specId: string,
) => `Plan the approved spec ${specId} (standalone re-entry):

1. specd_show(item=${specId}) — verify it is approved (the gates require it before tasks can export).
2. Interview me for the technical approach: core language/framework, data model, architecture constraints, dependencies.
3. specd_create_item(kind="plan", title=…, body=<technical approach>) linked part-of ${specId}.
4. Record each technical decision: specd_append_event(item=<plan id>, type="decision.made", payload={decision}).
5. If no constitution exists yet, ask me whether to create one — specd_create_item(kind="constitution", …) — and link it part-of the plan.
6. Offer the next step: /spec tasks <plan-id> or /spec run <task-id>.`;

const TASKS_ENTRY_PROMPT = (
	specId: string,
) => `Break the approved+planned spec ${specId} into tasks:

1. specd_show(item=${specId}) — verify it is approved and has a linked plan.
2. Interview me for the task breakdown: what are the 1–3 work items, their conventional types (feat/fix/chore/docs), path scopes, and [P] parallel markers?
3. specd_create_item(kind="task", title=…, body=<acceptance criteria>, path_scope=…, extra={type:"feat"}) each, linked part-of ${specId}.
4. Verify with specd_schedule(spec=${specId}) — waves, parallelism, serialization.
5. Offer export: specd_export(item=<task id>, sink=…) for each task.

The gates enforce ordering: no export before approval, no run before review. The tasks carry the conventional type for naming.`;

const RUN_PROMPT = (
	task: string,
) => `Run the task ${task} through the execution seam (checklist-gated, reviewer-signed):

1. specd_show(item=${task}) — read the task body (acceptance criteria), path scope, and the linked spec for context. If the history ends with work.paused, read that capsule and resume from it.
2. specd_create_worktree(item=${task}) — get the isolated worktree path and convention branch (specd/<task-id>-<slug>). Never reuse another task's worktree.
3. specd_append_event(item=${task}, type=work.started) — the tool refuses if a requirements checklist is not fully reviewed or another in-progress task claims an overlapping path scope. Do not work around refusals.
4. Spawn ONE worker subagent (subagent tool, agent=worker) in the worktree cwd with a brief containing:
   - the task title, body (acceptance criteria), and path scope
   - the linked spec's intent and acceptance criteria
   - the branch name
   - NAMING (conventional commits, honored everywhere): the task's type (feat/fix/chore/docs/test/refactor/perf — from its created payload, default feat) and scope (from its path scope) drive every name. Commit messages AND the eventual PR title MUST be 'type(scope): subject' with the subject stating the goal and starting lowercase (e.g. 'feat(auth): add login route'); no scope → 'type: subject'.
   - worker rules: implement only inside the path scope; commit to the branch; push the branch; NEVER touch main; NEVER force-push; do NOT create the PR — report the pushed branch when done.
5. REVIEW GATE: spawn ONE reviewer subagent (read-only) over the worktree diff (default branch vs the task branch) against the task's acceptance criteria and the spec. Record its verdict: specd_append_event(item=${task}, type=review.completed, payload={passed: true|false, findings: [...]}).
6. If the review passed: from the worktree run gh pr create (base = default branch) and record specd_append_event(item=${task}, type=pr.created, payload={url, branch}). If it failed: tell me exactly what failed — fix, re-review, and only then PR; completion is blocked until a review passes.
7. When a PR exists and its review passed: specd_append_event(item=${task}, type=work.completed, payload={pr}) — the tool refuses without a passing review.`;

const RUN_WAVES_PROMPT = `Run tasks through the execution seam in parallel waves:

1. specd_schedule() — the wave plan: tasks ordered by phase (setup → foundational → story → polish), [P]-marked tasks with disjoint path scopes share a wave, collisions are serialized into later waves. Show me the plan.
2. For each wave in order: run its tasks CONCURRENTLY — one full flow per task (worktree → work.started → worker → review gate → PR → work.completed), each with its own worktree and branch; the tools serialize any scope collision.
3. Between waves, check the dashboard: failed or paused tasks are surfaced to me before the next wave starts.`;

const CONVERGE_PROMPT = (
	scope: string,
) => `Run a convergence assessment for ${scope} (append-only; fixes at source):

1. specd_show(item=${scope}) and list its tasks with statuses (specd_dashboard). Mechanical pass: specd_consistency(item=${scope}).
2. Assess gaps: requirements in the spec with no covering task, tasks not done, work discovered during execution that the spec now implies, decisions that contradict the spec.
3. For each real gap, create the missing work: specd_create_item(kind=task, …) linked part-of the spec — new work is APPENDED, never silently folded into existing tasks.
4. Record the assessment: specd_append_event(item=${scope}, type=convergence.assessed, payload={done: true|false, gaps: [...]}).
5. Report "converged" only when every gap is closed (all tasks done, no uncovered requirements). Otherwise loop: run the new tasks (/spec run), then converge again.`;

const SINK_PROMPT = `Configure the sink (workspace coords, lanes, labels, naming, statusMap):

1. Ask me which sink to plan for (null = native; github). If null, there is nothing to plan — the null sink has no external board.
2. Workspace coords per sink: github — owner + project number. Ask me (ask-user-question) for the coords plus lanes, label taxonomy, and naming convention. Offer the defaults if I don't override. Also set the statusMap: ask which board option each specd state maps to (exported / in-progress / done → e.g. Ready / In progress / Done) and pass statusMap={…} to specd_configure_sink — updateStatus writes exactly the mapped option. 
3. specd_configure_sink(sink=…, github_owner=…, github_project_number=…, workspace={…} for non-github sinks, lanes=[…], labels=[…], naming=…) — this is a PREVIEW (read-only). Show me the listed changes.
4. On my OK: re-run with apply=true. It is idempotent — re-runs converge, so a converged plan yields no changes.
5. Record the decision: specd_append_event(item=<cycle or first item id>, type=decision.made, payload={decision: "sink setup applied", sink, lanes, labels, naming}).`;

const PAUSE_PROMPT = `Pause the active work: write the resume capsule. For each in-progress item, run specd_append_event(item=<item id>, type=work.paused, payload={decisions: […], openQuestions: […], evidence: […], nextStep: "…"}) — summarize from our conversation. Then confirm what was parked so I can pick it up later (or hand it off).`;

/** Onboarding flow for one sink, rendered from the registry so the guided
 * prompt is the single source of the steps (design §4.6). */
function connectPrompt(id: string): string {
	const ob = ONBOARDING[id];
	if (!ob) {
		return `Unknown sink "${id}". Known sinks: ${SINK_IDS.join(", ")}.`;
	}
	const envNames = Object.keys(ob.envVars);
	const env = envNames.length
		? `\n**Env var(s) you own (never paste their values here):** ${envNames.join(", ")} — or the equivalent ~/.pi/agent/auth.json section (no pi restart needed).`
		: "";
	const ported = ob.ported
		? ""
		: `\n\nNote: this sink's adapter port is not built yet (M2c). Onboarding still works — the doctor matrix will confirm the credential is present, and full verification lands with the port.\n\n**Parity (what the port will map):** ${ob.parity}`;
	return `Connect the ${ob.name} sink to specd:

**Credential:** ${ob.credentialUrl}
**Scopes:** ${ob.scopes}${env}

Steps:
${ob.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}${ported}

Rules: credentials live only in my shell environment — never write them into the repo, the store, or this conversation.`;
}

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
				if (!rest) {
					pi.sendUserMessage(RUN_WAVES_PROMPT);
					return;
				}
				const task = rest;
				pi.sendUserMessage(RUN_PROMPT(task));
				return;
			}
			if (sub === "converge") {
				const scope = rest;
				if (!scope) {
					ctx.ui.notify("Usage: /spec converge <spec-or-cycle-id>", "warning");
					return;
				}
				pi.sendUserMessage(CONVERGE_PROMPT(scope));
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
			if (sub === "constitution") {
				pi.sendUserMessage(CONSTITUTION_PROMPT);
				return;
			}
			if (sub === "clarify") {
				if (!rest) {
					ctx.ui.notify("Usage: /spec clarify <spec-id>", "warning");
					return;
				}
				pi.sendUserMessage(CLARIFY_PROMPT(rest));
				return;
			}
			if (sub === "plan") {
				if (!rest) {
					ctx.ui.notify("Usage: /spec plan <spec-id>", "warning");
					return;
				}
				pi.sendUserMessage(PLAN_ENTRY_PROMPT(rest));
				return;
			}
			if (sub === "tasks") {
				if (!rest) {
					ctx.ui.notify("Usage: /spec tasks <spec-id>", "warning");
					return;
				}
				pi.sendUserMessage(TASKS_ENTRY_PROMPT(rest));
				return;
			}
			if (sub === "sink") {
				pi.sendUserMessage(SINK_PROMPT);
				return;
			}
			if (sub === "connect") {
				const id = rest;
				if (!id) {
					ctx.ui.notify(
						`Usage: /spec connect <sink> — known sinks: ${SINK_IDS.join(", ")}.`,
						"warning",
					);
					return;
				}
				pi.sendMessage({
					customType: "specd-connect",
					content: connectPrompt(id),
					display: true,
				});
				return;
			}
			if (sub === "import") {
				const mode = firstWord(rest);
				const source = rest.slice(mode.length).trim();
				if (!source) {
					ctx.ui.notify(
						"Usage: /spec import <preview|apply> <source-repo-path>",
						"warning",
					);
					return;
				}
				if (mode === "preview") {
					pi.sendUserMessage(
						`Run specd_import_preview(source=${JSON.stringify(source)}) and summarize what would be imported.`,
					);
				} else if (mode === "apply") {
					pi.sendUserMessage(
						`Run specd_import_apply(source=${JSON.stringify(source)}, apply=true). Confirm idempotency by re-running the preview after.`,
					);
				} else if (mode === "revert") {
					pi.sendUserMessage(
						`Run specd_import_revert() to list known import batches, show me the list, and revert only the batch I name (specd_import_revert(batch=<id>)). After reverting, run /spec doctor to confirm the store is clean.`,
					);
				} else {
					ctx.ui.notify(
						`Usage: /spec import <preview|apply> <source-repo-path> — got mode "${mode}".`,
						"warning",
					);
				}
				return;
			}
			try {
				const store = await openStore(ctx.cwd);
				if (sub === "doctor") {
					const findings = runDoctor(store);
					const text = findings.length
						? findings.map((f) => `- ${f.kind}: ${f.detail}`).join("\n")
						: "clean — the store matches its event history.";
					const matrix = await readinessMatrix(store);
					pi.sendMessage({
						customType: "specd-doctor",
						content: `# specd doctor\n\n${text}\n\n${matrix}`,
						display: true,
					});
					return;
				}
				if (sub === "storage") {
					const mode = firstWord(rest);
					if (!mode) {
						const config = readStorageConfig(store);
						pi.sendMessage({
							customType: "specd-storage",
							content: `Storage mode: **${config.mode}**${config.mdPath ? ` (${config.mdPath})` : ""}\n\n- db-only — md promotion off (default)\n- md-inrepo — md mirrors under docs/specd/ in this repo\n- md-external <path> — md mirrors in a directory outside the repo\n\nPromotion surface: the specd_promote tool (write/remove an item's md mirror).`,
							display: true,
						});
						return;
					}
					if (!STORAGE_MODES.includes(mode as StorageMode)) {
						ctx.ui.notify(
							`Unknown storage mode: ${mode}. Valid: ${STORAGE_MODES.join(", ")}.`,
							"warning",
						);
						return;
					}
					const mdPath = rest.slice(mode.length).trim() || undefined;
					if (mode === "md-external" && !mdPath) {
						ctx.ui.notify("Usage: /spec storage md-external <path>", "warning");
						return;
					}
					saveStorageConfig(store, { mode: mode as StorageMode, mdPath });
					ctx.ui.notify(
						`Storage mode set to ${mode}${mdPath ? ` (${mdPath})` : ""}.`,
						"info",
					);
					return;
				}
				if (sub === "export") {
					const target = rest || join(ctx.cwd, sessionReportFilename());
					const html = renderSessionReport(store);
					writeFileSync(target, html, "utf8");
					pi.sendMessage({
						customType: "specd-export",
						content: `Session report written: ${target}\n\npi's own conversation export covers the chat side — run it from the session as well when handing both to another agent.`,
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
