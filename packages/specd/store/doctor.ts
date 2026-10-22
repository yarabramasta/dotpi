import { readSchemaVersion, SCHEMA_VERSION } from "./schema.js";
import { type SpecdStore, verifyProjections } from "./store.js";

export interface DoctorFinding {
	kind: string;
	detail: string;
}

/** Store integrity audit. Every finding is plain-language: what is wrong and
 * why it matters. Clean output means the projection is replayable from the
 * event history — the core state-integrity guarantee. */
export function runDoctor(store: SpecdStore): DoctorFinding[] {
	const findings: DoctorFinding[] = [];

	const version = readSchemaVersion(store.db);
	if (version !== SCHEMA_VERSION) {
		findings.push({
			kind: "schema",
			detail: `schema version is ${version ?? "missing"} (expected ${SCHEMA_VERSION}); the store may be from another version of specd.`,
		});
	}

	// SAFETY: two-column rows (item ids) matching the destructure below.
	const orphanEvents = store.db
		.prepare(
			"SELECT DISTINCT e.item AS item FROM events e LEFT JOIN items i ON i.id = e.item WHERE i.id IS NULL",
		)
		.all() as unknown as Array<{ item: string }>;
	for (const { item } of orphanEvents) {
		findings.push({
			kind: "orphan-event",
			detail: `events reference item ${item}, which does not exist.`,
		});
	}

	// SAFETY: three-column rows (from, to, kind) matching the destructure.
	const orphanLinks = store.db
		.prepare(
			"SELECT l.from_item AS from_item, l.to_item AS to_item, l.kind AS kind FROM links l LEFT JOIN items f ON f.id = l.from_item LEFT JOIN items t ON t.id = l.to_item WHERE f.id IS NULL OR t.id IS NULL",
		)
		.all() as unknown as Array<{
		from_item: string;
		to_item: string;
		kind: string;
	}>;
	for (const link of orphanLinks) {
		findings.push({
			kind: "orphan-link",
			detail: `link ${link.from_item} -[${link.kind}]-> ${link.to_item} references a missing item.`,
		});
	}

	for (const drift of verifyProjections(store)) {
		findings.push({
			kind: "projection-drift",
			detail: `${drift.id}: ${drift.detail}. The stored state no longer matches the event history.`,
		});
	}

	// SAFETY: single-column counts.
	const ftsRows = store.db
		.prepare("SELECT COUNT(*) AS n FROM item_fts")
		.get() as { n: number };
	const itemRows = store.db
		.prepare("SELECT COUNT(*) AS n FROM items")
		.get() as { n: number };
	if (ftsRows.n !== itemRows.n) {
		findings.push({
			kind: "search-index",
			detail: `search index has ${ftsRows.n} entries for ${itemRows.n} items; rebuild needed.`,
		});
	}

	return findings;
}
