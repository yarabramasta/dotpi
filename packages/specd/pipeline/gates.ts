import {
	getItem,
	history,
	linkedItems,
	parseJsonLoose,
	relatedItems,
	type SpecdStore,
} from "../store/store.js";

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
