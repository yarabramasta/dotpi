import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EdgeKind, Kb, NodeType } from "./db.js";
import { addEdge, createNode, listNodes } from "./nodes.js";

export interface GraphImportResult {
	adrLinked: number;
	graphNodes: number;
	graphEdges: number;
}

interface GraphNode {
	id: string;
	type: string;
	label?: string;
	content?: string;
	phase?: string;
}

interface GraphEdge {
	from: string;
	to: string;
	type: string;
}

// lingua-lair graph types → kb node types (design: slice 2)
const GRAPH_TYPE_MAP: Record<string, NodeType> = {
	fr: "requirement",
	nfr: "requirement",
	"flow-stage": "concept",
	layer: "concept",
	entity: "concept",
	spike: "spike",
};

// yaml edge type → (kind, flip direction). kb supersedes runs newer→older
// (supersede() convention); refined-by/depends-on/part-of read "to relates from".
const EDGE_MAP: Record<string, { kind: EdgeKind; flip: boolean }> = {
	"superseded-by": { kind: "supersedes", flip: true },
	supersedes: { kind: "supersedes", flip: false },
	"revised-by": { kind: "refined-by", flip: false },
	"refined-by": { kind: "refined-by", flip: false },
	reworks: { kind: "refined-by", flip: true },
	"depends-on": { kind: "depends-on", flip: false },
	gates: { kind: "depends-on", flip: true },
	"flows-into": { kind: "depends-on", flip: false },
	sources: { kind: "cited", flip: false },
	"part-of": { kind: "part-of", flip: false },
	proves: { kind: "cited", flip: false },
};

function unquote(value: string): string {
	const v = value.trim();
	if (
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"))
	) {
		return v.slice(1, -1);
	}
	return v;
}

// Minimal parser for the lingua-lair knowledge-graph yaml schema (dep-free:
// installed extensions are verbatim mirrors with no node_modules). Handles
// Minimal parser for the lingua-lair knowledge-graph yaml schema (dep-free:
// installed extensions are verbatim mirrors with no node_modules). Handles
// exactly what the schema uses: top-level `nodes:`/`node_registry:`/`edges:`
// lists (indent 2 `- ` items), scalar fields at indent 4, `content: |` block
// scalars at deeper indent, full-line comments outside blocks, wrapped plain
// scalars folded onto their field. Upgrade to the `yaml` package only if a
// repo needs general yaml here.
export function parseGraphYaml(raw: string): {
	nodes: GraphNode[];
	edges: GraphEdge[];
} {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	let section: "nodes" | "edges" | null = null;
	let item: Record<string, string> | null = null;
	let lastKey: string | null = null;
	let blockKey: string | null = null;
	let blockLines: string[] | null = null;
	let blockFold = false;

	const flushItem = (): void => {
		if (!item || !section) return;
		if (section === "nodes") {
			nodes.push({
				id: unquote(item.id ?? ""),
				type: unquote(item.type ?? ""),
				label: item.label === undefined ? undefined : unquote(item.label),
				content: item.content,
				phase: item.phase === undefined ? undefined : unquote(item.phase),
			});
		} else {
			edges.push({
				from: unquote(item.from ?? ""),
				to: unquote(item.to ?? ""),
				type: unquote(item.type ?? ""),
			});
		}
		item = null;
		lastKey = null;
		blockKey = null;
		blockLines = null;
	};

	const flushBlock = (): void => {
		if (item && blockKey && blockLines) {
			item[blockKey] = blockLines.join(blockFold ? " " : "\n").trim();
			lastKey = blockKey;
		}
		blockKey = null;
		blockLines = null;
		blockFold = false;
	};

	const setField = (key: string, value: string): void => {
		if (/^[|>][+-]?$/.test(value)) {
			flushBlock();
			blockKey = key;
			blockLines = [];
			blockFold = value.startsWith(">");
			return;
		}
		if (item) {
			item[key] = value;
			lastKey = key;
		}
	};

	for (const rawLine of raw.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (blockLines) {
			if (line.trim() === "") {
				blockLines.push("");
				continue;
			}
			if (line.length - line.trimStart().length > 4) {
				blockLines.push(line.slice(6).replace(/\t/g, "  "));
				continue;
			}
			flushBlock();
		} else if (line.trimStart().startsWith("#")) {
			continue;
		}

		const indent = line.length - line.trimStart().length;
		if (indent === 0 && line.trim() === "") continue;
		if (indent === 0) {
			flushItem();
			const key = line.trim();
			if (/^(nodes|node_registry):\s*$/.test(key)) section = "nodes";
			else if (/^edges:\s*$/.test(key)) section = "edges";
			else section = null;
			continue;
		}
		if (!section) continue;

		if (indent <= 2 && line.trimStart().startsWith("- ")) {
			flushItem();
			item = {};
			lastKey = null;
			const rest = line.trimStart().slice(2);
			const inline = /^(\w+):\s*(.*)$/.exec(rest);
			if (inline) setField(inline[1], inline[2]);
			continue;
		}

		if (indent > 4) {
			// wrapped plain-scalar continuation — fold onto the previous field
			if (item && lastKey) item[lastKey] += ` ${line.trim()}`;
			continue;
		}
		if (indent < 4 || !item) continue;

		const field = /^(\w+):\s*(.*)$/.exec(line.trim());
		if (!field) continue;
		setField(field[1], field[2]);
	}
	flushBlock();
	flushItem();
	return { nodes, edges };
}

