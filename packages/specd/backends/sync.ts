import {
	appendEvent,
	getItem,
	history,
	parseJsonLoose,
	type SpecdStore,
} from "../store/store.js";
import { readSinkSetup } from "./config.js";
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


/** Push-side status flow: when a task's status changes in the store,
 * push the mapped workflow option to the sink (D15). Throws on sink
 * failure — the caller wraps it best-effort and surfaces the error.
 * Returns undefined when there is nothing to push: the task has no
 * sink export, or exported to the store-native null sink. Must be
 * called AFTER the status-changing event is appended: it reads the
 * item's new status. */
export async function pushStatusToSink(
	store: SpecdStore,
	itemId: string,
): Promise<string | undefined> {
	const item = getItem(store, itemId);
	if (!item) throw new Error(`unknown item ${itemId}`);
	const exported = history(store, itemId).find(
		(e) => e.type === "task.exported",
	);
	if (!exported) return undefined; // not exported to any sink — nothing to push
	const payload = parseJsonLoose<{
		sink?: string;
		externalRef?: string;
	}>(exported.payload);
	if (!payload?.sink || payload.sink === "null") return undefined;
	if (!payload.externalRef) return undefined; // malformed export record — skip
	const adapter = tryResolveAdapter(store, payload.sink);
	if (!adapter?.updateStatus) return undefined; // misconfig — skip, contract-optional
	const statusMap = readSinkSetup(store)?.statusMap;
	const mapped = statusMap?.[item.status] ?? item.status;
	await adapter.updateStatus(payload.externalRef, mapped);
	return `${payload.sink}: ${item.status} → ${mapped}`;
}
