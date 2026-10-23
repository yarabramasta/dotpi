import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "4";

/** Vendor-neutral item kinds. Contract test bans sink names here. */
export const ITEM_KINDS = [
	"spec",
	"plan",
	"task",
	"cycle",
	"epic",
	"roadmap",
	"constitution",
	"checklist",
	"knowledge",
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Projection statuses. Event rules in store.ts map events onto these. */
export const ITEM_STATUSES = [
	"draft",
	"approved",
	"exported",
	"in-progress",
	"done",
	"stopped",
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Append-only event vocabulary. Unknown types are rejected at append. */
export const EVENT_TYPES = [
	"created",
	"question.answered",
	"decision.made",
	"evidence.added",
	"body.updated",
	"explore.decided",
	"spec.approved",
	"spec.reopened",
	"task.exported",
	"work.started",
	"pr.created",
	"work.paused",
	"work.resumed",
	"review.completed",
	"work.completed",
	"convergence.assessed",
	"checklist.item.checked",
	"imported",
	"import.reverted",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Generic relation kinds (grill edge kinds minus promoted-to, which is
 * md-overlay pointer metadata, not a graph edge). */
export const LINK_KINDS = [
	"supersedes",
	"refined-by",
	"depends-on",
	"produced-by",
	"cited",
	"part-of",
] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'draft',
	body TEXT NOT NULL DEFAULT '',
	path_scope TEXT,
	phase TEXT,
	parallel INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	item TEXT NOT NULL REFERENCES items(id),
	type TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	batch TEXT
);
CREATE INDEX IF NOT EXISTS events_item_idx ON events(item);
CREATE TABLE IF NOT EXISTS links (
	from_item TEXT NOT NULL REFERENCES items(id),
	to_item TEXT NOT NULL REFERENCES items(id),
	kind TEXT NOT NULL,
	PRIMARY KEY (from_item, to_item, kind)
);
CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(
	id UNINDEXED,
	title,
	body
);
CREATE TABLE IF NOT EXISTS promotions (
	item_id TEXT PRIMARY KEY REFERENCES items(id),
	path TEXT NOT NULL,
	promoted_at TEXT NOT NULL
);
`;

export function applySchema(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(DDL);
}

export function tableExists(db: DatabaseSync, name: string): boolean {
	const row = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(name) as { name: string } | undefined;
	return row !== undefined;
}

export function readSchemaVersion(db: DatabaseSync): string | undefined {
	if (!tableExists(db, "meta")) return undefined;
	const row = db
		.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
		.get() as { value: string } | undefined;
	return row?.value;
}
