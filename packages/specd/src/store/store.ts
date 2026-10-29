import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { migrateStore } from "./migrate.js";
import { eventsForItem, recomputeProjection } from "./projection.js";
import {
	applySchema,
	EVENT_TYPES,
	type EventType,
	ITEM_KINDS,
	type ItemKind,
	type LinkKind,
	parseJsonLoose,
	readSchemaVersion,
	SCHEMA_VERSION,
	tableExists,
} from "./schema.js";

// ponytail: keep re-exporting parseJsonLoose from here so existing callers
// that import it from ./store.js do not have to move.
export { parseJsonLoose } from "./schema.js";

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
	/** If true, the store may not be mutated locally (referenced stores and
	 * explicit read-only opens). Mutating functions must throw. */
	readOnly?: boolean;
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

import { resolveStoreDir } from "./registry.js";

/** True when cwd is a specd task worktree — the directories specd_start_work
 * itself creates as `<repo>-specd-<kind>-<id>` (see tools/exec-tools.ts).
 * Spawned child sessions run there, so this — not session identity — is the
 * reliable child signal: a session UUID is ephemeral and conversation-scoped,
 * while the store is durable, so binding ownership to it either locks out
 * legitimate sessions or is stolen by whoever opens the store first. */
export function isTaskWorktreeCwd(cwd: string): boolean {
	return new RegExp(`-specd-(${ITEM_KINDS.join("|")})-\\d{4,}$`).test(
		basename(cwd),
	);
}

/** Refuse store-mutating tool calls from spawned child sessions (specd task
 * worktree cwds). Reads stay open — children may inspect the store. */
export function assertParentContext(ctx: ExtensionContext): void {
	const cwd = ctx?.cwd;
	if (!cwd || !isTaskWorktreeCwd(cwd)) return;
	throw new Error(
		`no-specd-store-writes: ${basename(cwd)} is a specd task worktree — spawned child sessions must not mutate the specd store. Report results to the parent session; the parent records all specd events.`,
	);
}

