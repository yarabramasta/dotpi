import {
	childItems,
	getItem,
	type ItemRow,
	listItems,
	relatedItems,
	type SpecdStore,
} from "../store/store.js";
import { checklistState } from "./gates.js";

export type FindingSeverity = "critical" | "warning" | "note";

export interface Finding {
	/** critical = a downstream gate will refuse; warning = likely modeling
	 * mistake; note = informational or pending human action. */
	severity: FindingSeverity;
	rule: string;
	message: string;
	item?: string;
}

/** Bidirectional part-of closure from a root item (cycle/spec/task …). */
function scopeIds(store: SpecdStore, root: string): Set<string> {
	const ids = new Set<string>([root]);
	const queue: string[] = [root];
	while (queue.length > 0) {
		const id = queue.pop() as string;
		for (const rel of relatedItems(store, id, "part-of")) {
			if (!ids.has(rel.id)) {
				ids.add(rel.id);
				queue.push(rel.id);
			}
		}
	}
	return ids;
}

// ponytail: path-scope overlap compares static path-segment prefixes
// (trailing globs stripped, middle globs like src/*/x.ts not matched);
// upgrade to glob-aware intersection if false negatives bite.
function scopeOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	const segments = (s: string) =>
		s
			.replace(/\/?\*\*?$/, "")
			.split("/")
			.filter(Boolean);
	const segA = segments(a);
	const segB = segments(b);
	if (segA.length === 0 || segB.length === 0) return false;
	const [shorter, longer] =
		segA.length <= segB.length ? [segA, segB] : [segB, segA];
	return shorter.every((seg, i) => longer[i] === seg);
}

const SEVERITY_RANK = {
	critical: 0,
	warning: 1,
	note: 2,
} satisfies Record<FindingSeverity, number>;

/** Read-only cross-artifact consistency check. Mechanical rules only —
 * contradiction/duplication/ambiguity review is the agent's semantic pass
 * on top of these findings. Scopes to an item's part-of subgraph when
 * scopeId is given, otherwise the whole store. */
