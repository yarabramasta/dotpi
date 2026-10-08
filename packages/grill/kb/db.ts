import { mkdirSync, writeFileSync } from "node:fs";
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

export interface KbPaths {
	dir: string;
	dbPath: string;
	nodesDir: string;
	gitignorePath: string;
}

export interface Kb {
	db: DatabaseSync;
	paths: KbPaths;
	cwd: string;
}

export function kbDir(cwd: string): string {
	return join(cwd, ".pi", "knowledge");
}

export function kbPaths(cwd: string): KbPaths {
	const dir = kbDir(cwd);
	return {
		dir,
		dbPath: join(dir, "kb.db"),
		nodesDir: join(dir, "nodes"),
		gitignorePath: join(dir, ".gitignore"),
	};
}

const DDL = `
CREATE TABLE IF NOT EXISTS nodes (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	title TEXT NOT NULL,
	status TEXT NOT NULL,
	scope TEXT,
	created_at INTEGER NOT NULL,
	promoted_to TEXT,
	github_issue TEXT,
	github_project TEXT,
	sources TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS edges (
	from_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
	to_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (from_id, to_id, kind)
) STRICT;
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
`;

export async function openKb(cwd: string): Promise<Kb> {
	const sqlite = await import("node:sqlite").catch(() => undefined);
	if (!sqlite) {
		throw new Error(
			"kb requires Node >= 22.13 (node:sqlite built-in). Current Node: " +
				process.version,
		);
	}

	const paths = kbPaths(cwd);
	mkdirSync(paths.dir, { recursive: true });
	mkdirSync(paths.nodesDir, { recursive: true });

	try {
		writeFileSync(paths.gitignorePath, "*\n", { flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	const db = new sqlite.DatabaseSync(paths.dbPath);
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(DDL);

	return { db, paths, cwd };
}
