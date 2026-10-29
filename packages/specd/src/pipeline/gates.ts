import {
	getItem,
	history,
	linkedItems,
	listItems,
	parseJsonLoose,
	relatedItems,
	type SpecdStore,
} from "../store/store.js";
import { pathScopesOverlap } from "./schedule.js";

export interface GateCheck {
	ok: boolean;
	reason?: string;
}

/** The export gate: a task may only be exported when it is linked to a spec
 * (part-of) whose history contains spec.approved, and it has not already
 * been exported. Enforced in tool code — the agent cannot talk its way
 * past it. Plain-language reasons so juniors know what to do next. */
export function checkExport(store: SpecdStore, taskId: string): GateCheck {
	const task = getItem(store, taskId);
	if (!task) return { ok: false, reason: `Unknown item: ${taskId}.` };
	if (task.kind !== "task") {
		return {
			ok: false,
			reason: `Only tasks can be exported, and ${taskId} is a ${task.kind}.`,
		};
	}
	const alreadyExported = history(store, taskId).some(
		(e) => e.type === "task.exported",
	);
	if (alreadyExported) {
		return {
			ok: false,
			reason: `${taskId} is already exported. Re-exporting would duplicate work items — check the dashboard instead.`,
		};
	}
	const specs = linkedItems(store, taskId, "part-of").filter(
		(i) => i.kind === "spec",
	);
	if (specs.length === 0) {
		return {
			ok: false,
			reason: `${taskId} is not linked to a spec yet. Link it first: specd_add_link from=${taskId} to=<spec id> kind=part-of.`,
		};
	}
	const unapproved = specs.filter(
		(spec) => !history(store, spec.id).some((e) => e.type === "spec.approved"),
	);
	if (unapproved.length > 0) {
		return {
			ok: false,
			reason: `The spec ${unapproved.map((s) => s.id).join(", ")} is not approved yet. Get the spec approved before exporting its tasks.`,
		};
	}
	return { ok: true };
}

export function assertCanExport(store: SpecdStore, taskId: string): void {
	const check = checkExport(store, taskId);
	if (!check.ok) throw new Error(check.reason);
}

/** Latest explore decision on a cycle, or undefined when none recorded. */
function latestExploreDecision(
	store: SpecdStore,
	cycleId: string,
): { decision: string; reason?: string } | undefined {
	let last: { decision: string; reason?: string } | undefined;
	for (const event of history(store, cycleId)) {
		if (event.type !== "explore.decided") continue;
		const payload = parseJsonLoose<{ decision?: string; reason?: string }>(
			event.payload,
		);
		if (payload?.decision) {
			last = { decision: payload.decision, reason: payload.reason };
		}
	}
	return last;
}

/** The explore decision gate: a spec may only be created inside a cycle
 * whose latest explore decision is "go". This is spec-kit's assessment
 * insight — stopping with a documented reason is a valid outcome. */
export function checkSpecCreation(
	store: SpecdStore,
	cycleId: string | undefined,
): GateCheck {
	if (!cycleId) {
		return {
			ok: false,
			reason:
				"Specs live inside cycles. Create the cycle first (specd_create_item kind=cycle), record the explore decision on it, then create the spec with cycle=<cycle id>.",
		};
	}
	const cycle = getItem(store, cycleId);
	if (!cycle) return { ok: false, reason: `Unknown item: ${cycleId}.` };
	if (cycle.kind !== "cycle") {
		return {
			ok: false,
			reason: `${cycleId} is a ${cycle.kind}, not a cycle. Pass the cycle item's id.`,
		};
	}
	const decision = latestExploreDecision(store, cycleId);
	if (!decision) {
		return {
			ok: false,
			reason: `No explore decision recorded on ${cycleId} yet. Ask the explore question ("any unknowns worth researching first?"), record the answer with specd_append_event(type=explore.decided, payload={decision: "go" | "needs-clarification" | "stop"}), then create the spec.`,
		};
	}
	if (decision.decision === "stop") {
		return {
			ok: false,
			reason: `Explore decided "stop" for ${cycleId}${decision.reason ? `: ${decision.reason}` : ""}. Stopping with a documented reason is a valid outcome — no spec is created.`,
		};
	}
	if (decision.decision === "needs-clarification") {
		return {
			ok: false,
			reason: `Explore on ${cycleId} still needs clarification${decision.reason ? `: ${decision.reason}` : ""}. Research the unknowns, record evidence, then decide again (explore.decided with decision="go" or "stop").`,
		};
	}
	if (decision.decision !== "go") {
		return {
			ok: false,
			reason: `Unknown explore decision "${decision.decision}" on ${cycleId}. Valid: go, needs-clarification, stop.`,
		};
	}
	return { ok: true };
}

