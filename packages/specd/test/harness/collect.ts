import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ADOPT_SNIPPET,
	ANALYZE_PROMPT,
	CLARIFY_PROMPT,
	CONSTITUTION_PROMPT,
	CONVERGE_PROMPT,
	connectPrompt,
	DIAGNOSE_PROMPT,
	HELP,
	PAUSE_PROMPT,
	PLAN_ENTRY_PROMPT,
	REVIEW_PROMPT,
	RUN_PROMPT,
	RUN_WAVES_PROMPT,
	SINK_PROMPT,
	START_PROMPT,
	TASKS_ENTRY_PROMPT,
} from "../../src/commands/prompts.js";
import {
	checkCanCompleteWork,
	checkCanStartWork,
	checkChecklistsClear,
	checkDiagnosisTarget,
	checkExport,
	checkSpecCreation,
	type GateCheck,
} from "../../src/pipeline/gates.js";
import {
	addLink,
	appendEvent,
	createItem,
	history,
	type SpecdStore,
} from "../../src/store/store.js";
import { registerSpecdTools } from "../../src/tools/index.js";
import { makeStore } from "../helpers.js";

/** Token-efficiency harness, static layer (D6/D8): measures where specd
 * spends LLM tokens WITHOUT running a model. Every number is a coarse
 * estimate (UTF-8 bytes, ~4 chars/token heuristic) — the point is the
 * before/after delta across phases, not the absolute value. */

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** ~4 chars/token — honest order-of-magnitude heuristic, labeled as est. */
export const estTokens = (bytes: number): number => Math.round(bytes / 4);

