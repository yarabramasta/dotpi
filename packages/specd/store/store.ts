import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrateStore } from "./migrate.js";
import {
	applySchema,
	EVENT_TYPES,
	type EventType,
	ITEM_KINDS,
	ITEM_STATUSES,
	type ItemKind,
	type ItemStatus,
	type LinkKind,
	readSchemaVersion,
	SCHEMA_VERSION,
	tableExists,
} from "./schema.js";

export interface SpecdEvent {
	id: number;
	item: string;
	type: EventType;
	payload: string;
	at: string;
	actor: string;
	batch: string | null;
}

export interface ItemRow {
	id: string;
	kind: ItemKind;
	title: string;
	status: string;
	body: string;
	path_scope: string | null;
	phase: string | null;
	parallel: number;
	created_at: string;
	updated_at: string;
}

export interface SpecdStore {
	db: DatabaseSync;
	cwd: string;
	dir: string;
	path: string;
}

export interface AppendEventInput {
	item: string;
	type: EventType;
	payload?: Record<string, unknown>;
	actor: string;
	batch?: string;
}

export interface CreateItemInput {
	kind: ItemKind;
	title: string;
	body?: string;
	pathScope?: string;
	/** Task execution phase (setup/foundational/story/polish) — M2 task
	 * phases feeding the M3 scheduler. */
	phase?: string;
	/** Parallel-safe marker: the task may run concurrently with others. */
	parallel?: boolean;
	/** Kind-specific extras merged into the created event payload (e.g.
	 * checklists carry { items: [...] }). The projection ignores unknown
	 * fields; domain helpers read them from history. */
	extra?: Record<string, unknown>;
	actor: string;
}

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

// ponytail: single-writer-at-a-time assumption; BEGIN IMMEDIATE guards the
// multi-statement append path without a full locking story.
function withTransaction(db: DatabaseSync, fn: () => void): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		fn();
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

/** Tolerant JSON parse for stored/external payloads — malformed input
 * becomes undefined and the caller decides the plain-language handling. */
