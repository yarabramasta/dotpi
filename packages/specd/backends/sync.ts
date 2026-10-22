import {
	appendEvent,
	getItem,
	history,
	parseJsonLoose,
	type SpecdStore,
} from "../store/store.js";
import { readSinkConfig } from "./config.js";
import { createGithubAdapter } from "./github.js";

/** Read-back sync: exported tasks whose GitHub issue has closed get a
 * work.completed event (actor: sink-sync). Best-effort — a sink that is
 * unreachable must never break the dashboard. */
export async function syncExportedTasks(store: SpecdStore): Promise<number> {
	const config = readSinkConfig(store, "sink.github");
	if (!config?.owner || !config.projectNumber) return 0;
	const adapter = createGithubAdapter(store.cwd, {
		owner: String(config.owner),
		projectNumber: Number(config.projectNumber),
	});
	let synced = 0;
	// SAFETY: two-column rows (item id + payload) matching the destructure.
	const exported = store.db
		.prepare(
			"SELECT item, payload FROM events WHERE type = 'task.exported' ORDER BY id ASC",
		)
		.all() as unknown as Array<{ item: string; payload: string }>;
	const seen = new Set<string>();
	for (const row of exported) {
		if (seen.has(row.item)) continue; // latest event wins via ordered scan
		seen.add(row.item);
		try {
			const item = getItem(store, row.item);
			if (!item) continue;
			if (history(store, row.item).some((e) => e.type === "work.completed")) {
				continue;
			}
			const payload = parseJsonLoose<{
				sink?: string;
				externalRef?: string;
			}>(row.payload);
			if (payload?.sink !== "github" || !payload.externalRef) continue;
			const { state } = await adapter.readBack(payload.externalRef);
			if (state === "closed") {
				appendEvent(store, {
					item: row.item,
					type: "work.completed",
					payload: { via: "sink-sync", state },
					actor: "sink-sync",
				});
				synced += 1;
			}
		} catch {
			// best-effort: unreachable sink never breaks the dashboard
		}
	}
	return synced;
}
