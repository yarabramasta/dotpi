import type { DatabaseSync } from "node:sqlite";
import {
	type EventType,
	ITEM_KINDS,
	ITEM_STATUSES,
	type ItemKind,
	type ItemStatus,
} from "./schema.js";
import type { ItemRow, SpecdEvent, SpecdStore } from "./store.js";

/** Projection rules: which event types move an item's status, and how body
 * evolves (created payload may seed it; body.updated replaces it; last wins).
 * explore.decided is payload-aware (stop → stopped). spec.reopened reverts a
 * spec to draft (evolution). imported/import.reverted projection handling
 * (knowledge items, batch exclusion) lands with migration in M2. */
const STATUS_RULES: Partial<Record<EventType, ItemStatus>> = {
	"spec.approved": "approved",
	"spec.reopened": "draft",
	"task.exported": "exported",
	"work.started": "in-progress",
	"work.completed": "done",
};

/** Pure projection: the item's current row derived from its full event
 * history. Used by both the incremental append path and doctor's replay,
 * so the two can never disagree by implementation. */
export function projectItem(
	events: SpecdEvent[],
): Omit<ItemRow, "id"> | undefined {
	const created = events[0];
	if (created?.type !== "created") return undefined;
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(created.payload) as Record<string, unknown>;
	} catch {
		return undefined;
	}
	// The created payload's kind is the starting point; kind.reclassified
	// events in the history can change it (dec-0014). Mutable for that.
	let kind: string = typeof payload.kind === "string" ? payload.kind : "";
	const title = payload.title;
	if (!kind || typeof title !== "string") return undefined;
	if (!(ITEM_KINDS as readonly string[]).includes(kind) && kind !== "knowledge")
		return undefined; // legacy knowledge rows still project
	let body = typeof payload.body === "string" ? payload.body : "";
	let pathScope =
		typeof payload.pathScope === "string" ? payload.pathScope : null;
	const phase = typeof payload.phase === "string" ? payload.phase : null;
	const parallel = payload.parallel === true ? 1 : 0;
	// The created payload may seed the initial status (imported items land
	// with their mapped source status); event rules below still override it.
	let status: ItemStatus = "draft";
	const seeded = payload.status;
	if (
		typeof seeded === "string" &&
		(ITEM_STATUSES as readonly string[]).includes(seeded)
	) {
		status = seeded as ItemStatus;
	}
	for (const event of events) {
		const next = STATUS_RULES[event.type];
		if (next) status = next;
		if (event.type === "explore.decided") {
			try {
				const parsed = JSON.parse(event.payload) as { decision?: string };
				if (parsed?.decision === "stop") status = "stopped";
			} catch {
				// malformed payload — keep prior status; doctor flags drift via replay
			}
		}
		if (event.type === "kind.reclassified") {
			try {
				const parsed = JSON.parse(event.payload) as { kind?: string };
				if (
					parsed?.kind &&
					(ITEM_KINDS as readonly string[]).includes(parsed.kind)
				) {
					kind = parsed.kind;
				}
				// invalid target kind — keep prior kind; doctor flags via replay
			} catch {
				// malformed payload — keep prior kind
			}
		}
		if (event.type === "body.updated") {
			try {
				const parsed = JSON.parse(event.payload) as Record<string, unknown>;
				if (typeof parsed.body === "string") body = parsed.body;
				if (typeof parsed.path_scope === "string")
					pathScope = parsed.path_scope;
			} catch {
				// malformed payload — keep prior body; doctor flags drift via replay
			}
		}
	}
	// SAFETY: kind was validated against ITEM_KINDS above, so the narrowing
	// from string is sound; path_scope was type-checked at read time.
	return {
		kind: kind as ItemKind,
		title,
		status,
		body,
		path_scope: pathScope,
		phase,
		parallel,
		created_at: created.at,
		updated_at: events.at(-1)?.at ?? created.at,
	};
}

export function eventsForItem(db: DatabaseSync, item: string): SpecdEvent[] {
	// SAFETY: the SELECT names exactly the SpecdEvent columns in order; row
	// shape matches the interface even though node:sqlite types rows as unknown.
	return db
		.prepare(
			"SELECT id, item, type, payload, at, actor, batch FROM events WHERE item = ? ORDER BY id ASC",
		)
		.all(item) as unknown as SpecdEvent[];
}

/** Rewrite one item's stored row + FTS entry from its full event history.
 * The canonical projection writer — append, import, and repair all go
 * through this so replay and storage can never diverge by implementation. */
export function recomputeProjection(db: DatabaseSync, item: string): void {
	const projected = projectItem(eventsForItem(db, item));
	if (!projected) return; // corrupt/missing created event — doctor flags drift
	db.prepare(
		"UPDATE items SET kind = ?, title = ?, status = ?, body = ?, path_scope = ?, phase = ?, parallel = ?, created_at = ?, updated_at = ? WHERE id = ?",
	).run(
		projected.kind,
		projected.title,
		projected.status,
		projected.body,
		projected.path_scope,
		projected.phase,
		projected.parallel,
		projected.created_at,
		projected.updated_at,
		item,
	);
	db.prepare("DELETE FROM item_fts WHERE id = ?").run(item);
	db.prepare("INSERT INTO item_fts (id, title, body) VALUES (?, ?, ?)").run(
		item,
		projected.title,
		projected.body,
	);
}

/** Recompute every item's projection from its events and compare with the
 * stored row. Used by doctor: drift here means the projection was touched
 * outside the event path. */
export function verifyProjections(
	store: SpecdStore,
): Array<{ id: string; detail: string }> {
	const drift: Array<{ id: string; detail: string }> = [];
	// SAFETY: single-column id rows only.
	const rows = store.db
		.prepare("SELECT id FROM items ORDER BY id ASC")
		.all() as unknown as Array<{ id: string }>;
	for (const { id } of rows) {
		const projected = projectItem(eventsForItem(store.db, id));
		const stored = store.db
			.prepare("SELECT * FROM items WHERE id = ?")
			.get(id) as ItemRow | undefined;
		if (!projected || !stored) {
			drift.push({ id, detail: "no created event; projection unrecoverable" });
			continue;
		}
		const mismatch =
			projected.kind !== stored.kind ||
			projected.title !== stored.title ||
			projected.status !== stored.status ||
			projected.body !== stored.body ||
			(projected.path_scope ?? null) !== (stored.path_scope ?? null) ||
			(projected.phase ?? null) !== (stored.phase ?? null) ||
			projected.parallel !== stored.parallel ||
			projected.created_at !== stored.created_at ||
			projected.updated_at !== stored.updated_at;
		if (mismatch) {
			drift.push({
				id,
				detail: `stored (${stored.kind}, ${stored.status}) differs from replayed (${projected.kind}, ${projected.status})`,
			});
		}
	}
	return drift;
}
