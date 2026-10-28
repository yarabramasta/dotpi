/** Grill→specd importer. Single-transaction, idempotent.
 *
 * The runner opens the target specd store, plans every item + link from
 * a mapped snapshot, then writes them in one BEGIN IMMEDIATE / COMMIT.
 * If anything throws mid-import, ROLLBACK leaves the store untouched.
 *
 * Idempotency: each imported item carries an `imported` event whose
 * payload records `{origin: "grill", atom_id: <origin>}`; the planner
 * skips origin-ids that already have such an event in the target store.
 *
 * Event history: every item's history starts with a `created` event
 * (carrying the mapped status as the initial-status seed), then the
 * `imported` provenance event. Replay via recomputeProjection then
 * reproduces the stored rows exactly — doctor stays clean.
 *
 * Promoted-to pointers (acceptance criterion #9) become provenance
 * entries on the `imported` event payload, not edges. */

import { recomputeProjection } from "../store/projection.js";
import type { ItemKind } from "../store/schema.js";
import {
	appendEventsJsonl,
	type SpecdEvent,
	type SpecdStore,
} from "../store/store.js";
import type { MappedItem, MappedLink, MappedSnapshot } from "./map.js";

export interface ImportReport {
	created: ReadonlyArray<{ originId: string; itemId: string; kind: ItemKind }>;
	linksAdded: number;
	linksSkipped: number;
	itemsSkipped: ReadonlyArray<string>;
	batch: string;
}

export interface PlanStep {
	originId: string;
	kind: ItemKind;
	title: string;
	body: string;
	status: MappedItem["status"];
	scope: string | null;
	provenance: Record<string, unknown>;
}

/** Return all `imported` events recorded against items in this store,
 * grouped by origin_id from the payload. Used to skip already-imported
 * atoms on re-run. */
function existingOrigins(store: SpecdStore): Set<string> {
	const rows = store.db
		.prepare("SELECT payload FROM events WHERE type = 'imported'")
		.all() as Array<{ payload: string }>;
	const origins = new Set<string>();
	for (const row of rows) {
		try {
			const payload = JSON.parse(row.payload) as {
				origin?: string;
				atom_id?: string;
			};
			if (payload.origin === "grill" && typeof payload.atom_id === "string") {
				origins.add(payload.atom_id);
			}
		} catch {
			// Skip malformed payloads; the importer's writes always JSON-encode.
		}
	}
	return origins;
}

/** Highest existing item number for a given kind prefix (e.g.
 * `knowledge-` → 17 returns 17, returns 0 if none exist). */
function nextIdForKind(store: SpecdStore, kind: ItemKind): number {
	const prefix = `${kind}-`;
	const row = store.db
		.prepare("SELECT id FROM items WHERE id LIKE ? ORDER BY id DESC LIMIT 1")
		.get(`${prefix}%`) as { id: string } | undefined;
	if (!row) return 0;
	const n = Number.parseInt(row.id.slice(prefix.length), 10);
	return Number.isFinite(n) ? n : 0;
}

function isoFromEpoch(ms: number): string {
	return new Date(ms).toISOString();
}

function buildProvenance(item: MappedItem): Record<string, unknown> {
	const provenance: Record<string, unknown> = {
		origin: "grill",
		atom_id: item.originId,
		original_type: item.originalType,
		original_status: item.originalStatus,
		original_created_at: isoFromEpoch(item.createdAt),
	};
	if (item.promotedTo) {
		provenance.original_promoted_to = item.promotedTo;
	}
	if (item.sources) {
		try {
			provenance.original_sources = JSON.parse(item.sources);
		} catch {
			provenance.original_sources = item.sources;
		}
	}
	return provenance;
}

/** Plan the import: choose new IDs, partition items by skip-or-create,
 * partition links by edge-kind + endpoint existence. Pure — no writes. */
