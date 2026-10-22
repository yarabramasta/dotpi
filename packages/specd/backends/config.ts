import type { SpecdStore } from "../store/store.js";
import type { PlanWorkspace, ProjectPlan } from "./contract.js";

/** Canonical lane taxonomy and naming convention — defaults the plan
 * interview offers; a saved plan overrides them. */
export const DEFAULT_LANES = [
	"MVP",
	"V1",
	"V2",
	"after-MVP",
	"maintenance",
] as const;
export const DEFAULT_NAMING = "specd/{ref} {title}";

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

/** Read the stored project plan, loosely validated — a corrupt record
 * degrades to undefined rather than breaking every export. */
export function readProjectPlan(store: SpecdStore): ProjectPlan | undefined {
	const raw = readSinkConfig(store, "project_plan");
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
	return {
		workspace,
		lanes: strings(raw.lanes),
		labels: strings(raw.labels),
		naming: typeof raw.naming === "string" ? raw.naming : "",
	};
}

export function saveProjectPlan(
	store: SpecdStore,
	plan: ProjectPlan,
	sink: string,
): void {
	saveSinkConfig(store, "project_plan", { ...plan, sink });
}