export function checkConsistency(
	store: SpecdStore,
	scopeId?: string,
): Finding[] {
	const findings: Finding[] = [];
	if (scopeId && !getItem(store, scopeId)) {
		return [
			{
				severity: "warning",
				rule: "unknown-scope",
				message: `No item ${scopeId} — cannot scope the consistency check.`,
			},
		];
	}

	let items: ItemRow[] = listItems(store, { limit: 10000 });
	if (scopeId) {
		const ids = scopeIds(store, scopeId);
		items = items.filter((i) => ids.has(i.id));
	}

	const tasks = items.filter((i) => i.kind === "task");
	const specs = items.filter((i) => i.kind === "spec");
	const checklists = items.filter((i) => i.kind === "checklist");

	// Every task must hang off a spec, and that spec must be approved
	// before the task can ever export or run.
	for (const task of tasks) {
		const linkedSpecs = relatedItems(store, task.id, "part-of").filter(
			(i) => i.kind === "spec",
		);
		if (linkedSpecs.length === 0) {
			findings.push({
				severity: "warning",
				rule: "task-without-spec",
				item: task.id,
				message: `Task ${task.id} links to no spec — it can never pass the export or implement gates.`,
			});
			continue;
		}
		for (const spec of linkedSpecs) {
			if (spec.status !== "approved") {
				findings.push({
					severity: "critical",
					rule: "task-of-unapproved-spec",
					item: task.id,
					message: `Task ${task.id} hangs off ${spec.id} which is ${spec.status} — export and implementation will refuse.`,
				});
			}
		}
	}

	for (const spec of specs) {
		const related = relatedItems(store, spec.id, "part-of");
		const plans = related.filter((i) => i.kind === "plan");
		const specTasks = related.filter((i) => i.kind === "task");
		if (
			spec.status === "approved" &&
			specTasks.length > 0 &&
			plans.length === 0
		) {
			findings.push({
				severity: "critical",
				rule: "spec-without-plan",
				item: spec.id,
				message: `Approved spec ${spec.id} has ${specTasks.length} task(s) but no linked plan — implementation is gated until a plan is attached.`,
			});
		}
		if (spec.status === "approved" && specTasks.length === 0) {
			findings.push({
				severity: "note",
				rule: "spec-without-tasks",
				item: spec.id,
				message: `Approved spec ${spec.id} has no tasks yet.`,
			});
		}
		for (const cl of related.filter((i) => i.kind === "checklist")) {
			const state = checklistState(store, cl.id);
			if (state && !state.allChecked) {
				findings.push({
					severity: "note",
					rule: "checklist-pending",
					item: cl.id,
					message: `Checklist ${cl.id} on ${spec.id}: ${state.checkedIndexes.length}/${state.total} reviewed — implementation waits on the reviewer.`,
				});
			}
		}
	}

	for (const cl of checklists) {
		if (relatedItems(store, cl.id, "part-of").every((i) => i.kind !== "spec")) {
			findings.push({
				severity: "warning",
				rule: "orphan-checklist",
				item: cl.id,
				message: `Checklist ${cl.id} is not linked to any spec.`,
			});
		}
	}

	// Parallel-safe tasks sharing a path scope would race on the same files.
	const parallelTasks = tasks.filter(
		(i) => i.parallel === 1 && i.path_scope && i.status !== "done",
	);
	for (let i = 0; i < parallelTasks.length; i++) {
		for (let j = i + 1; j < parallelTasks.length; j++) {
			const a = parallelTasks[i] as ItemRow;
			const b = parallelTasks[j] as ItemRow;
			if (scopeOverlap(a.path_scope as string, b.path_scope as string)) {
				findings.push({
					severity: "warning",
					rule: "parallel-scope-overlap",
					item: b.id,
					message: `Parallel tasks ${a.id} and ${b.id} may overlap on path scope ("${a.path_scope}" vs "${b.path_scope}") — schedule them sequentially or split the scope.`,
				});
			}
		}
	}

	// A stopped cycle should not still carry open work.
	for (const cycle of items.filter(
		(i) => i.kind === "cycle" && i.status === "stopped",
	)) {
		const open = relatedItems(store, cycle.id, "part-of").filter(
			(i) => i.kind === "spec" && i.status !== "done",
		);
		if (open.length > 0) {
			findings.push({
				severity: "note",
				rule: "stopped-cycle-open-specs",
				item: cycle.id,
				message: `Cycle ${cycle.id} is stopped but still linked to ${open.length} open spec(s): ${open.map((i) => i.id).join(", ")}.`,
			});
		}
	}

	// Constitution checked at plan: every plan should be anchored to the
	// project's purpose-and-principles item.
	for (const plan of items.filter((i) => i.kind === "plan")) {
		const hasConstitution = relatedItems(store, plan.id, "part-of").some(
			(i) => i.kind === "constitution",
		);
		if (!hasConstitution) {
			findings.push({
				severity: "note",
				rule: "plan-without-constitution",
				item: plan.id,
				message: `Plan ${plan.id} has no constitution linked — capture the product purpose and principles (specd_create_item kind=constitution) and link it part-of the plan.`,
			});
		}
	}

	// Epic/roadmap ladder: epics plan through an ordered roadmap of
	// per-slice specs, not loose tasks.
	for (const epic of items.filter((i) => i.kind === "epic")) {
		// Directional: the roadmap is the epic's CHILD (roadmap part-of
		// epic) — a bidirectional read would pull unrelated items in.
		const roads = childItems(store, epic.id, "part-of").filter(
			(i) => i.kind === "roadmap",
		);
		if (roads.length === 0) {
			findings.push({
				severity: "warning",
				rule: "epic-without-roadmap",
				item: epic.id,
				message: `Epic ${epic.id} has no roadmap — plan it as a roadmap with ordered per-slice specs (each slice links part-of the roadmap).`,
			});
		}
	}
	for (const roadmap of items.filter((i) => i.kind === "roadmap")) {
		// Directional: slices point at the roadmap (slice part-of
		// roadmap); the epic (the roadmap's parent) is not a slice.
		const slices = childItems(store, roadmap.id, "part-of");
		if (slices.length === 0) {
			findings.push({
				severity: "warning",
				rule: "roadmap-without-slices",
				item: roadmap.id,
				message: `Roadmap ${roadmap.id} has no slices — link per-slice specs part-of it, in execution order.`,
			});
			continue;
		}
		const sliceSpecs = slices.filter((i) => i.kind === "spec");
		for (const slice of slices.filter((i) => i.kind !== "spec")) {
			findings.push({
				severity: "warning",
				rule: "roadmap-slice-not-spec",
				item: slice.id,
				message: `Roadmap ${roadmap.id} slice ${slice.id} is a ${slice.kind} — slices are per-slice specs.`,
			});
		}
		// Ordering lives in depends-on edges between the slice specs; a
		// two-plus-slice roadmap without any is unordered.
		if (sliceSpecs.length >= 2) {
			const anyDepends = sliceSpecs.some((s) =>
				relatedItems(store, s.id, "depends-on").some((d) =>
					sliceSpecs.some((o) => o.id === d.id),
				),
			);
			if (!anyDepends) {
				findings.push({
					severity: "note",
					rule: "roadmap-unordered-slices",
					item: roadmap.id,
					message: `Roadmap ${roadmap.id} has ${sliceSpecs.length} slices but no depends-on edges between them — record the slice order with specd_add_link(kind=depends-on).`,
				});
			}
		}
	}

	findings.sort((a, b) => {
		const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
		return bySeverity !== 0
			? bySeverity
			: (a.item ?? "").localeCompare(b.item ?? "");
	});
	return findings;
}

/** Compact severity-grouped rendering for chat output. */
export function formatFindings(findings: Finding[]): string {
	if (findings.length === 0) {
		return "No consistency findings — artifacts line up.";
	}
	const icon = {
		critical: "🔴",
		warning: "🟡",
		note: "⚪",
	} satisfies Record<FindingSeverity, string>;
	const lines: string[] = [];
	for (const severity of ["critical", "warning", "note"] as const) {
		const group = findings.filter((f) => f.severity === severity);
		if (group.length === 0) continue;
		lines.push(`${icon[severity]} ${severity.toUpperCase()} (${group.length})`);
		for (const f of group) {
			lines.push(`- [${f.rule}] ${f.message}`);
		}
	}
	return lines.join("\n");
}
