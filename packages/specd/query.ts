import {
	getItem,
	history,
	type ItemRow,
	listItems,
	parseJsonLoose,
	relatedItems,
	type SpecdStore,
} from "./src/store/store.js";

/** Item querying + short insight for the command flows. Pure: filters,
 * link traversal, and digest rendering — the tool layer just calls these
 * and returns the text. */

export type QueryRow = ItemRow & { source?: string };

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

export function queryItems(
	store: SpecdStore,
	opts: QueryOptions,
	referenced?: SpecdStore[],
): QueryRow[] {
	const filter = (rows: QueryRow[]) => {
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
		return rows;
	};
	let local: QueryRow[] = filter(
		listItems(store, { limit: 10000 }).map((r) => ({ ...r })),
	);
	if (opts.of) {
		// ponytail: of-scoping is local-only; links live in the local store,
		// so referenced stores are not searched when the query is link-scoped.
		const related = relatedItems(store, opts.of, "part-of");
		const ids = new Set(related.map((r) => r.id));
		local = local.filter((r) => ids.has(r.id) && r.id !== opts.of);
		return local.slice(0, opts.limit ?? 20);
	}
	let rows = local;
	for (const ref of referenced ?? []) {
		rows = rows.concat(
			filter(
				listItems(ref, { limit: 10000 }).map((r) => ({
					...r,
					source: ref.dir,
				})),
			),
		);
	}
	return rows.slice(0, opts.limit ?? 20);
}

/** One-line digest: state, last event, link counts, task particulars.
 * If the item is missing locally, looks it up in the referenced stores
 * and annotates the hit with `(from: {dir})`. */
export function insightLine(
	store: SpecdStore,
	itemId: string,
	referenced?: SpecdStore[],
	sourceDir?: string,
): string {
	// Read the row fresh — a captured ItemRow can be stale the moment an
	// event lands (the projection moves under it).
	let item = getItem(store, itemId);
	let sourceStore: SpecdStore = store;
	let fromNote = "";
	if (sourceDir && referenced) {
		const ref = referenced.find((r) => r.dir === sourceDir);
		if (ref) {
			const found = getItem(ref, itemId);
			if (found) {
				item = found;
				sourceStore = ref;
				fromNote = ` (from: ${ref.dir})`;
			}
		}
	}
	if (!item && referenced) {
		for (const ref of referenced) {
			const found = getItem(ref, itemId);
			if (found) {
				item = found;
				sourceStore = ref;
				fromNote = ` (from: ${ref.dir})`;
				break;
			}
		}
	}
	if (!item) return `- **${itemId}** unknown item`;
	const events = history(sourceStore, itemId);
	const last = events.at(-1);
	const links = relatedItems(sourceStore, itemId, "part-of");
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
	if (item.kind === "spec" && item.status === "approved")
		bits.push("approved ✓");
	return `- **${item.id}** ${item.title}${fromNote} — ${bits.join(" · ")}`;
}

/** Short summary for ONE item: state digest + the events that mattered
 * (status-changing / latest), not the full history. If the item is only
 * present in a referenced store, renders that store's history and notes
 * `(from: {dir})` under the title. */
export function renderInsight(
	store: SpecdStore,
	itemId: string,
	referenced?: SpecdStore[],
	sourceDir?: string,
): string {
	let item = getItem(store, itemId);
	let sourceStore: SpecdStore = store;
	let fromLine = "";
	if (sourceDir && referenced) {
		const ref = referenced.find((r) => r.dir === sourceDir);
		if (ref) {
			const found = getItem(ref, itemId);
			if (found) {
				item = found;
				sourceStore = ref;
				fromLine = `(from: ${ref.dir})`;
			}
		}
	}
	if (!item && referenced) {
		for (const ref of referenced) {
			const found = getItem(ref, itemId);
			if (found) {
				item = found;
				sourceStore = ref;
				fromLine = `(from: ${ref.dir})`;
				break;
			}
		}
	}
	if (!item) return `Unknown item: ${itemId}.`;
	const events = history(sourceStore, itemId);
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
	const links = relatedItems(sourceStore, itemId, "part-of")
		.map((l) => `${l.id} (${l.kind})`)
		.join(", ");
	const head: string[] = [`**${item.id}** — ${item.title}`];
	if (fromLine) head.push(fromLine);
	return [
		...head,
		`${item.kind} · ${item.status} · ${events.length} events · updated ${item.updated_at}`,
		links ? `links: ${links}` : "links: none",
		noteworthy.length
			? `key events:\n${eventLines}`
			: "key events: none recorded",
	].join("\n\n");
}