function loadGraph(kb: Kb): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const dir = join(kb.cwd, "docs/reference/graph");
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
	} catch {
		return { nodes: [], edges: [] };
	}
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	for (const file of files) {
		try {
			const parsed = parseGraphYaml(readFileSync(join(dir, file), "utf8"));
			nodes.push(...parsed.nodes);
			edges.push(...parsed.edges);
		} catch {
			// unparseable shard — skip, doctor surfaces broken canon elsewhere
		}
	}
	return { nodes, edges };
}

function adrIdFromPath(promotedTo: string): string | undefined {
	const match = /(ADR-\d+)\.md$/.exec(promotedTo);
	return match?.[1];
}

export function absorbGraph(kb: Kb): GraphImportResult {
	const { nodes: graphNodes, edges: graphEdges } = loadGraph(kb);
	if (!graphNodes.length) {
		return { adrLinked: 0, graphNodes: 0, graphEdges: 0 };
	}

	// yaml ADR ids ↔ existing canon decision nodes (promoted_to docs/adr/ADR-NNN.md)
	const idToAtom = new Map<string, string>();
	for (const node of listNodes(kb)) {
		const adrId = node.promoted_to ? adrIdFromPath(node.promoted_to) : undefined;
		if (adrId) idToAtom.set(adrId, node.id);
	}

	// existing atoms by type+title for idempotent creation
	const existing = new Set(listNodes(kb).map((n) => `${n.type}::${n.title}`));

	let adrLinked = 0;
	let created = 0;
	for (const g of graphNodes) {
		if (!g.id || !g.type) continue;
		const kbType = GRAPH_TYPE_MAP[g.type];
		if (!kbType) continue; // adr handled via promoted_to match below
		const title = g.label ?? g.id;
		let atomId = idToAtom.get(g.id);
		if (!atomId) {
			const found = listNodes(kb, { type: kbType }).find((n) => n.title === title);
			atomId = found?.id;
		}
		if (atomId) {
			idToAtom.set(g.id, atomId);
			continue;
		}
		if (existing.has(`${kbType}::${title}`)) {
			continue;
		}
		const origin = `docs/reference/graph/*.yaml as ${g.id}`;
		const body = g.content
			? `# ${title}\n\n${g.content}\n\n(imported from ${origin})`
			: `${title}\n\n(imported from ${origin})`;
		const node = createNode(kb, {
			type: kbType,
			title,
			body,
			scope: g.phase,
		});
		idToAtom.set(g.id, node.id);
		existing.add(`${kbType}::${title}`);
		created++;
	}

	// link yaml ADR nodes that map onto existing canon decisions
	for (const g of graphNodes) {
		if (g.type !== "adr" || !g.id) continue;
		if (idToAtom.get(g.id)) {
			adrLinked++;
		}
	}

	let edgeCount = 0;
	for (const e of graphEdges) {
		const map = EDGE_MAP[e.type];
		if (!map) continue;
		const fromId = idToAtom.get(e.from);
		const toId = idToAtom.get(e.to);
		if (!fromId || !toId) continue;
		const inserted = addEdge(
			kb,
			map.flip ? toId : fromId,
			map.flip ? fromId : toId,
			map.kind,
		);
		if (inserted) edgeCount++;
	}

	return { adrLinked, graphNodes: created, graphEdges: edgeCount };
}
