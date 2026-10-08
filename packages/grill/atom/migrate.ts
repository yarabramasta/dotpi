/**
 * One-shot legacy store (pre-v2) → atom store v2 converter.
 *
 * Reads `.pi/knowledge/kb.db` (nodes table, no bodies) + `nodes/*.md` bodies,
 * builds `atoms.db` v2 (bodies in-db, FTS5), repoints promoted atoms to fresh
 * export paths, writes the md exports, then deletes `nodes/` + `kb.db`.
 *
 * Run from the dotpi checkout against the target repo:
 *   npx tsx packages/grill/atom/migrate.ts <repo-cwd>
 * (tsx or bun resolve the repo's .js-suffixed imports; plain node does not.)
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AtomRow } from "./atoms.js";
import { exportRelPath, writeExport } from "./exports.js";
import {
	applySchema,
	atomPaths,
	GITATTRIBUTES,
	GITIGNORE,
	type NodeType,
	SCHEMA_VERSION,
} from "./store.js";

export interface MigrationResult {
	atoms: number;
	edges: number;
	exports: number;
}

interface LegacyRow {
	id: string;
	type: NodeType;
	title: string;
	status: string;
	body: string;
	scope: string | null;
	created_at: number;
	promoted_to: string | null;
	sources: string | null;
}

export function migrateLegacyStore(cwd: string): MigrationResult {
	const knowledge = join(cwd, ".pi", "knowledge");
	const oldDbPath = join(knowledge, "kb.db");
	const nodesDir = join(knowledge, "nodes");
	const paths = atomPaths(cwd);

	if (!existsSync(oldDbPath) || !existsSync(nodesDir)) {
		throw new Error(
			`legacy kb.db + nodes/ not found under ${knowledge} — nothing to migrate`,
		);
	}
	if (existsSync(paths.dbPath)) {
		throw new Error(`${paths.dbPath} already exists — refusing to overwrite`);
	}

	const oldDb = new DatabaseSync(oldDbPath);
	const legacyRows = oldDb
		.prepare(
			`SELECT id, type, title, status, scope, created_at, promoted_to,
			sources FROM nodes`,
		)
		.all() as Array<Omit<LegacyRow, "body">>;

	const rows: LegacyRow[] = legacyRows.map((row) => {
		let body = "";
		try {
			body = readFileSync(join(nodesDir, `${row.id}.md`), "utf8");
		} catch {
			// missing body file → empty body (doctor flags it)
		}
		return { ...row, body };
	});
	const edges = oldDb
		.prepare("SELECT from_id, to_id, kind, created_at FROM edges")
		.all() as Array<{
		from_id: string;
		to_id: string;
		kind: string;
		created_at: number;
	}>;
	const meta = oldDb.prepare("SELECT key, value FROM meta").all() as Array<{
		key: string;
		value: string;
	}>;
	oldDb.close();

	// New store: same ids, bodies in-db, promoted atoms repointed to export paths.
	const db = new DatabaseSync(paths.dbPath);
	applySchema(db);
	const insertAtom = db.prepare(
		`INSERT INTO atoms
		(id, type, title, status, body, scope, created_at, promoted_to, sources)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const exports: Array<{ relPath: string; atom: LegacyRow }> = [];
	for (const row of rows) {
		let promotedTo = row.promoted_to;
		if (row.status === "promoted" && promotedTo !== null) {
			// stale legacy targets (docs/adr/*, nodes/*.md) → fresh export layout
			const isLegacyTarget =
				promotedTo.startsWith("docs/adr/") ||
				promotedTo.includes(".pi/knowledge/nodes/");
			if (isLegacyTarget) {
				promotedTo = exportRelPath(cwd, row.type, row.title);
				exports.push({ relPath: promotedTo, atom: row });
			}
		}
		insertAtom.run(
			row.id,
			row.type,
			row.title,
			row.status,
			row.body,
			row.scope,
			row.created_at,
			promotedTo,
			row.sources,
		);
	}
	const insertEdge = db.prepare(
		"INSERT OR IGNORE INTO edges (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)",
	);
	for (const edge of edges) {
		insertEdge.run(edge.from_id, edge.to_id, edge.kind, edge.created_at);
	}
	const insertMeta = db.prepare(
		"INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
	);
	for (const { key, value } of meta) {
		insertMeta.run(key, value);
	}
	insertMeta.run("schema_version", SCHEMA_VERSION);
	db.close();

	// Exports for repointed atoms, then drop the legacy store.
	for (const { relPath, atom } of exports) {
		writeExport(cwd, relPath, {
			...atom,
			status: "promoted",
			promoted_to: relPath,
		} as AtomRow);
	}
	rmSync(nodesDir, { recursive: true, force: true });
	rmSync(oldDbPath, { force: true });

	// Upgrade scaffold files written by the pre-v2 open (`*` only) to v2.
	writeFileSync(join(knowledge, ".gitignore"), GITIGNORE, "utf8");
	writeFileSync(join(knowledge, ".gitattributes"), GITATTRIBUTES, "utf8");

	return {
		atoms: rows.length,
		edges: edges.length,
		exports: exports.length,
	};
}

const invokedDirectly = process.argv[1]?.endsWith("atom/migrate.ts");
if (invokedDirectly) {
	const cwd = process.argv[2] ?? process.cwd();
	const result = migrateLegacyStore(cwd);
	console.log(
		`migrated: ${result.atoms} atoms, ${result.edges} edges, ${result.exports} exports written; kb.db + nodes/ removed`,
	);
}
