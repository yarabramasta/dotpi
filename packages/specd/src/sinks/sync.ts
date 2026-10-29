import {
	appendEvent,
	getItem,
	history,
	parseJsonLoose,
	type SpecdStore,
} from "../store/store.js";
import { readSinkSetup } from "./config.js";
import { tryResolveAdapter } from "./resolve.js";

/** Pure lane decision (D15): the board option for a task's store status.
 * A done task whose PR is still open sits in the review lane — work.completed
 * lands while the PR awaits merge, so done would be premature. `pr.merged`
 * (recorded by the merge reconcile in syncExportedTasks) ends the review
 * detour: past it, done maps normally. The review option is statusMap's
 * "in-review" pseudo-key, defaulting to the standard "In review" lane. */
export function boardOption(
	status: string,
	events: Array<{ type: string }>,
	statusMap?: Record<string, string>,
): string {
	const prOpen =
		status === "done" &&
		events.some((e) => e.type === "pr.created") &&
		!events.some((e) => e.type === "pr.merged");
	if (prOpen) return statusMap?.["in-review"] ?? "In review";
	return statusMap?.[status] ?? status;
}

/** Pure merge-reconcile trigger: the branch whose PR still needs its merge
 * checked — only for done tasks with an open PR (no pr.merged yet). */
export function pendingMergeBranch(
	events: Array<{ type: string; payload: string }>,
): string | undefined {
	if (!events.some((e) => e.type === "work.completed")) return undefined;
	if (events.some((e) => e.type === "pr.merged")) return undefined;
	const pr = events.find((e) => e.type === "pr.created");
	if (!pr) return undefined;
	const branch = parseJsonLoose<{ branch?: string }>(pr.payload)?.branch;
	return branch || undefined;
}

/** Read-back sync: exported tasks whose sink item has closed/completed get
 * a work.completed event (actor: sink-sync), and a done task's merged PR
 * lands its board item in the done lane (via pr.merged + re-push). Works
 * for every ported sink — the task.exported payload records which sink it
 * went to. Best-effort — an unreachable sink must never break the
 * dashboard. */
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
			const payload = parseJsonLoose<{
				sink?: string;
				externalRef?: string;
			}>(row.payload);
			if (!payload?.sink || !payload.externalRef) continue;
			const adapter = tryResolveAdapter(store, payload.sink);
			if (!adapter) continue;
			let events = history(store, row.item);
			let changed = false;
			if (!events.some((e) => e.type === "work.completed")) {
				const { state } = await adapter.readBack(payload.externalRef);
				if (state === "closed") {
					appendEvent(store, {
						item: row.item,
						type: "work.completed",
						payload: { via: "sink-sync", state },
						actor: "sink-sync",
					});
					synced += 1;
					changed = true;
					events = history(store, row.item); // include the new event below
				}
			}
			// Merge reconcile (review lane → done): a done task's board item
			// waits in the review lane while its PR is open. Once the PR
			// merges, record pr.merged (the poll-stop marker) and re-push the
			// status — the push then lands the done lane.
			const branch = pendingMergeBranch(events);
			if (branch && adapter.readPrState) {
				if ((await adapter.readPrState(branch)) === "merged") {
					appendEvent(store, {
						item: row.item,
						type: "pr.merged",
						payload: { via: "sink-sync", branch },
						actor: "sink-sync",
					});
					synced += 1;
					changed = true;
				}
			}
			// The lane follows the store: push whenever sync changed a status.
			if (changed) await pushStatusToSink(store, row.item);
		} catch {
			// best-effort: unreachable sink never breaks the dashboard
		}
	}
	return synced;
}

/** Push-side status flow: when a task's status changes in the store,
 * push the mapped workflow option to the sink (D15). A done task with a
 * still-open PR pushes the review lane instead (boardOption). Throws on
 * sink failure — the caller wraps it best-effort and surfaces the error.
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
	const events = history(store, itemId);
	const exported = events.find((e) => e.type === "task.exported");
	if (!exported) return undefined; // not exported to any sink — nothing to push
	const payload = parseJsonLoose<{
		sink?: string;
		externalRef?: string;
	}>(exported.payload);
	if (!payload?.sink || payload.sink === "null") return undefined;
	if (!payload.externalRef) return undefined; // malformed export record — skip
	const adapter = tryResolveAdapter(store, payload.sink);
	if (!adapter?.updateStatus) return undefined; // misconfig — skip, contract-optional
	const mapped = boardOption(
		item.status,
		events,
		readSinkSetup(store)?.statusMap,
	);
	await adapter.updateStatus(payload.externalRef, mapped);
	return `${payload.sink}: ${item.status} → ${mapped}`;
}