export async function openStore(cwd: string): Promise<SpecdStore> {
	const sqlite = await import("node:sqlite").catch(() => undefined);
	if (!sqlite) {
		throw new Error(
			"specd store requires Node >= 22.13 (node:sqlite built-in). Current Node: " +
				process.version,
		);
	}
	// D11: the registry resolves external stores; the default is in-repo.
	const dir = resolveStoreDir(cwd);
	const path = join(dir, "store.db");
	mkdirSync(dir, { recursive: true });
	try {
		// db mode (default): store.db is rebuilt from events.jsonl on demand.
		writeFileSync(join(dir, ".gitignore"), "*\n!.gitignore\n!events.jsonl\n", {
			flag: "wx",
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	// Legacy/corrupt stores without a version stamp are never auto-migrated
	// (fail loudly). KNOWN older versions migrate forward in place through
	// store/migrate.ts; unknown/newer versions still fail loudly.
	if (!existsSync(path)) {
		const jsonlPath = join(dir, "events.jsonl");
		if (existsSync(jsonlPath)) {
			const db = new sqlite.DatabaseSync(path);
			applySchema(db);
			replayEventsJsonl(db, jsonlPath);
			db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
				"schema_version",
				SCHEMA_VERSION,
			);
			return { db, cwd, dir, path };
		}
	}

	let db: DatabaseSync;
	try {
		db = new sqlite.DatabaseSync(path);
	} catch (error) {
		throw new Error(`Could not create specd store at ${path}: ${error}`);
	}
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

/** Open a store read-only. Three cases:
 * - store.db exists → open it read-only.
 * - store.db missing, events.jsonl exists → replay into an in-memory DB
 *   so the referenced directory is untouched.
 * - neither exists → undefined. */
export function openStoreReadOnly(dir: string): SpecdStore | undefined {
	const dbPath = join(dir, "store.db");
	const jsonlPath = join(dir, "events.jsonl");
	if (existsSync(dbPath)) {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		if (!tableExists(db, "items")) {
			db.close();
			return undefined;
		}
		return { db, cwd: dir, dir, path: dbPath };
	}
	if (!existsSync(jsonlPath)) return undefined;
	const db = new DatabaseSync(":memory:");
	applySchema(db);
	replayEventsJsonl(db, jsonlPath);
	db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
		"schema_version",
		SCHEMA_VERSION,
	);
	return {
		db,
		cwd: dir,
		dir,
		path: dbPath,
		readOnly: true,
	};
}

function eventsJsonlPath(dir: string): string {
	return join(dir, "events.jsonl");
}

export function appendEventsJsonl(
	store: SpecdStore,
	events: ReadonlyArray<SpecdEvent>,
): void {
	const path = eventsJsonlPath(store.dir);
	for (const event of events) {
		const line = `${JSON.stringify({
			id: event.id,
			item: event.item,
			type: event.type,
			payload: event.payload,
			at: event.at,
			actor: event.actor,
			batch: event.batch,
		})}\n`;
		appendFileSync(path, line);
	}
}

function persistEventJsonl(store: SpecdStore, event: SpecdEvent): void {
	appendEventsJsonl(store, [event]);
}

function assertWritable(store: SpecdStore): void {
	if (store.readOnly) {
		throw new Error("Referenced stores are read-only.");
	}
}

// ponytail: links are not event-sourced — they live in the links table,
// not the events.jsonl WAL. A replay rebuilds items and events but does
// not restore hand-created links. Upgrade path: event-source links
// (link.added/link.removed events) or persist links to a sidecar jsonl.
function replayEventsJsonl(db: DatabaseSync, jsonlPath: string): void {
	const raw = readFileSync(jsonlPath, "utf-8");
	const lines = raw.split("\n").filter((line) => line.trim() !== "");
	type Seed = {
		id: string;
		kind: string;
		title: string;
		body: string;
		pathScope: string | null;
		phase: string | null;
		parallel: number;
		createdAt: string;
		updatedAt: string;
	};
	const seeds = new Map<string, Seed>();
	const events: SpecdEvent[] = [];

	for (let i = 0; i < lines.length; i++) {
		const parsed = parseJsonLoose<Record<string, unknown>>(lines[i]);
		if (!parsed) {
			throw new Error(
				`events.jsonl line ${i + 1} is not valid JSON: ${lines[i].slice(0, 200)}`,
			);
		}
		for (const key of [
			"id",
			"item",
			"type",
			"payload",
			"at",
			"actor",
			"batch",
		]) {
			if (!(key in parsed)) {
				throw new Error(
					`events.jsonl line ${i + 1} is missing field '${key}': ${lines[i].slice(0, 200)}`,
				);
			}
		}
		// SAFETY: required fields were just checked above; EVENT_TYPES validates
		// the type value. The cast avoids impossible precise typing here.
		const event = parsed as unknown as SpecdEvent;
		if (!(EVENT_TYPES as readonly string[]).includes(event.type)) {
			throw new Error(
				`events.jsonl line ${i + 1} has unknown event type: ${event.type}`,
			);
		}
		events.push(event);
	}

	for (const event of events) {
		if (event.type === "created") {
			if (seeds.has(event.item)) continue;
			const payload = parseJsonLoose<Record<string, unknown>>(event.payload);
			if (
				!payload ||
				typeof payload.kind !== "string" ||
				typeof payload.title !== "string"
			) {
				throw new Error(
					`events.jsonl created event for ${event.item} has invalid payload`,
				);
			}
			seeds.set(event.item, {
				id: event.item,
				kind: payload.kind,
				title: payload.title,
				body: typeof payload.body === "string" ? payload.body : "",
				pathScope:
					typeof payload.pathScope === "string" ? payload.pathScope : null,
				phase: typeof payload.phase === "string" ? payload.phase : null,
				parallel: payload.parallel === true ? 1 : 0,
				createdAt: event.at,
				updatedAt: event.at,
			});
		}
	}

	for (const [itemId, seed] of seeds) {
		db.prepare(
			"INSERT OR IGNORE INTO items (id, kind, title, status, body, path_scope, phase, parallel, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)",
		).run(
			itemId,
			seed.kind,
			seed.title,
			seed.body,
			seed.pathScope,
			seed.phase,
			seed.parallel,
			seed.createdAt,
			seed.updatedAt,
		);
	}

	for (const event of events) {
		if (!seeds.has(event.item)) {
			throw new Error(
				`events.jsonl references unknown item ${event.item} before its created event`,
			);
		}
		db.prepare(
			"INSERT INTO events (id, item, type, payload, at, actor, batch) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			event.id,
			event.item,
			event.type,
			event.payload,
			event.at,
			event.actor,
			event.batch,
		);
		recomputeProjection(db, event.item);
	}
}

function nextId(db: DatabaseSync, kind: ItemKind): string {
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM items WHERE id LIKE ? || '-%'")
		.get(kind) as { n: number };
	return `${kind}-${String(row.n + 1).padStart(4, "0")}`;
}

export function createItem(store: SpecdStore, input: CreateItemInput): ItemRow {
	assertWritable(store);
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
	// SAFETY: column list matches SpecdEvent exactly; row is known to exist
	// because the created event was inserted in the transaction above.
	const createdEvent = store.db
		.prepare(
			"SELECT id, item, type, payload, at, actor, batch FROM events WHERE item = ? ORDER BY id ASC LIMIT 1",
		)
		.get(id) as unknown as SpecdEvent;
	persistEventJsonl(store, createdEvent);
	const created = getItem(store, id);
	if (!created) throw new Error(`Failed to create item ${id}.`);
	return created;
}

export function appendEvent(
	store: SpecdStore,
	input: AppendEventInput,
): SpecdEvent {
	assertWritable(store);
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
	if (input.type === "kind.reclassified") {
		const target = (input.payload as Record<string, unknown> | undefined)?.kind;
		if (
			typeof target !== "string" ||
			!(ITEM_KINDS as readonly string[]).includes(target)
		) {
			throw new Error(
				`Unknown or retired item kind: ${String(target)}. Valid: ${ITEM_KINDS.join(", ")}.`,
			);
		}
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
	const event = store.db
		.prepare(
			"SELECT id, item, type, payload, at, actor, batch FROM events WHERE item = ? ORDER BY id DESC LIMIT 1",
		)
		.get(input.item) as unknown as SpecdEvent;
	persistEventJsonl(store, event);
	return event;
}

export function addLink(
	store: SpecdStore,
	fromItem: string,
	toItem: string,
	kind: LinkKind,
): void {
	assertWritable(store);
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
