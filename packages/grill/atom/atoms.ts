import { exportRelPath, removeExport, writeExport } from "./exports.js";
import {
	type AtomStore,
	type EdgeKind,
	ID_PREFIX,
	type NodeStatus,
	type NodeType,
} from "./store.js";

export interface AtomRow {
	id: string;
	type: NodeType;
	title: string;
	status: NodeStatus;
	body: string;
	scope: string | null;
	created_at: number;
	promoted_to: string | null;
	sources: string | null;
}

export interface CreateAtomInput {
	type: NodeType;
	title: string;
	body: string;
	scope?: string;
	sources?: string[];
	links?: { to: string; kind: EdgeKind }[];
}

export function nextId(store: AtomStore, type: NodeType): string {
	const prefix = ID_PREFIX[type];
	const rows = store.db
		.prepare("SELECT id FROM atoms WHERE type = ?")
		.all(type) as { id: string }[];
	let max = 0;
	for (const { id } of rows) {
		const match = /-(\d+)$/.exec(id);
		if (match) max = Math.max(max, Number.parseInt(match[1], 10));
	}
	return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

export function createAtom(store: AtomStore, input: CreateAtomInput): AtomRow {
	const id = nextId(store, input.type);

	const row: AtomRow = {
		id,
		type: input.type,
		title: input.title,
		status: "draft",
		body: input.body,
		scope: input.scope ?? null,
		created_at: Date.now(),
		promoted_to: null,
		sources: input.sources ? JSON.stringify(input.sources) : null,
	};

	store.db
		.prepare(
			`INSERT INTO atoms
			(id, type, title, status, body, scope, created_at, promoted_to, sources)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.type,
			row.title,
			row.status,
			row.body,
			row.scope,
			row.created_at,
			row.promoted_to,
			row.sources,
		);

	for (const link of input.links ?? []) {
		addEdge(store, id, link.to, link.kind);
	}

	return row;
}

function mapAtom(row: unknown): AtomRow {
	return row as AtomRow;
}

export function getAtom(store: AtomStore, id: string): AtomRow | undefined {
	const row = store.db.prepare("SELECT * FROM atoms WHERE id = ?").get(id);
	return row ? mapAtom(row) : undefined;
}

export function listAtoms(
	store: AtomStore,
	filter?: { type?: NodeType; status?: NodeStatus; scope?: string },
): AtomRow[] {
	const conditions: string[] = [];
	const params: (string | NodeType | NodeStatus)[] = [];

	if (filter?.type) {
		conditions.push("type = ?");
		params.push(filter.type);
	}
	if (filter?.status) {
		conditions.push("status = ?");
		params.push(filter.status);
	}
	if (filter?.scope !== undefined) {
		conditions.push("scope = ?");
		params.push(filter.scope);
	}

	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	const sql = `SELECT * FROM atoms ${where} ORDER BY created_at DESC, id ASC`;
	const rows = store.db.prepare(sql).all(...params) as unknown[];
	return rows.map(mapAtom);
}

export function readBody(store: AtomStore, id: string): string | null {
	const row = store.db.prepare("SELECT body FROM atoms WHERE id = ?").get(id) as
		| { body: string }
		| undefined;
	return row ? row.body : null;
}

export function setStatus(
	store: AtomStore,
	id: string,
	status: NodeStatus,
): void {
	store.db.prepare("UPDATE atoms SET status = ? WHERE id = ?").run(status, id);
}

export function promote(
	store: AtomStore,
	id: string,
	docsPath?: string,
): AtomRow {
	const atom = getAtom(store, id);
	if (!atom) throw new Error(`Atom not found: ${id}`);
	const relPath = docsPath ?? exportRelPath(store.cwd, atom.type, atom.title);
	store.db
		.prepare("UPDATE atoms SET status = ?, promoted_to = ? WHERE id = ?")
		.run("promoted", relPath, id);
	const updated = getAtom(store, id) as AtomRow;
	writeExport(store.cwd, relPath, updated);
	return updated;
}

export function addEdge(
	store: AtomStore,
	from: string,
	to: string,
	kind: EdgeKind,
): number {
	const result = store.db
		.prepare(
			"INSERT OR IGNORE INTO edges (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(from, to, kind, Date.now());
	return Number(result.changes);
}

export function supersede(
	store: AtomStore,
	oldId: string,
	newId: string,
): void {
	addEdge(store, newId, oldId, "supersedes");
	setStatus(store, oldId, "superseded");
}

export interface QueryOptions {
	type?: NodeType;
	status?: NodeStatus;
	/** negated status filter: exclude atoms in this status */
	statusNot?: NodeStatus;
	scope?: string;
	q?: string;
	/** exact id match — fetches one atom */
	id?: string;
	/** YYYY-MM-DD; only atoms created on/after this date */
	after?: string;
	/** max rows returned (applied after ordering) */
	limit?: number;
	/** "created" (recency, default) or "id" (id ASC) */
	sort?: "created" | "id";
}

export function queryAtoms(store: AtomStore, opts: QueryOptions): AtomRow[] {
	const conditions: string[] = [];
	const params: string[] = [];

	if (opts.id) {
		conditions.push("id = ?");
		params.push(opts.id);
	}
	if (opts.type) {
		conditions.push("type = ?");
		params.push(opts.type);
	}
	if (opts.status) {
		conditions.push("status = ?");
		params.push(opts.status);
	}
	if (opts.statusNot) {
		conditions.push("status != ?");
		params.push(opts.statusNot);
	}
	if (opts.scope !== undefined) {
		conditions.push("scope = ?");
		params.push(opts.scope);
	}
	if (opts.after !== undefined) {
		const epoch = Date.parse(`${opts.after}T00:00:00Z`);
		if (Number.isNaN(epoch)) {
			throw new Error(
				`invalid after= date: ${opts.after} (expected YYYY-MM-DD)`,
			);
		}
		conditions.push("created_at >= ?");
		params.push(String(epoch));
	}

	if (opts.q) {
		const ids = ftsSearch(store, opts.q);
		if (ids === null) {
			// FTS rejected the query (syntax) — LIKE substring fallback
			conditions.push("(title LIKE ? OR body LIKE ?)");
			const like = `%${opts.q}%`;
			params.push(like, like);
		} else if (ids.length === 0) {
			return [];
		} else {
			conditions.push(`id IN (${ids.map(() => "?").join(",")})`);
			params.push(...ids);
		}
	}

	// conditions are fixed fragments + '?' placeholders only; values go through params
	const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
	const orderBy =
		opts.sort === "id" ? "ORDER BY id ASC" : "ORDER BY created_at DESC, id ASC";
	const limit =
		opts.limit !== undefined
			? " LIMIT " + Math.max(0, Math.floor(opts.limit))
			: "";
	const sql = "SELECT * FROM atoms " + where + " " + orderBy + limit;
	const rows = store.db.prepare(sql).all(...params) as unknown[];
	return rows.map(mapAtom);
}

export interface DemoteResult {
	atom: AtomRow;
	/** Repo-relative export path if a file was removed. */
	removedExport?: string;
}

/** Reverse a promotion: status → accepted, promoted_to cleared, md export deleted.
 * Non-promoted atoms are returned unchanged (nothing to do). */
export function demote(store: AtomStore, id: string): DemoteResult {
	const atom = getAtom(store, id);
	if (!atom) throw new Error(`Atom not found: ${id}`);
	if (atom.status !== "promoted") return { atom };

	let removedExport: string | undefined;
	if (atom.promoted_to && !/^https?:\/\//.test(atom.promoted_to)) {
		if (removeExport(store.cwd, atom.promoted_to)) {
			removedExport = atom.promoted_to;
		}
	}
	store.db
		.prepare(
			"UPDATE atoms SET status = 'accepted', promoted_to = NULL WHERE id = ?",
		)
		.run(id);
	return { atom: getAtom(store, id) as AtomRow, removedExport };
}

export interface UpdateAtomInput {
	body?: string;
	status?: NodeStatus;
	scope?: string;
	/** Full replacement of the sources list; empty array clears provenance. */
	sources?: string[];
}

/** Update fields in place. Any change to a promoted atom regenerates its md export. */
export function updateAtom(
	store: AtomStore,
	id: string,
	input: UpdateAtomInput,
): AtomRow {
	const before = getAtom(store, id);
	if (!before) throw new Error(`Atom not found: ${id}`);

	if (input.body !== undefined) {
		store.db
			.prepare("UPDATE atoms SET body = ? WHERE id = ?")
			.run(input.body, id);
	}
	if (input.status !== undefined) {
		store.db
			.prepare("UPDATE atoms SET status = ? WHERE id = ?")
			.run(input.status, id);
	}
	if (input.scope !== undefined) {
		store.db
			.prepare("UPDATE atoms SET scope = ? WHERE id = ?")
			.run(input.scope, id);
	}
	if (input.sources !== undefined) {
		const value = input.sources.length ? JSON.stringify(input.sources) : null;
		store.db
			.prepare("UPDATE atoms SET sources = ? WHERE id = ?")
			.run(value, id);
	}

	const updated = getAtom(store, id) as AtomRow;
	const changed =
		(input.body !== undefined && input.body !== before.body) ||
		(input.status !== undefined && input.status !== before.status) ||
		(input.scope !== undefined && input.scope !== before.scope) ||
		input.sources !== undefined;
	if (changed && updated.status === "promoted" && updated.promoted_to) {
		writeExport(store.cwd, updated.promoted_to, updated);
	}
	return updated;
}

/** FTS5 MATCH over title+body; returns null when the query itself is invalid. */
function ftsSearch(store: AtomStore, q: string): string[] | null {
	try {
		const rows = store.db
			.prepare("SELECT id FROM atoms_fts WHERE atoms_fts MATCH ?")
			.all(ftsQuery(q)) as { id: string }[];
		return rows.map((r) => r.id);
	} catch {
		return null;
	}
}

/** Quote each whitespace token as a prefix phrase: `foo bar` → `"foo"* "bar"*` (implicit AND). */
function ftsQuery(q: string): string {
	return q
		.split(/\s+/)
		.filter(Boolean)
		.map((token) => `"${token.replaceAll('"', '""')}"*`)
		.join(" ");
}