export function assertSpecCreationAllowed(
	store: SpecdStore,
	cycleId: string | undefined,
): void {
	const check = checkSpecCreation(store, cycleId);
	if (!check.ok) throw new Error(check.reason);
}

/** The start gate (work.started): requirements checklists clear (reviewer
 * owns them) AND no other in-progress task claims an overlapping path
 * scope — concurrent workers may share a repo, never a file. */
export function checkCanStartWork(
	store: SpecdStore,
	taskId: string,
): GateCheck {
	const task = getItem(store, taskId);
	if (!task) return { ok: false, reason: `Unknown item: ${taskId}.` };
	if (task.kind !== "task") {
		return {
			ok: false,
			reason: `Only tasks run through the execution seam, and ${taskId} is a ${task.kind}.`,
		};
	}
	const checklists = checkChecklistsClear(store, taskId);
	if (!checklists.ok) return checklists;

	const inProgress = listItems(store, { status: "in-progress" }).filter(
		(t) => t.id !== taskId && t.kind === "task",
	);
	const clash = inProgress.find((t) =>
		pathScopesOverlap(t.path_scope, task.path_scope),
	);
	if (clash) {
		return {
			ok: false,
			reason: `${clash.id} is already in progress and its path scope${clash.path_scope ? ` (${clash.path_scope})` : " is unscoped"} overlaps${task.path_scope ? ` ${task.path_scope}` : " this task's (unscoped)"}. Finish or pause it first — concurrent workers never share files.`,
		};
	}
	return { ok: true };
}

/** The completion gate (work.completed): a reviewer subagent must have
 * signed off — the latest review.completed event for the task must say
 * passed. Two loop rules tighten it: a failing review must be answered by
 * a diagnosis.recorded before the next passing review counts (the fix
 * loop — blind retries are refused), and a diagnosis that says the spec
 * itself was wrong (specGap) holds completion until the linked spec is
 * revised (body.updated after the diagnosis). */
export function checkCanCompleteWork(
	store: SpecdStore,
	taskId: string,
): GateCheck {
	const task = getItem(store, taskId);
	if (!task) return { ok: false, reason: `Unknown item: ${taskId}.` };
	const events = history(store, taskId);
	const reviews = events.filter((e) => e.type === "review.completed");
	const last = reviews.at(-1);
	if (!last) {
		return {
			ok: false,
			reason: `${taskId} has no review yet. Spawn a reviewer subagent over the implemented work and record its verdict: specd_append_event(type=review.completed, payload={passed: true|false, findings: [...]}).`,
		};
	}
	const payload = parseJsonLoose<{ passed?: boolean }>(last.payload);
	if (payload?.passed !== true) {
		return {
			ok: false,
			reason: `The latest review of ${taskId} did not pass (or recorded no verdict). Diagnose first — /spec diagnose ${taskId} (record diagnosis.recorded with the symptom, root cause, and whether the spec itself was wrong) — then fix, re-run the reviewer, and record a passing review.completed before completing.`,
		};
	}
	// The fix loop: a failing review must be answered by a recorded
	// diagnosis before the next passing review counts. Each new failure
	// needs a fresh diagnosis — the per-failure diagnosis IS the bound.
	const lastFailure = reviews
		.filter(
			(e) => parseJsonLoose<{ passed?: boolean }>(e.payload)?.passed !== true,
		)
		.at(-1);
	if (lastFailure) {
		const diagnosed = events.some(
			(e) => e.type === "diagnosis.recorded" && e.id > lastFailure.id,
		);
		if (!diagnosed) {
			return {
				ok: false,
				reason: `The last review of ${taskId} failed, and no diagnosis answers it. Record one first: /spec diagnose ${taskId} (specd_append_event type=diagnosis.recorded with the symptom, root cause, and whether the spec itself was wrong), fix, then re-run the reviewer.`,
			};
		}
	}
	// The spec gap: when the latest diagnosis says the spec itself was
	// wrong, completion waits until the linked spec is revised — fixes
	// keep code and spec aligned.
	const lastDiagnosis = events
		.filter((e) => e.type === "diagnosis.recorded")
		.at(-1);
	if (
		lastDiagnosis &&
		parseJsonLoose<{ specGap?: boolean }>(lastDiagnosis.payload)?.specGap ===
			true
	) {
		const specs = linkedItems(store, taskId, "part-of").filter(
			(i) => i.kind === "spec",
		);
		const revised = specs.some((spec) =>
			history(store, spec.id).some(
				(e) => e.type === "body.updated" && e.id > lastDiagnosis.id,
			),
		);
		if (!revised) {
			return {
				ok: false,
				reason: specs.length
					? `The latest diagnosis of ${taskId} says the spec itself was wrong. Revise ${specs.map((s) => s.id).join(", ")} first (specd_append_event type=body.updated on the spec) so the fix and the spec stay aligned, then complete.`
					: `The latest diagnosis of ${taskId} says the spec itself was wrong, but the task has no linked spec to revise. Re-record the diagnosis with specGap=false if the spec is actually fine.`,
			};
		}
	}
	return { ok: true };
}

