/** Pure mapping from grill atoms/edges to specd items/links.
 *
 * Identity stable: same input → same output. No I/O. The runner writes
 * whatever this module returns. The mapping is conservative on purpose —
 * any grill type that lacks a direct specd equivalent becomes `knowledge`
 * with a `type=<original>` marker in the body so the original taxonomy
 * survives the migration. Promoted-to pointers become provenance events,
 * not edges (acceptance criterion #9). */

import type { GrillAtom, GrillEdge, GrillSnapshot } from "./grill-source.js";

export type MappedItemKind =
	| "spec"
	| "plan"
	| "task"
	| "cycle"
	| "epic"
	| "roadmap"
	| "constitution"
	| "checklist"
	| "knowledge";

export type MappedItemStatus =
	| "draft"
	| "approved"
	| "exported"
	| "in-progress"
	| "done"
	| "stopped";

export interface MappedItem {
	originId: string;
	kind: MappedItemKind;
	title: string;
	body: string;
	status: MappedItemStatus;
	scope: string | null;
	originalStatus: string;
	originalType: string;
	promotedTo: string | null;
	sources: string | null;
	createdAt: number;
}

export interface MappedLink {
	fromOriginId: string;
	toOriginId: string;
	kind:
		| "supersedes"
		| "refined-by"
		| "depends-on"
		| "produced-by"
		| "cited"
		| "part-of";
}

/** grill type → specd kind. Anything not in this map becomes knowledge
 * with a `type=<original>` body marker. Update this map deliberately —
 * adding a new direct mapping is a contract change. */
const TYPE_TO_KIND: Readonly<Record<string, MappedItemKind>> = {
	plan: "plan",
};

/** grill status → specd status. Superseded → stopped is the closest
 * specd vocabulary match; the original grill status is preserved in
 * `originalStatus` for provenance. */
const STATUS_TO_SPEC: Readonly<Record<string, MappedItemStatus>> = {
	draft: "draft",
	accepted: "approved",
	promoted: "approved",
	superseded: "stopped",
};

/** grill edge kinds minus `promoted-to` (which is md-overlay metadata,
 * not a graph edge — acceptance criterion #9). All six remaining kinds
 * exist in specd already. */
const VALID_EDGE_KINDS = new Set([
	"supersedes",
	"refined-by",
	"depends-on",
	"produced-by",
	"cited",
	"part-of",
]);

function escapeYaml(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim();
}

function bodyWithMarker(atom: GrillAtom, body: string): string {
	const frontmatter = [
		`type=${atom.type}`,
		`original_id=${atom.id}`,
		`original_status=${atom.status}`,
	];
	if (atom.scope) frontmatter.push(`scope=${atom.scope}`);
	if (atom.promoted_to) frontmatter.push(`promoted_to=${atom.promoted_to}`);
	const header = `---\n${frontmatter.join("\n")}\n---\n`;
	return `${header}\n${body}`;
}

export function mapAtom(atom: GrillAtom): MappedItem {
	const kind: MappedItemKind = TYPE_TO_KIND[atom.type] ?? "knowledge";
	const status: MappedItemStatus = STATUS_TO_SPEC[atom.status] ?? "draft";
	return {
		originId: atom.id,
		kind,
		title: escapeYaml(atom.title),
		body: bodyWithMarker(atom, atom.body),
		status,
		scope: atom.scope,
		originalStatus: atom.status,
		originalType: atom.type,
		promotedTo: atom.promoted_to,
		sources: atom.sources,
		createdAt: atom.created_at,
	};
}

export function mapEdge(edge: GrillEdge): MappedLink | undefined {
	if (!VALID_EDGE_KINDS.has(edge.kind)) return undefined;
	return {
		fromOriginId: edge.from_id,
		toOriginId: edge.to_id,
		kind: edge.kind as MappedLink["kind"],
	};
}

export interface MappedSnapshot {
	items: ReadonlyArray<MappedItem>;
	links: ReadonlyArray<MappedLink>;
	skippedEdges: ReadonlyArray<GrillEdge>;
}

export function mapSnapshot(snap: GrillSnapshot): MappedSnapshot {
	const items = snap.atoms.map(mapAtom);
	const links: MappedLink[] = [];
	const skipped: GrillEdge[] = [];
	for (const edge of snap.edges) {
		const mapped = mapEdge(edge);
		if (mapped) links.push(mapped);
		else skipped.push(edge);
	}
	return { items, links, skippedEdges: skipped };
}
