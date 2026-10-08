import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EdgeKind,
	ID_PREFIX,
	type Kb,
	type NodeStatus,
	type NodeType,
} from "./db.js";

export interface NodeRow {
	id: string;
	type: NodeType;
	title: string;
	status: NodeStatus;
	scope: string | null;
	created_at: number;
	promoted_to: string | null;
	github_issue: string | null;
	github_project: string | null;
	sources: string | null;
}

export interface CreateNodeInput {
	type: NodeType;
	title: string;
	body: string;
	scope?: string;
	sources?: string[];
	links?: { to: string; kind: EdgeKind }[];
}

export function nextId(kb: Kb, type: NodeType): string {
	const prefix = ID_PREFIX[type];
	const rows = kb.db
		.prepare("SELECT id FROM nodes WHERE type = ?")
		.all(type) as { id: string }[];
	let max = 0;
	for (const { id } of rows) {
		const match = /-(\d+)$/.exec(id);
		if (match) max = Math.max(max, Number.parseInt(match[1], 10));
	}
	return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

export function createNode(kb: Kb, input: CreateNodeInput): NodeRow {
	const id = nextId(kb, input.type);
	const bodyPath = join(kb.paths.nodesDir, `${id}.md`);
	writeFileSync(bodyPath, input.body, "utf8");

	const row: NodeRow = {
		id,
		type: input.type,
		title: input.title,
		status: "draft",
		scope: input.scope ?? null,
		created_at: Date.now(),
		promoted_to: null,
		github_issue: null,
		github_project: null,
		sources: input.sources ? JSON.stringify(input.sources) : null,
	};

	kb.db
		.prepare(
			`INSERT INTO nodes
			(id, type, title, status, scope, created_at, promoted_to, github_issue, github_project, sources)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.type,
			row.title,
			row.status,
			row.scope,
			row.created_at,
			row.promoted_to,
			row.github_issue,
			row.github_project,
			row.sources,
		);

	for (const link of input.links ?? []) {
		addEdge(kb, id, link.to, link.kind);
	}

	return row;
}

function mapNode(row: unknown): NodeRow {
	return row as NodeRow;
}

export function getNode(kb: Kb, id: string): NodeRow | undefined {
	const row = kb.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
	return row ? mapNode(row) : undefined;
}

export function listNodes(
	kb: Kb,
	filter?: { type?: NodeType; status?: NodeStatus; scope?: string },
): NodeRow[] {
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
	const sql = `SELECT * FROM nodes ${where} ORDER BY created_at DESC, id ASC`;
	const rows = kb.db.prepare(sql).all(...params) as unknown[];
	return rows.map(mapNode);
}

export function readBody(kb: Kb, id: string): string | null {
	try {
		return readFileSync(join(kb.paths.nodesDir, `${id}.md`), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export function setStatus(kb: Kb, id: string, status: NodeStatus): void {
	kb.db.prepare("UPDATE nodes SET status = ? WHERE id = ?").run(status, id);
}

export function promote(kb: Kb, id: string, promotedTo: string): void {
	kb.db
		.prepare("UPDATE nodes SET status = ?, promoted_to = ? WHERE id = ?")
		.run("promoted", promotedTo, id);
}

export function linkGithub(
	kb: Kb,
	id: string,
	refs: { issue?: string; project?: string },
): void {
	const { issue, project } = refs;
	if (issue !== undefined && project !== undefined) {
		kb.db
			.prepare(
				"UPDATE nodes SET github_issue = ?, github_project = ? WHERE id = ?",
			)
			.run(issue, project, id);
	} else if (issue !== undefined) {
		kb.db
			.prepare("UPDATE nodes SET github_issue = ? WHERE id = ?")
			.run(issue, id);
	} else if (project !== undefined) {
		kb.db
			.prepare("UPDATE nodes SET github_project = ? WHERE id = ?")
			.run(project, id);
	}
}

export function addEdge(
	kb: Kb,
	from: string,
	to: string,
	kind: EdgeKind,
): void {
	kb.db
		.prepare(
			"INSERT INTO edges (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(from, to, kind, Date.now());
}

export function supersede(kb: Kb, oldId: string, newId: string): void {
	addEdge(kb, newId, oldId, "supersedes");
	setStatus(kb, oldId, "superseded");
}

export interface QueryOptions {
	type?: NodeType;
	status?: NodeStatus;
	scope?: string;
	q?: string;
}

export function queryNodes(
	kb: Kb,
	opts: QueryOptions,
): Array<NodeRow & { body: string | null }> {
	const nodes = listNodes(kb, opts);
	const q = opts.q?.toLowerCase();
	return nodes
		.map((node) => ({ ...node, body: readBody(kb, node.id) }))
		.filter((node) => {
			if (!q) return true;
			return (
				node.title.toLowerCase().includes(q) ||
				(node.body?.toLowerCase().includes(q) ?? false)
			);
		});
}
