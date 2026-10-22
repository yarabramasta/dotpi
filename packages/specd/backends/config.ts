import type { SpecdStore } from "../store/store.js";

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
