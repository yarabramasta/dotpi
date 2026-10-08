import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Kb } from "./db.js";
import { absorbGraph } from "./graph.js";
import { createNode, listNodes, promote } from "./nodes.js";
import { detectWorkspace, type WorkspaceKind } from "./workspace.js";

export interface InitResult {
	scannedAdrs: number;
	workspacePkgs: number;
	created: string[];
	isMonorepo: boolean;
	workspaceKind: WorkspaceKind;
	adrLinked: number;
	graphNodes: number;
	graphEdges: number;
}

function scanAdrs(kb: Kb): string[] {
	const adrDir = join(kb.cwd, "docs/adr");
	let entries: string[];
	try {
		entries = readdirSync(adrDir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith(".md"))
			.map((e) => `docs/adr/${e.name}`)
			.sort();
	} catch {
		return [];
	}
	return entries.slice(0, 50);
}

function readHeading(filePath: string): string | undefined {
	try {
		const raw = readFileSync(filePath, "utf8");
		const match = /^#\s+(.+)$/m.exec(raw);
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

export function initKb(kb: Kb): InitResult {
	const {
		isMonorepo,
		workspacePkgs,
		kind: workspaceKind,
	} = detectWorkspace(kb.cwd);

	const adrs = scanAdrs(kb);
	const scannedAdrs = adrs.length;

	const existingPaths = new Set(
		listNodes(kb)
			.map((n) => n.promoted_to)
			.filter((p): p is string => p !== null),
	);
	const created: string[] = [];

	for (const relPath of adrs) {
		if (existingPaths.has(relPath)) {
			continue;
		}
		const filePath = join(kb.cwd, relPath);
		const heading = readHeading(filePath);
		const name = basename(relPath, ".md");
		const title = heading ?? name;
		const body = `${heading ?? `# ${name}`}\n\n(canon ref — full record lives at the path above)`;

		const node = createNode(kb, { type: "decision", title, body });
		promote(kb, node.id, relPath);
		created.push(node.id);
	}

	try {
		const stmt = kb.db.prepare(
			"INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
		);
		stmt.run("init", new Date().toISOString());
	} catch {
		// ignore meta write failures
	}

	const graph = absorbGraph(kb);

	return {
		scannedAdrs,
		workspacePkgs,
		created,
		isMonorepo,
		workspaceKind,
		adrLinked: graph.adrLinked,
		graphNodes: graph.graphNodes,
		graphEdges: graph.graphEdges,
	};
}
