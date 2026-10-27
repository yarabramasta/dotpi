import {
	getItem,
	history,
	type ItemRow,
	listItems,
	parseJsonLoose,
	relatedItems,
	type SpecdStore,
} from "./store/store.js";

/** Item querying + short insight for the command flows. Pure: filters,
 * link traversal, and digest rendering — the tool layer just calls these
 * and returns the text. */

export interface QueryOptions {
	kind?: string;
	status?: string;
	/** substring match over title + body (case-insensitive) */
	q?: string;
	/** item id — restrict to items linked to/from it (any part-of-ish
	 * kind, direction annotated in the output) */
	of?: string;
	limit?: number;
}

export function queryItems(store: SpecdStore, opts: QueryOptions): ItemRow[] {
	let rows = listItems(store, { limit: 10000 });
	if (opts.kind) rows = rows.filter((r) => r.kind === opts.kind);
	if (opts.status) rows = rows.filter((r) => r.status === opts.status);
	if (opts.q) {
		const needle = opts.q.toLowerCase();
		rows = rows.filter(
			(r) =>
				r.id.toLowerCase().includes(needle) ||
				r.title.toLowerCase().includes(needle) ||
				r.body.toLowerCase().includes(needle),
		);
	}
	if (opts.of) {
		const related = relatedItems(store, opts.of, "part-of");
		const ids = new Set(related.map((r) => r.id));
		rows = rows.filter((r) => ids.has(r.id) && r.id !== opts.of);
	}
	return rows.slice(0, opts.limit ?? 20);
}

/** One-line digest: state, last event, link counts, task particulars. */
export function insightLine(store: SpecdStore, itemId: string): string {
	// Read the row fresh — a captured ItemRow can be stale the moment an
	// event lands (the projection moves under it).
	const item = getItem(store, itemId);
	if (!item) return `- **${itemId}** unknown item`;
	const events = history(store, itemId);
	const last = events.at(-1);
	const links = relatedItems(store, itemId, "part-of");
	const bits = [
		`${item.kind} · ${item.status}`,
		last ? `last: ${last.type}` : "no events",
		`links: ${links.length}`,
	];
	if (item.kind === "task") {
		if (item.path_scope) bits.push(`scope: ${item.path_scope}`);
		if (item.phase) bits.push(`phase: ${item.phase}`);
		if (item.parallel === 1) bits.push("[P]");
	}
	if (item.kind === "spec" && item.status === "approved") bits.push("approved ✓");
	return `- **${item.id}** ${item.title} — ${bits.join(" · ")}`;
}

/** Short summary for ONE item: state digest + the events that mattered
 * (status-changing / latest), not the full history. */
export function renderInsight(store: SpecdStore, itemId: string): string {
	const item = getItem(store, itemId);
	if (!item) return `Unknown item: ${itemId}.`;
	const events = history(store, itemId);
	const noteworthy = events
		.filter((e) =>
			[
				"explore.decided",
				"spec.approved",
				"spec.reopened",
				"task.exported",
				"work.started",
				"pr.created",
				"review.completed",
				"work.completed",
				"decision.made",
				"convergence.assessed",
			].includes(e.type),
		)
		.slice(-5);
	const eventLines = noteworthy
		.map((e) => {
			let detail = "";
			const parsed = parseJsonLoose<Record<string, unknown>>(e.payload);
			if (parsed) {
				for (const key of ["decision", "passed", "sink", "url", "branch"]) {
					if (parsed[key] !== undefined)
						detail += `${key}=${JSON.stringify(parsed[key])} `;
				}
			}
			return `- ${e.type}${detail ? ` — ${detail.trim()}` : ""}`;
		})
		.join("\n");
	const links = relatedItems(store, itemId, "part-of")
		.map((l) => `${l.id} (${l.kind})`)
		.join(", ");
	return [
		`**${item.id}** — ${item.title}`,
		`${item.kind} · ${item.status} · ${events.length} events · updated ${item.updated_at}`,
		links ? `links: ${links}` : "links: none",
		noteworthy.length
			? `key events:\n${eventLines}`
			: "key events: none recorded",
	].join("\n\n");
}