export function planImport(
	store: SpecdStore,
	mapped: MappedSnapshot,
	_batch: string,
): {
	steps: PlanStep[];
	links: ReadonlyArray<MappedLink>;
	created: ReadonlyArray<{ originId: string; itemId: string; kind: ItemKind }>;
	skippedItems: ReadonlyArray<string>;
} {
	const seen = existingOrigins(store);
	const counters: Partial<Record<ItemKind, number>> = {};
	const idMap = new Map<string, string>(); // origin → new specd id
	const created: Array<{ originId: string; itemId: string; kind: ItemKind }> =
		[];
	const skippedItems: string[] = [];
	const steps: PlanStep[] = [];

	for (const item of mapped.items) {
		if (seen.has(item.originId)) {
			skippedItems.push(item.originId);
			continue;
		}
		const kind = item.kind;
		const counter = counters[kind] ?? nextIdForKind(store, kind);
		counters[kind] = counter + 1;
		const id = `${kind}-${String(counter + 1).padStart(4, "0")}`;
		idMap.set(item.originId, id);
		created.push({ originId: item.originId, itemId: id, kind });
		steps.push({
			originId: item.originId,
			kind,
			title: item.title,
			body: item.body,
			status: item.status,
			scope: item.scope,
			provenance: buildProvenance(item),
		});
	}

	// Map links: keep only edges whose endpoints are both being imported.
	const validLinks: MappedLink[] = [];
	for (const link of mapped.links) {
		const from = idMap.get(link.fromOriginId);
		const to = idMap.get(link.toOriginId);
		if (!from || !to) continue;
		validLinks.push({
			fromOriginId: link.fromOriginId,
			toOriginId: link.toOriginId,
			kind: link.kind,
		});
	}
	return { steps, links: validLinks, created, skippedItems };
}

/** Run an approved plan inside one transaction. Throws → ROLLBACK leaves
 * the store untouched. The batch string ties every event in this import
 * together for downstream filtering. */
export function applyImport(
	store: SpecdStore,
	steps: ReadonlyArray<PlanStep>,
	links: ReadonlyArray<MappedLink>,
	idMap: Map<string, string>,
	batch: string,
	actor: string,
): ImportReport {
	const insertItem = store.db.prepare(
		"INSERT INTO items (id, kind, title, status, body, path_scope, phase, parallel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertEvent = store.db.prepare(
		"INSERT INTO events (item, type, payload, at, actor, batch) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const insertLink = store.db.prepare(
		"INSERT OR IGNORE INTO links (from_item, to_item, kind) VALUES (?, ?, ?)",
	);

	const created: Array<{ originId: string; itemId: string; kind: ItemKind }> =
		[];
	let linksAdded = 0;
	let linksSkipped = 0;

	store.db.exec("BEGIN IMMEDIATE");
	try {
		const now = new Date().toISOString();
		for (const step of steps) {
			const id = idMap.get(step.originId);
			if (!id) throw new Error(`Plan step missing id for ${step.originId}`);
			insertItem.run(
				id,
				step.kind,
				step.title,
				step.status,
				step.body,
				step.scope,
				null,
				0,
				now,
				now,
			);
			// History starts with `created` (mapped status as the seed),
			// then the `imported` provenance event — replay equals storage.
			insertEvent.run(
				id,
				"created",
				JSON.stringify({
					kind: step.kind,
					title: step.title,
					body: step.body,
					pathScope: step.scope,
					phase: null,
					parallel: false,
					status: step.status,
				}),
				now,
				actor,
				batch,
			);
			insertEvent.run(
				id,
				"imported",
				JSON.stringify(step.provenance),
				now,
				actor,
				batch,
			);
			recomputeProjection(store.db, id);
			created.push({ originId: step.originId, itemId: id, kind: step.kind });
		}
		for (const link of links) {
			const from = idMap.get(link.fromOriginId);
			const to = idMap.get(link.toOriginId);
			if (!from || !to) {
				linksSkipped += 1;
				continue;
			}
			const result = insertLink.run(from, to, link.kind);
			if (result.changes > 0) linksAdded += 1;
			else linksSkipped += 1;
		}
		store.db.exec("COMMIT");
	} catch (error) {
		store.db.exec("ROLLBACK");
		throw error;
	}

	// Persist every inserted event to the WAL so the store can be rebuilt
	// from events.jsonl alone.
	const insertedEvents: SpecdEvent[] = [];
	for (const step of steps) {
		const id = idMap.get(step.originId);
		if (!id) continue;
		// SAFETY: SELECT names SpecdEvent columns in order; the rows were
		// inserted above and match the interface by construction.
		const events = store.db
			.prepare(
				"SELECT id, item, type, payload, at, actor, batch FROM events WHERE item = ? ORDER BY id ASC",
			)
			.all(id) as unknown as SpecdEvent[];
		insertedEvents.push(...events);
	}
	insertedEvents.sort((a, b) => a.id - b.id);
	appendEventsJsonl(store, insertedEvents);

	return {
		created,
		linksAdded,
		linksSkipped,
		itemsSkipped: [],
		batch,
	};
}

export interface ImportBatchSummary {
	batch: string;
	items: number;
	at: string | null;
}

/** Distinct import batches present in the store, oldest first. The batch
 * id is the revert handle. */
