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
 * Promoted-to pointers (acceptance criterion #9) become provenance
 * entries on the `imported` event payload, not edges. */

import type { ItemKind } from "../store/schema.js";
import type { SpecdStore } from "../store/store.js";
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
		"INSERT INTO events (item, type, payload, at, actor, batch) VALUES (?, 'imported', ?, ?, ?, ?)",
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
			insertEvent.run(id, JSON.stringify(step.provenance), now, actor, batch);
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
	return {
		created,
		linksAdded,
		linksSkipped,
		itemsSkipped: [],
		batch,
	};
}