export interface CapturedToolDef {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	parameters?: unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

/** Capture every tool definition specd registers by handing the real
 * registrars a fake pi — no live extension host needed. */
export function captureToolDefs(): CapturedToolDef[] {
	const defs: CapturedToolDef[] = [];
	const fakePi = {
		registerTool(def: CapturedToolDef) {
			defs.push(def);
		},
	} as unknown as ExtensionAPI;
	registerSpecdTools(fakePi);
	return defs;
}

export interface ToolMeasure {
	name: string;
	schemaBytes: number;
	schemaTokensEst: number;
	descriptionBytes: number;
}

export interface ToolSurfaceMeasures {
	count: number;
	totalSchemaBytes: number;
	totalSchemaTokensEst: number;
	totalDescriptionBytes: number;
	perTool: ToolMeasure[];
}

/** Wire-ish schema cost per tool: name + description + parameters JSON —
 * the upper bound of what a tool announcement re-sends every turn. The
 * description share is the T1-trimmable part. */
export function measureTools(
	defs: CapturedToolDef[] = captureToolDefs(),
): ToolSurfaceMeasures {
	const perTool = defs
		.map((d): ToolMeasure => {
			const wire = JSON.stringify({
				name: d.name,
				description: d.description,
				parameters: d.parameters,
			});
			const schemaBytes = utf8Bytes(wire);
			return {
				name: d.name,
				schemaBytes,
				schemaTokensEst: estTokens(schemaBytes),
				descriptionBytes: utf8Bytes(d.description ?? ""),
			};
		})
		.sort((a, b) => b.schemaBytes - a.schemaBytes);
	const totalSchemaBytes = perTool.reduce((n, t) => n + t.schemaBytes, 0);
	return {
		count: perTool.length,
		totalSchemaBytes,
		totalSchemaTokensEst: estTokens(totalSchemaBytes),
		totalDescriptionBytes: perTool.reduce((n, t) => n + t.descriptionBytes, 0),
		perTool,
	};
}

/** One-shot prompt sizes per command template, with realistic sample args. */
export function measurePrompts(): Record<string, number> {
	const samples: Array<[string, string]> = [
		["HELP", HELP],
		["ADOPT_SNIPPET", ADOPT_SNIPPET],
		[
			"START_PROMPT",
			START_PROMPT("Build a token-efficiency harness for the specd extension"),
		],
		["CONSTITUTION_PROMPT", CONSTITUTION_PROMPT],
		["CLARIFY_PROMPT", CLARIFY_PROMPT("spec-0001")],
		["PLAN_ENTRY_PROMPT", PLAN_ENTRY_PROMPT("spec-0001")],
		["TASKS_ENTRY_PROMPT", TASKS_ENTRY_PROMPT("spec-0001")],
		["RUN_PROMPT", RUN_PROMPT("task-0001")],
		["DIAGNOSE_PROMPT", DIAGNOSE_PROMPT("task-0001", "login test fails")],
		["RUN_WAVES_PROMPT", RUN_WAVES_PROMPT],
		["CONVERGE_PROMPT", CONVERGE_PROMPT("spec-0001")],
		["SINK_PROMPT", SINK_PROMPT],
		["PAUSE_PROMPT", PAUSE_PROMPT],
		["REVIEW_PROMPT", REVIEW_PROMPT("checklist-0001")],
		["ANALYZE_PROMPT", ANALYZE_PROMPT("spec-0001")],
		["CONNECT_PROMPT_GITHUB", connectPrompt("github")],
	];
	return Object.fromEntries(
		samples.map(([name, prompt]) => [name, utf8Bytes(prompt)]),
	);
}

const SPEC_BODY = `## Intent
Add a login route so returning users get a session.

## Requirements
1. POST /login accepts email + password and returns 200 with a session cookie on success.
2. Invalid credentials return 401 without revealing which field failed.
3. Sessions persist across server restarts (sqlite-backed).
4. Rate limiting: 5 failed attempts per email per 15 minutes returns 429.

## Acceptance criteria
- POST /login with valid credentials sets the session cookie and returns the user id.
- POST /login with a wrong password returns 401 and does not set a cookie.
- Restarting the server keeps existing sessions valid.
- The 6th failed attempt within 15 minutes returns 429.

## Out of scope
OAuth, password reset, email verification.`;

const TASK_BODY = `Acceptance criteria:
- POST /login with valid credentials sets the session cookie and returns the user id.
- POST /login with a wrong password returns 401 and does not set a cookie.
- Restarting the server keeps existing sessions valid.`;

/** Seed a realistic cycle → spec → plan → task (+ checklist) store used by
 * both the payload curve and the refusal matrix. */
export function seedSpecdStore(store: SpecdStore): {
	specId: string;
	taskId: string;
	checklistId: string;
} {
	const cycle = createItem(store, {
		kind: "cycle",
		title: "Login route",
		body: "Cycle for the login route slice.",
		actor: "harness",
	});
	appendEvent(store, {
		item: cycle.id,
		type: "explore.decided",
		actor: "harness",
		payload: { decision: "go", reason: "no unknowns worth researching" },
	});
	const spec = createItem(store, {
		kind: "spec",
		title: "Login route",
		body: SPEC_BODY,
		actor: "harness",
	});
	addLink(store, spec.id, cycle.id, "part-of");
	appendEvent(store, {
		item: spec.id,
		type: "spec.approved",
		actor: "harness",
	});
	const plan = createItem(store, {
		kind: "plan",
		title: "Login route plan",
		body: "Express route + sqlite sessions table; no new deps.",
		actor: "harness",
	});
	addLink(store, plan.id, spec.id, "part-of");
	appendEvent(store, {
		item: plan.id,
		type: "decision.made",
		actor: "harness",
		payload: { decision: "sqlite-backed sessions, no external deps" },
	});
	const task = createItem(store, {
		kind: "task",
		title: "Add login route",
		body: TASK_BODY,
		pathScope: "src/auth/**",
		actor: "harness",
	});
	addLink(store, task.id, spec.id, "part-of");
	const checklist = createItem(store, {
		kind: "checklist",
		title: "Login requirements checklist",
		actor: "harness",
		extra: {
			items: ["rate limit is testable", "session persistence is testable"],
		},
	});
	addLink(store, checklist.id, spec.id, "part-of");
	return { specId: spec.id, taskId: task.id, checklistId: checklist.id };
}

async function runToolText(
	def: CapturedToolDef | undefined,
	params: Record<string, unknown>,
	cwd: string,
): Promise<string> {
	if (!def) throw new Error("harness: tool def missing");
	const res = await def.execute("harness", params, undefined, undefined, {
		cwd,
	} as unknown as ExtensionContext);
	return res.content[0]?.text ?? "";
}

export interface PayloadMeasures {
	show: { events5: number; events20: number; events40: number };
	dashboard: number;
	queryInsight: number;
}

/** specd_show payload growth curve on a seeded store: the tool renders one
 * history line per event with no cap, so cost grows with the diagnosis /
 * review loop. dashboard + query insight measured once on the same store. */
export async function measurePayloads(): Promise<PayloadMeasures> {
	const t = await makeStore();
	try {
		const { taskId } = seedSpecdStore(t.store);
		const defs = captureToolDefs();
		const show = defs.find((d) => d.name === "specd_show");
		const dashboard = defs.find((d) => d.name === "specd_dashboard");
		const query = defs.find((d) => d.name === "specd_query");

		const filler = (i: number) => ({
			item: taskId,
			type: "evidence.added" as const,
			actor: "harness",
			payload: {
				finding: `Evidence point ${i}: verification run and observation notes for the fix loop (entry ${i}).`,
			},
		});

		// Seeded task history: created + work.started. Grow to 5/20/40.
		appendEvent(t.store, {
			item: taskId,
			type: "work.started",
			actor: "harness",
		});
		const growTo = async (target: number) => {
			const current = history(t.store, taskId).length;
			for (let i = current; i < target; i++) {
				appendEvent(t.store, filler(i));
			}
		};
		const showBytes = async () =>
			utf8Bytes(await runToolText(show, { item: taskId }, t.dir));

		await growTo(5);
		const events5 = await showBytes();
		await growTo(20);
		const events20 = await showBytes();
		await growTo(40);
		const events40 = await showBytes();
		const dashboardBytes = utf8Bytes(await runToolText(dashboard, {}, t.dir));
		const queryBytes = utf8Bytes(
			await runToolText(query, { kind: "task", insight: true }, t.dir),
		);
		return {
			show: { events5, events20, events40 },
			dashboard: dashboardBytes,
			queryInsight: queryBytes,
		};
	} finally {
		t.cleanup();
	}
}

export interface RefusalRow {
	gate: string;
	scenario: string;
	ok: boolean;
	reason: string;
}

const record = (
	rows: RefusalRow[],
	gate: string,
	scenario: string,
	check: GateCheck,
): void => {
	rows.push({ gate, scenario, ok: check.ok, reason: check.reason ?? "" });
};

/** Gate refusal matrix on fixture stores: the ok-flags are the behavioral
 * baseline ("gates refuse what they refused before"); reasons are recorded
 * for eyeballing, not gated — T1 deliberately rewords them. */
export async function measureRefusals(): Promise<RefusalRow[]> {
	const rows: RefusalRow[] = [];

	// --- export gate ---
	{
		const t = await makeStore();
		try {
			const { specId, taskId } = seedSpecdStore(t.store);
			appendEvent(t.store, {
				item: specId,
				type: "spec.approved",
				actor: "harness",
			});
			record(
				rows,
				"export",
				"task linked to approved spec",
				checkExport(t.store, taskId),
			);
			const unapproved = createItem(t.store, {
				kind: "spec",
				title: "Unapproved spec",
				body: SPEC_BODY,
				actor: "harness",
			});
			const task2 = createItem(t.store, {
				kind: "task",
				title: "Task on unapproved spec",
				body: TASK_BODY,
				pathScope: "src/login/**",
				actor: "harness",
			});
			addLink(t.store, task2.id, unapproved.id, "part-of");
			record(
				rows,
				"export",
				"task linked to unapproved spec",
				checkExport(t.store, task2.id),
			);
			const orphan = createItem(t.store, {
				kind: "task",
				title: "Orphan task",
				body: TASK_BODY,
				pathScope: "src/orphan/**",
				actor: "harness",
			});
			record(
				rows,
				"export",
				"task without spec link",
				checkExport(t.store, orphan.id),
			);
		} finally {
			t.cleanup();
		}
	}

	// --- spec-creation gate ---
	{
		const t = await makeStore();
		try {
			record(
				rows,
				"spec-creation",
				"no cycle",
				checkSpecCreation(t.store, undefined),
			);
			const cycle = createItem(t.store, {
				kind: "cycle",
				title: "Cycle without decision",
				body: "No explore decision yet.",
				actor: "harness",
			});
			record(
				rows,
				"spec-creation",
				"cycle without explore decision",
				checkSpecCreation(t.store, cycle.id),
			);
			appendEvent(t.store, {
				item: cycle.id,
				type: "explore.decided",
				actor: "harness",
				payload: { decision: "go", reason: "researched" },
			});
			record(
				rows,
				"spec-creation",
				"cycle with go decision",
				checkSpecCreation(t.store, cycle.id),
			);
		} finally {
			t.cleanup();
		}
	}

	// --- start-work gate ---
	{
		const t = await makeStore();
		try {
			const { specId, taskId, checklistId } = seedSpecdStore(t.store);
			appendEvent(t.store, {
				item: specId,
				type: "spec.approved",
				actor: "harness",
			});
			record(
				rows,
				"start-work",
				"unknown task",
				checkCanStartWork(t.store, "task-9999"),
			);
			record(
				rows,
				"start-work",
				"non-task item",
				checkCanStartWork(t.store, specId),
			);
			record(
				rows,
				"start-work",
				"unchecked checklist on linked spec",
				checkCanStartWork(t.store, taskId),
			);
			// reviewer clears the checklist, then the start gate opens
			appendEvent(t.store, {
				item: checklistId,
				type: "checklist.item.checked",
				actor: "reviewer",
				payload: { index: 0 },
			});
			appendEvent(t.store, {
				item: checklistId,
				type: "checklist.item.checked",
				actor: "reviewer",
				payload: { index: 1 },
			});
			record(
				rows,
				"start-work",
				"all checklist items checked, no overlap",
				checkCanStartWork(t.store, taskId),
			);
		} finally {
			t.cleanup();
		}
	}

	// --- start-work gate: overlap + clear (fresh store) ---
	{
		const t = await makeStore();
		try {
			const { specId } = seedSpecdStore(t.store);
			appendEvent(t.store, {
				item: specId,
				type: "spec.approved",
				actor: "harness",
			});
			const first = createItem(t.store, {
				kind: "task",
				title: "First in-flight task",
				body: TASK_BODY,
				pathScope: "src/**",
				actor: "harness",
			});
			addLink(t.store, first.id, specId, "part-of");
			appendEvent(t.store, {
				item: first.id,
				type: "work.started",
				actor: "harness",
			});
			const clashing = createItem(t.store, {
				kind: "task",
				title: "Overlapping task",
				body: TASK_BODY,
				pathScope: "src/auth/**",
				actor: "harness",
			});
			addLink(t.store, clashing.id, specId, "part-of");
			record(
				rows,
				"start-work",
				"overlapping in-progress task",
				checkCanStartWork(t.store, clashing.id),
			);
			const clear = createItem(t.store, {
				kind: "task",
				title: "Disjoint task",
				body: TASK_BODY,
				pathScope: "docs/**",
				actor: "harness",
			});
			addLink(t.store, clear.id, specId, "part-of");
			record(
				rows,
				"start-work",
				"disjoint scope, spec checklist still unchecked",
				checkCanStartWork(t.store, clear.id),
			);
		} finally {
			t.cleanup();
		}
	}

	// --- completion gate ---
	{
		const t = await makeStore();
		try {
			const { specId, taskId } = seedSpecdStore(t.store);
			appendEvent(t.store, {
				item: specId,
				type: "spec.approved",
				actor: "harness",
			});
			appendEvent(t.store, {
				item: taskId,
				type: "work.started",
				actor: "harness",
			});
			record(
				rows,
				"complete-work",
				"no review yet",
				checkCanCompleteWork(t.store, taskId),
			);
			appendEvent(t.store, {
				item: taskId,
				type: "review.completed",
				actor: "reviewer",
				payload: { passed: false, findings: ["route misses 401 case"] },
			});
			record(
				rows,
				"complete-work",
				"failing review, no diagnosis",
				checkCanCompleteWork(t.store, taskId),
			);
			appendEvent(t.store, {
				item: taskId,
				type: "diagnosis.recorded",
				actor: "harness",
				payload: {
					symptom: "401 case missing",
					rootCause: "guard inverted",
					specGap: false,
				},
			});
			record(
				rows,
				"complete-work",
				"failing review + diagnosis, still no passing review",
				checkCanCompleteWork(t.store, taskId),
			);
			appendEvent(t.store, {
				item: taskId,
				type: "review.completed",
				actor: "reviewer",
				payload: { passed: true, findings: [] },
			});
			record(
				rows,
				"complete-work",
				"passing review after failure + diagnosis",
				checkCanCompleteWork(t.store, taskId),
			);
		} finally {
			t.cleanup();
		}
	}

	// --- completion gate: specGap holds until the spec is revised ---
	{
		const t = await makeStore();
		try {
			const { specId, taskId } = seedSpecdStore(t.store);
			appendEvent(t.store, {
				item: specId,
				type: "spec.approved",
				actor: "harness",
			});
			appendEvent(t.store, {
				item: taskId,
				type: "work.started",
				actor: "harness",
			});
			appendEvent(t.store, {
				item: taskId,
				type: "review.completed",
				actor: "reviewer",
				payload: { passed: false, findings: ["requirement itself is wrong"] },
			});
			appendEvent(t.store, {
				item: taskId,
				type: "diagnosis.recorded",
				actor: "harness",
				payload: {
					symptom: "spec wrong",
					rootCause: "requirement unclear",
					specGap: true,
				},
			});
			appendEvent(t.store, {
				item: taskId,
				type: "review.completed",
				actor: "reviewer",
				payload: { passed: true, findings: [] },
			});
			record(
				rows,
				"complete-work",
				"specGap diagnosis, spec not yet revised",
				checkCanCompleteWork(t.store, taskId),
			);
			appendEvent(t.store, {
				item: specId,
				type: "body.updated",
				actor: "harness",
				payload: { body: `${SPEC_BODY}\n\nRevised: rate limit clarified.` },
			});
			record(
				rows,
				"complete-work",
				"specGap diagnosis, spec revised after",
				checkCanCompleteWork(t.store, taskId),
			);
		} finally {
			t.cleanup();
		}
	}

	// --- diagnosis-target gate ---
	{
		const t = await makeStore();
		try {
			const { specId, taskId } = seedSpecdStore(t.store);
			record(
				rows,
				"diagnosis-target",
				"draft task",
				checkDiagnosisTarget(t.store, taskId),
			);
			appendEvent(t.store, {
				item: taskId,
				type: "work.started",
				actor: "harness",
			});
			record(
				rows,
				"diagnosis-target",
				"in-progress task",
				checkDiagnosisTarget(t.store, taskId),
			);
			record(
				rows,
				"diagnosis-target",
				"spec item",
				checkDiagnosisTarget(t.store, specId),
			);
		} finally {
			t.cleanup();
		}
	}

	// --- checklists-clear gate ---
	{
		const t = await makeStore();
		try {
			const { checklistId, taskId } = seedSpecdStore(t.store);
			record(
				rows,
				"checklists-clear",
				"unchecked checklist items",
				checkChecklistsClear(t.store, taskId),
			);
			appendEvent(t.store, {
				item: checklistId,
				type: "checklist.item.checked",
				actor: "reviewer",
				payload: { index: 0 },
			});
			appendEvent(t.store, {
				item: checklistId,
				type: "checklist.item.checked",
				actor: "reviewer",
				payload: { index: 1 },
			});
			record(
				rows,
				"checklists-clear",
				"all checklist items checked",
				checkChecklistsClear(t.store, taskId),
			);
		} finally {
			t.cleanup();
		}
	}

	return rows;
}
