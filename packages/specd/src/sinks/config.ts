import type { SpecdStore } from "../store/store.js";
import type { PlanWorkspace, SinkSetup } from "./contract.js";

/** Canonical lane taxonomy and naming convention — defaults the plan
 * interview offers; a saved plan overrides them. Lanes are the sink's
 * workflow columns (Status options on GitHub, lists on Trello, …) — the
 * kanban workflow itself. Milestones/sprints are the developer's own
 * grouping on top (specd does not write them). */
export const DEFAULT_LANES = [
	"Backlog",
	"Ready",
	"In progress",
	"In review",
	"Done",
	"Blocked",
] as const;
export const DEFAULT_NAMING = "{type}({scope}): {title}";

/** Sink targeting config lives in the store's meta table — non-secret ids
 * only (owner, project number, lane). Credentials stay in the dev's shell. */
export function readSinkConfig(
	store: SpecdStore,
	key: string,
): Record<string, unknown> | undefined {
	const row = store.db
		.prepare("SELECT value FROM meta WHERE key = ?")
		.get(key) as { value: string } | undefined;
	if (!row) return undefined;
	try {
		return JSON.parse(row.value) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function saveSinkConfig(
	store: SpecdStore,
	key: string,
	value: Record<string, unknown>,
): void {
	store.db
		.prepare(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.run(key, JSON.stringify(value));
}

/** Read the stored sink setup, loosely validated — a corrupt record
 * degrades to undefined rather than breaking every export. */
export function readSinkSetup(store: SpecdStore): SinkSetup | undefined {
	// "sink_setup" since the plan→sink rename; fall back to the legacy
	// "project_plan" key so existing stores keep working.
	const raw =
		readSinkConfig(store, "sink_setup") ??
		readSinkConfig(store, "project_plan");
	if (!raw) return undefined;
	const ws = (raw.workspace ?? {}) as Record<string, unknown>;
	const workspace: PlanWorkspace = {
		owner: typeof ws.owner === "string" ? ws.owner : undefined,
		projectNumber:
			typeof ws.projectNumber === "number" ? ws.projectNumber : undefined,
	};
	const strings = (value: unknown): string[] =>
		Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: [];
	// statusMap: specd item status → the board's own workflow option
	// (D15). Only string→string entries are kept.
	const statusMap: Record<string, string> = {};
	if (raw.statusMap && typeof raw.statusMap === "object") {
		for (const [k, v] of Object.entries(
			raw.statusMap as Record<string, unknown>,
		)) {
			if (typeof v === "string" && v) statusMap[k] = v;
		}
	}
	return {
		workspace,
		lanes: strings(raw.lanes),
		labels: strings(raw.labels),
		naming: typeof raw.naming === "string" ? raw.naming : "",
		...(Object.keys(statusMap).length > 0 ? { statusMap } : {}),
	};
}

export function saveSinkSetup(
	store: SpecdStore,
	plan: SinkSetup,
	sink: string,
): void {
	saveSinkConfig(store, "sink_setup", { ...plan, sink });
}
