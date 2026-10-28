/** Read-only access to a grill atoms.db SQLite store. The schema is
 * STRICT (no column flexibility), so this file enumerates columns
 * rather than reading dynamic SQL. Everything the importer needs comes
 * through these typed helpers. */

import { DatabaseSync } from "node:sqlite";
import { atomPaths } from "../../../grill/src/atom/store.js";

/** grill atom row, lifted from packages/grill/atom/store.ts and trimmed
 * to the columns the importer actually reads. */
export interface GrillAtom {
	id: string;
	type: string;
	title: string;
	status: string;
	body: string;
	scope: string | null;
	created_at: number;
	promoted_to: string | null;
	sources: string | null;
}

export interface GrillEdge {
	from_id: string;
	to_id: string;
	kind: string;
	created_at: number;
}

export interface GrillSnapshot {
	atoms: ReadonlyArray<GrillAtom>;
	edges: ReadonlyArray<GrillEdge>;
	source: { cwd: string; dbPath: string };
}

function rowToAtom(row: Record<string, unknown>): GrillAtom {
	return {
		id: String(row.id),
		type: String(row.type),
		title: String(row.title),
		status: String(row.status),
		body: String(row.body ?? ""),
		scope:
			row.scope === null || row.scope === undefined ? null : String(row.scope),
		created_at: Number(row.created_at),
		promoted_to:
			row.promoted_to === null || row.promoted_to === undefined
				? null
				: String(row.promoted_to),
		sources:
			row.sources === null || row.sources === undefined
				? null
				: String(row.sources),
	};
}

function rowToEdge(row: Record<string, unknown>): GrillEdge {
	return {
		from_id: String(row.from_id),
		to_id: String(row.to_id),
		kind: String(row.kind),
		created_at: Number(row.created_at),
	};
}

/** Open the grill store at `cwd` (read-only) and snapshot every atom +
 * edge. The importer never mutates the source — this file is read-only
 * by design. */
export function snapshotGrill(cwd: string): GrillSnapshot {
	const paths = atomPaths(cwd);
	const db = new DatabaseSync(paths.dbPath, { readOnly: true });
	try {
		const atomRows = db
			.prepare(
				"SELECT id, type, title, status, body, scope, created_at, promoted_to, sources FROM atoms ORDER BY created_at ASC",
			)
			.all();
		const edgeRows = db
			.prepare(
				"SELECT from_id, to_id, kind, created_at FROM edges ORDER BY created_at ASC",
			)
			.all();
		return {
			atoms: atomRows.map((r) => rowToAtom(r as Record<string, unknown>)),
			edges: edgeRows.map((r) => rowToEdge(r as Record<string, unknown>)),
			source: { cwd, dbPath: paths.dbPath },
		};
	} finally {
		db.close();
	}
}
