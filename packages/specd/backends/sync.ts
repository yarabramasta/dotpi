import {
	appendEvent,
	getItem,
	history,
	parseJsonLoose,
	type SpecdStore,
} from "../store/store.js";
import { tryResolveAdapter } from "./resolve.js";

/** Read-back sync: exported tasks whose sink item has closed/completed get
 * a work.completed event (actor: sink-sync). Works for every ported sink —
 * the task.exported payload records which sink it went to. Best-effort —
 * an unreachable sink must never break the dashboard. */
export async function syncExportedTasks(store: SpecdStore): Promise<number> {
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
			if (!payload?.sink || !payload.externalRef) continue;
			const adapter = tryResolveAdapter(store, payload.sink);
			if (!adapter) continue;
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