/** The diagnosis gate: diagnosis.recorded belongs to an in-progress task —
 * diagnosing work that never started (or is already done) is bookkeeping
 * noise, and the fix-loop gate keys on in-progress diagnoses. */
export function checkDiagnosisTarget(
	store: SpecdStore,
	itemId: string,
): GateCheck {
	const item = getItem(store, itemId);
	if (!item) return { ok: false, reason: `Unknown item: ${itemId}.` };
	if (item.kind !== "task" || item.status !== "in-progress") {
		return {
			ok: false,
			reason: `diagnosis.recorded belongs to an in-progress task — ${itemId} is a ${item.kind} in ${item.status}. Run /spec diagnose while the work is open.`,
		};
	}
	return { ok: true };
}

export function assertDiagnosisTarget(store: SpecdStore, itemId: string): void {
	const check = checkDiagnosisTarget(store, itemId);
	if (!check.ok) throw new Error(check.reason);
}

export function assertCanStartWork(store: SpecdStore, taskId: string): void {
	const check = checkCanStartWork(store, taskId);
	if (!check.ok) throw new Error(check.reason);
}

export function assertCanCompleteWork(store: SpecdStore, taskId: string): void {
	const check = checkCanCompleteWork(store, taskId);
	if (!check.ok) throw new Error(check.reason);
}

export interface ChecklistState {
	total: number;
	checkedIndexes: number[];
	allChecked: boolean;
	items: string[];
}

/** Reviewer-owned checklist state: the items list comes from the created
 * payload; checked indexes come from checklist.item.checked events. */
export function checklistState(
	store: SpecdStore,
	checklistId: string,
): ChecklistState | undefined {
	const item = getItem(store, checklistId);
	if (!item) return undefined;
	let items: string[] = [];
	for (const event of history(store, checklistId)) {
		if (event.type !== "created") continue;
		const payload = parseJsonLoose<{ items?: string[] }>(event.payload);
		if (Array.isArray(payload?.items)) items = payload.items;
	}
	const checkedIndexes: number[] = [];
	for (const event of history(store, checklistId)) {
		if (event.type !== "checklist.item.checked") continue;
		const payload = parseJsonLoose<{ index?: number }>(event.payload);
		const index = payload?.index;
		if (
			typeof index === "number" &&
			index >= 0 &&
			index < items.length &&
			!checkedIndexes.includes(index)
		) {
			checkedIndexes.push(index);
		}
	}
	return {
		total: items.length,
		checkedIndexes,
		allChecked: items.length > 0 && checkedIndexes.length === items.length,
		items,
	};
}

/** The implement gate (used by the execution seam): every checklist linked
 * part-of the task's spec must be fully checked by the reviewer. */
export function checkChecklistsClear(
	store: SpecdStore,
	taskId: string,
): GateCheck {
	const task = getItem(store, taskId);
	if (!task) return { ok: false, reason: `Unknown item: ${taskId}.` };
	const specs = linkedItems(store, taskId, "part-of").filter(
		(i) => i.kind === "spec",
	);
	for (const spec of specs) {
		const checklists = relatedItems(store, spec.id, "part-of").filter(
			(i) => i.kind === "checklist",
		);
		for (const checklist of checklists) {
			const state = checklistState(store, checklist.id);
			if (!state) continue;
			if (!state.allChecked) {
				return {
					ok: false,
					reason: `Requirements checklist ${checklist.id} has ${state.total - state.checkedIndexes.length} unchecked item(s) out of ${state.total}. The reviewer must check them (via /spec review) before implementation runs.`,
				};
			}
		}
	}
	return { ok: true };
}