export function parseJsonLoose<T>(raw: string): T | undefined {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

export async function openStore(cwd: string): Promise<SpecdStore> {
	const sqlite = await import("node:sqlite").catch(() => undefined);
	if (!sqlite) {
		throw new Error(
			"specd store requires Node >= 22.13 (node:sqlite built-in). Current Node: " +
				process.version,
		);
	}
	const dir = join(cwd, ".spec");
	const path = join(dir, "store.db");
	mkdirSync(dir, { recursive: true });
	try {
		// db mode (default): the store is per-machine and repo-quiet.
		writeFileSync(join(dir, ".gitignore"), "*\n!.gitignore\n", { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	// Legacy/corrupt stores without a version stamp are never auto-migrated
	// (fail loudly). KNOWN older versions migrate forward in place through
	// store/migrate.ts; unknown/newer versions still fail loudly.
	const db = new sqlite.DatabaseSync(path);
	const version = readSchemaVersion(db);
	if (version === undefined) {
		if (tableExists(db, "items") || tableExists(db, "events")) {
			db.close();
			throw new Error(
				".spec/store.db has no schema_version — legacy or corrupt store; it cannot be opened safely.",
			);
		}
	} else if (version !== SCHEMA_VERSION) {
		for (const note of migrateStore(db, version, SCHEMA_VERSION)) {
			console.warn(`specd: ${note}`);
		}
	}

	applySchema(db);
	db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
		"schema_version",
		SCHEMA_VERSION,
	);
	return { db, cwd, dir, path };
}

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
	const kind = payload.kind;
	const title = payload.title;
	if (typeof kind !== "string" || typeof title !== "string") return undefined;
	if (!(ITEM_KINDS as readonly string[]).includes(kind)) return undefined;
	let body = typeof payload.body === "string" ? payload.body : "";
	const pathScope =
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
		if (event.type === "body.updated") {
			try {
				const parsed = JSON.parse(event.payload) as Record<string, unknown>;
				if (typeof parsed.body === "string") body = parsed.body;
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

function eventsForItem(db: DatabaseSync, item: string): SpecdEvent[] {
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

function nextId(db: DatabaseSync, kind: ItemKind): string {
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM items WHERE id LIKE ? || '-%'")
		.get(kind) as { n: number };
	return `${kind}-${String(row.n + 1).padStart(4, "0")}`;
}

export function createItem(store: SpecdStore, input: CreateItemInput): ItemRow {
	if (!(ITEM_KINDS as readonly string[]).includes(input.kind)) {
		throw new Error(
			`Unknown item kind: ${input.kind}. Valid: ${ITEM_KINDS.join(", ")}.`,
		);
	}
	if (!input.title.trim()) {
		throw new Error("Item title must not be empty.");
	}
	const id = nextId(store.db, input.kind);
	const at = nowIso();
	// status is never agent-seedable via extras — the initial-status seed
	// in the created payload is importer-only, so spec.approved etc. can't
	// be bypassed by passing extra={status: "approved"}.
	const extra = { ...(input.extra ?? {}) };
	delete (extra as Record<string, unknown>).status;
	withTransaction(store.db, () => {
		store.db
			.prepare(
				"INSERT INTO items (id, kind, title, status, body, path_scope, phase, parallel, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				input.kind,
				input.title,
				input.body ?? "",
				input.pathScope ?? null,
				input.phase ?? null,
				input.parallel === true ? 1 : 0,
				at,
				at,
			);
		store.db
			.prepare(
				"INSERT INTO events (item, type, payload, at, actor) VALUES (?, 'created', ?, ?, ?)",
			)
			.run(
				id,
				JSON.stringify({
					kind: input.kind,
					title: input.title,
					body: input.body ?? "",
					pathScope: input.pathScope ?? null,
					phase: input.phase ?? null,
					parallel: input.parallel === true,
					...extra,
				}),
				at,
				input.actor,
			);
		recomputeProjection(store.db, id);
	});
	const created = getItem(store, id);
	if (!created) throw new Error(`Failed to create item ${id}.`);
	return created;
}

export function appendEvent(
	store: SpecdStore,
	input: AppendEventInput,
): SpecdEvent {
	if (!(EVENT_TYPES as readonly string[]).includes(input.type)) {
		throw new Error(
			`Unknown event type: ${input.type}. Valid: ${EVENT_TYPES.join(", ")}.`,
		);
	}
	const exists = store.db
		.prepare("SELECT id FROM items WHERE id = ?")
		.get(input.item);
	if (!exists) {
		throw new Error(`Unknown item: ${input.item}.`);
	}
	const at = nowIso();
	const payload = JSON.stringify(input.payload ?? {});
	withTransaction(store.db, () => {
		store.db
			.prepare(
				"INSERT INTO events (item, type, payload, at, actor, batch) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				input.item,
				input.type,
				payload,
				at,
				input.actor,
				input.batch ?? null,
			);
		recomputeProjection(store.db, input.item);
	});
	// SAFETY: this SELECT reads back the row just inserted (same WHERE and
	// ordering as the INSERT above); shape matches SpecdEvent by construction.
	return store.db
		.prepare(
			"SELECT id, item, type, payload, at, actor, batch FROM events WHERE item = ? ORDER BY id DESC LIMIT 1",
		)
		.get(input.item) as unknown as SpecdEvent;
}

export function addLink(
	store: SpecdStore,
	fromItem: string,
	toItem: string,
	kind: LinkKind,
): void {
	if (!getItem(store, fromItem)) throw new Error(`Unknown item: ${fromItem}.`);
	if (!getItem(store, toItem)) throw new Error(`Unknown item: ${toItem}.`);
	store.db
		.prepare(
			"INSERT OR IGNORE INTO links (from_item, to_item, kind) VALUES (?, ?, ?)",
		)
		.run(fromItem, toItem, kind);
}

export function getItem(store: SpecdStore, id: string): ItemRow | undefined {
	// SAFETY: SELECT * on items returns the ItemRow column order; status/kind
	// are validated at the event boundary, not here.
	return store.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as
		| ItemRow
		| undefined;
}

export interface ListItemsOptions {
	kind?: ItemKind;
	status?: string;
	limit?: number;
}

export function listItems(
	store: SpecdStore,
	options: ListItemsOptions = {},
): ItemRow[] {
	const limit = options.limit ?? 50;
	// SAFETY: SELECT * on items matches ItemRow; every filter is a bound
	// parameter (NULL disables the clause), so no SQL is ever interpolated.
	return store.db
		.prepare(
			"SELECT * FROM items WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR status = ?) ORDER BY updated_at DESC, id ASC LIMIT ?",
		)
		.all(
			options.kind ?? null,
			options.kind ?? null,
			options.status ?? null,
			options.status ?? null,
			limit,
		) as unknown as ItemRow[];
}

export interface KindStatusCount {
	kind: string;
	status: string;
	n: number;
}

export function counts(store: SpecdStore): KindStatusCount[] {
	// SAFETY: aggregate SELECT names kind/status/n exactly.
	return store.db
		.prepare(
			"SELECT kind, status, COUNT(*) AS n FROM items GROUP BY kind, status ORDER BY kind, status",
		)
		.all() as unknown as KindStatusCount[];
}

export function history(store: SpecdStore, item: string): SpecdEvent[] {
	return eventsForItem(store.db, item);
}

/** Items pointing AT `itemId` with the given kind — the directional
 * child/ingredient lookup (`spec part-of roadmap` → the roadmap's
 * children). Direction matters for ladder rules: an epic↔roadmap edge
 * must not make the epic one of the roadmap's slices. */
export function childItems(
	store: SpecdStore,
	itemId: string,
	kind: LinkKind,
): ItemRow[] {
	// SAFETY: SELECT f.* on items (aliased f) matches ItemRow.
	return store.db
		.prepare(
			"SELECT f.* FROM links l JOIN items f ON f.id = l.from_item WHERE l.to_item = ? AND l.kind = ?",
		)
		.all(itemId, kind) as unknown as ItemRow[];
}
export function linkedItems(
	store: SpecdStore,
	fromItem: string,
	kind: LinkKind,
): ItemRow[] {
	// SAFETY: SELECT * on items (aliased t) matches ItemRow.
	return store.db
		.prepare(
			"SELECT t.* FROM links l JOIN items t ON t.id = l.to_item WHERE l.from_item = ? AND l.kind = ?",
		)
		.all(fromItem, kind) as unknown as ItemRow[];
}

/** Items related to itemId by a link kind in EITHER direction, deduplicated.
 * Use when the relation's direction is a modeling convention, not a query
 * constraint (e.g. checklists attached to a spec). */
export function relatedItems(
	store: SpecdStore,
	itemId: string,
	kind: LinkKind,
): ItemRow[] {
	// SAFETY: SELECT f.*/t.* on items matches ItemRow.
	const outgoing = store.db
		.prepare(
			"SELECT t.* FROM links l JOIN items t ON t.id = l.to_item WHERE l.from_item = ? AND l.kind = ?",
		)
		.all(itemId, kind) as unknown as ItemRow[];
	// SAFETY: incoming direction — the joined row is still a full items row.
	const incoming = store.db
		.prepare(
			"SELECT f.* FROM links l JOIN items f ON f.id = l.from_item WHERE l.to_item = ? AND l.kind = ?",
		)
		.all(itemId, kind) as unknown as ItemRow[];
	const byId = new Map<string, ItemRow>();
	for (const row of [...outgoing, ...incoming]) byId.set(row.id, row);
	return [...byId.values()];
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
		const stored = getItem(store, id);
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
