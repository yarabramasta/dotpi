import type { ItemRow } from "../src/store/store.js";

/** M3 execution scheduling. Tasks execute in phase waves (setup →
 * foundational → story → polish, unphased last). Within a wave only
 * [P]-marked tasks with provably disjoint path scopes run concurrently;
 * anything overlapping is serialized into a later wave — a path-ownership
 * collision is detected and serialized, never corrupted. */

const PHASE_ORDER = ["setup", "foundational", "story", "polish"] as const;

function phaseRank(phase: string | null): number {
	const i = PHASE_ORDER.indexOf((phase ?? "") as (typeof PHASE_ORDER)[number]);
	return i === -1 ? PHASE_ORDER.length : i;
}

/** Does glob-ish path pattern `pattern` cover path `p`? Segment-based:
 * `**` covers the rest, `*` covers one segment, exact segments otherwise.
 * ponytail: single-`*` and `**` only — globset-level patterns are overkill
 * for path scopes that are written by the planner. */
function covers(pattern: string, p: string): boolean {
	const a = pattern.split("/").filter(Boolean);
	const b = p.split("/").filter(Boolean);
	let i = 0;
	for (; i < a.length; i++) {
		const seg = a[i];
		if (seg === "**") return true;
		if (i >= b.length) return false;
		if (seg === "*") continue;
		if (seg !== b[i]) return false;
	}
	// Pattern exhausted without mismatch: a bare directory pattern covers
	// everything under it (src/auth ⊇ src/auth/login.ts).
	return true;
}

/** Two path scopes overlap when either could touch the other's files. An
 * unscoped task (`path_scope` null) overlaps everything — it cannot prove
 * disjointness, so it never shares a wave. */
export function pathScopesOverlap(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	if (!a || !b) return true;
	return covers(a, b) || covers(b, a);
}

export interface ScheduledTask {
	id: string;
	title: string;
	phase: string | null;
	parallel: boolean;
	pathScope: string | null;
}

export interface ExecutionWave {
	/** 1-based wave number; waves run strictly in order. */
	n: number;
	tasks: ScheduledTask[];
}

export interface ScheduleResult {
	waves: ExecutionWave[];
	/** Pairs of tasks forced apart by scope overlap (or missing [P] marker)
	 * — surfaced so the operator sees why something was serialized. */
	serialized: Array<{ a: string; b: string; reason: string }>;
}

/** Pure scheduler over already-fetched task rows. Deterministic: input
 * order (dashboard order) is the tiebreak everywhere. */
export function planWaves(tasks: ItemRow[]): ScheduleResult {
	const scheduled: ScheduledTask[] = tasks.map((t) => ({
		id: t.id,
		title: t.title,
		phase: t.phase ?? null,
		parallel: t.parallel === 1,
		pathScope: t.path_scope ?? null,
	}));
	scheduled.sort(
		(a, b) =>
			phaseRank(a.phase) - phaseRank(b.phase) || a.id.localeCompare(b.id),
	);

	const waves: ExecutionWave[] = [];
	const serialized: ScheduleResult["serialized"] = [];
	let current: ScheduledTask[] = [];

	const flush = () => {
		if (current.length > 0) {
			waves.push({ n: waves.length + 1, tasks: current });
			current = [];
		}
	};

	for (const task of scheduled) {
		// Phase boundary always starts a new wave.
		if (
			current.length > 0 &&
			phaseRank(current[0].phase) !== phaseRank(task.phase)
		) {
			flush();
		}
		// Non-parallel tasks never share a wave.
		if (!task.parallel) {
			flush();
			waves.push({ n: waves.length + 1, tasks: [task] });
			continue;
		}
		// Parallel task joins the current wave only when its scope is
		// disjoint from everything already in it.
		const clash = current.find((t) =>
			pathScopesOverlap(t.pathScope, task.pathScope),
		);
		if (clash) {
			serialized.push({
				a: clash.id,
				b: task.id,
				reason:
					!task.pathScope || !clash.pathScope
						? "unscoped task cannot prove disjointness"
						: `path scopes overlap (${clash.pathScope} vs ${task.pathScope})`,
			});
			// Flush the current wave first, then open a new one with the
			// clashing task — dropping it would lose work from the plan.
			flush();
			current = [task];
			continue;
		}
		current.push(task);
	}
	flush();

	return { waves, serialized };
}