export function listImportBatches(store: SpecdStore): ImportBatchSummary[] {
	// SAFETY: three-column rows (batch, count, min-at) matching the
	// destructure below.
	const rows = store.db
		.prepare(
			"SELECT batch, COUNT(DISTINCT item) AS n, MIN(at) AS at FROM events WHERE type = 'imported' AND batch IS NOT NULL GROUP BY batch ORDER BY MIN(at)",
		)
		.all() as unknown as Array<{ batch: string; n: number; at: string | null }>;
	return rows.map((r) => ({ batch: r.batch, items: r.n, at: r.at }));
}

export interface RevertReport {
	batch: string;
	itemsRemoved: string[];
	linksRemoved: number;
}

/** Revert one import batch: remove every item whose entire event history
 * belongs to the batch, together with its events, links, and FTS rows —
 * the projection returns to the exact pre-import state (doctor-clean).
 * Atomic: any batch item carrying post-import work (events outside the
 * batch) or linked to a native item refuses the whole revert — user work
 * is never silently destroyed. */
export function revertImport(store: SpecdStore, batch: string): RevertReport {
	// SAFETY: single-column rows (item ids) matching the destructure below.
	const batchItems = store.db
		.prepare(
			"SELECT DISTINCT item FROM events WHERE type = 'imported' AND batch = ?",
		)
		.all(batch) as unknown as Array<{ item: string }>;
	const itemIds = batchItems.map((r) => r.item);
	if (itemIds.length === 0) {
		throw new Error(
			`No imported items found for batch ${batch}. Known batches: ${
				listImportBatches(store)
					.map((b) => b.batch)
					.join(", ") || "none"
			}.`,
		);
	}
	// Stage the batch's item ids in a temp table so every statement below
	// is fully static SQL — nothing is ever interpolated into a query.
	store.db.exec(
		"CREATE TEMP TABLE IF NOT EXISTS revert_ids (id TEXT PRIMARY KEY)",
	);
	store.db.exec("DELETE FROM revert_ids");
	const insertId = store.db.prepare("INSERT INTO revert_ids (id) VALUES (?)");
	for (const id of itemIds) insertId.run(id);

	// SAFETY: single-column rows (item ids) matching the destructure below.
	const withOutsideWork = store.db
		.prepare(
			"SELECT DISTINCT e.item AS item FROM events e WHERE e.item IN (SELECT id FROM revert_ids) AND (e.batch IS NULL OR e.batch != ?)",
		)
		.all(batch) as unknown as Array<{ item: string }>;
	if (withOutsideWork.length > 0) {
		throw new Error(
			`Batch ${batch} cannot be reverted: ${withOutsideWork.map((r) => r.item).join(", ")} carries post-import events. Worked-on imports are not revertible — remove them individually instead.`,
		);
	}
	// SAFETY: two-column rows (from_item, to_item) matching the destructure.
	const cross = store.db
		.prepare(
			"SELECT from_item, to_item FROM links WHERE (from_item IN (SELECT id FROM revert_ids) AND to_item NOT IN (SELECT id FROM revert_ids)) OR (to_item IN (SELECT id FROM revert_ids) AND from_item NOT IN (SELECT id FROM revert_ids))",
		)
		.all() as unknown as Array<{
		from_item: string;
		to_item: string;
	}>;
	if (cross.length > 0) {
		const l = cross[0];
		throw new Error(
			`Batch ${batch} cannot be reverted: imported items are linked to native items (e.g. ${l.from_item} → ${l.to_item}). Unlink them first — reverting must not destroy links you created by hand.`,
		);
	}

	let linksRemoved = 0;
	store.db.exec("BEGIN IMMEDIATE");
	try {
		const linksResult = store.db
			.prepare(
				"DELETE FROM links WHERE from_item IN (SELECT id FROM revert_ids) OR to_item IN (SELECT id FROM revert_ids)",
			)
			.run();
		linksRemoved = Number(linksResult.changes);
		store.db
			.prepare("DELETE FROM item_fts WHERE id IN (SELECT id FROM revert_ids)")
			.run();
		store.db
			.prepare("DELETE FROM events WHERE item IN (SELECT id FROM revert_ids)")
			.run();
		store.db
			.prepare(
				"DELETE FROM promotions WHERE item_id IN (SELECT id FROM revert_ids)",
			)
			.run();
		store.db
			.prepare("DELETE FROM items WHERE id IN (SELECT id FROM revert_ids)")
			.run();
		store.db.exec("COMMIT");
	} catch (error) {
		store.db.exec("ROLLBACK");
		throw error;
	} finally {
		store.db.exec("DROP TABLE IF EXISTS temp.revert_ids");
	}
	return { batch, itemsRemoved: itemIds, linksRemoved };
}
