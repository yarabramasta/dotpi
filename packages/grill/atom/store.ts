import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const NODE_TYPES = [
	"decision",
	"research",
	"plan",
	"spec",
	"task",
	"session",
	"validation",
	"content",
	"release",
	"requirement",
	"concept",
	"spike",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_STATUSES = [
	"draft",
	"accepted",
	"promoted",
	"superseded",
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export const EDGE_KINDS = [
	"supersedes",
	"refined-by",
	"depends-on",
	"produced-by",
	"cited",
	"promoted-to",
	"part-of",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const ID_PREFIX: Record<NodeType, string> = {
	decision: "dec",
	research: "res",
	plan: "plan",
	spec: "spec",
	task: "task",
	session: "sess",
	validation: "val",
	content: "cont",
	release: "rel",
	requirement: "req",
	concept: "con",
	spike: "spk",
};

export const SCHEMA_VERSION = "2";

export interface AtomPaths {
	dir: string;
	dbPath: string;
	gitignorePath: string;
	gitattributesPath: string;
}

export interface AtomStore {
	db: DatabaseSync;
	paths: AtomPaths;
	cwd: string;
}

export function atomDir(cwd: string): string {
	return join(cwd, ".pi", "knowledge");
}

export function atomPaths(cwd: string): AtomPaths {
	const dir = atomDir(cwd);
	return {
		dir,
		dbPath: join(dir, "atoms.db"),
		gitignorePath: join(dir, ".gitignore"),
		gitattributesPath: join(dir, ".gitattributes"),
	};
}

export const GITIGNORE = `*
!atoms.db
atoms.db-journal
atoms.db-wal
atoms.db-shm
`;
export const GITATTRIBUTES = ".pi/knowledge/atoms.db diff=sqlite3\n";

const DDL = `
CREATE TABLE IF NOT EXISTS atoms (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	title TEXT NOT NULL,
	status TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '',
	scope TEXT,
	created_at INTEGER NOT NULL,
	promoted_to TEXT,
	sources TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS edges (
	from_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
	to_id TEXT NOT NULL REFERENCES atoms(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (from_id, to_id, kind)
) STRICT;
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS atoms_fts USING fts5(
	id UNINDEXED,
	title,
	body,
	content='atoms',
	content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS atoms_fts_insert AFTER INSERT ON atoms BEGIN
	INSERT INTO atoms_fts(rowid, id, title, body)
	SELECT rowid, new.id, new.title, new.body FROM atoms WHERE id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS atoms_fts_update AFTER UPDATE OF title, body ON atoms BEGIN
	INSERT INTO atoms_fts(atoms_fts, rowid, id, title, body)
	VALUES ('delete', old.rowid, old.id, old.title, old.body);
	INSERT INTO atoms_fts(rowid, id, title, body)
	SELECT rowid, new.id, new.title, new.body FROM atoms WHERE id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS atoms_fts_delete AFTER DELETE ON atoms BEGIN
	INSERT INTO atoms_fts(atoms_fts, rowid, id, title, body)
	VALUES ('delete', old.rowid, old.id, old.title, old.body);
END;
`;

/** Apply the v2 DDL to a raw DatabaseSync (shared with the migration converter). */
export function applySchema(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(DDL);
}

function tableExists(db: DatabaseSync, name: string): boolean {
	const row = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
		)
		.get(name);
	return row !== undefined;
}

export async function openAtomStore(cwd: string): Promise<AtomStore> {
	const sqlite = await import("node:sqlite").catch(() => undefined);
	if (!sqlite) {
		throw new Error(
			"atom store requires Node >= 22.13 (node:sqlite built-in). Current Node: " +
				process.version,
		);
	}

	const paths = atomPaths(cwd);

	// Old-format KBs are never auto-read; migration is the one-shot converter.
	if (!existsSync(paths.dbPath) && existsSync(join(paths.dir, "kb.db"))) {
		throw new Error(
			"legacy .pi/knowledge/kb.db detected (pre-v2). Run the one-shot converter: npx tsx packages/grill/atom/migrate.ts <repo>",
		);
	}

	mkdirSync(paths.dir, { recursive: true });
	try {
		writeFileSync(paths.gitignorePath, GITIGNORE, { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	try {
		writeFileSync(paths.gitattributesPath, GITATTRIBUTES, { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	const db = new sqlite.DatabaseSync(paths.dbPath);

	// Version guard BEFORE DDL: a fresh db has no tables yet; legacy/corrupt dbs
	// carry tables without a (v2) schema_version.
	const version = tableExists(db, "meta")
		? (
				db
					.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
					.get() as { value: string } | undefined
			)?.value
		: undefined;
	if (version === undefined) {
		if (tableExists(db, "nodes") || tableExists(db, "atoms")) {
			db.close();
			throw new Error(
				"atoms.db has no schema_version — legacy or corrupt store; re-run the migration converter from kb.db",
			);
		}
	} else if (version !== SCHEMA_VERSION) {
		db.close();
		throw new Error(
			`atoms.db schema_version ${version} unsupported (expected ${SCHEMA_VERSION})`,
		);
	}

	applySchema(db);
	db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(
		"schema_version",
		SCHEMA_VERSION,
	);

	return { db, paths, cwd };
}
