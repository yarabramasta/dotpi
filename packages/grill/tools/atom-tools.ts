import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	EDGE_KINDS,
	type EdgeKind,
	type Kb,
	NODE_STATUSES,
	NODE_TYPES,
	type NodeStatus,
	type NodeType,
	openKb,
} from "../kb/db.js";
import { renderDigest } from "../kb/digest.js";
import { addEdge, getNode, linkGithub, queryNodes } from "../kb/nodes.js";
import { readAtomDefault } from "../settings.js";
import { runtime } from "../state.js";

const QUERY_LIMIT = 50;

function renderRows(
	rows: Array<{
		id: string;
		type: string;
		status: string;
		title: string;
		promoted_to: string | null;
	}>,
): string {
	return rows
		.map(
			(r) =>
				`- **${r.id}** (${r.type}, ${r.status}) ${r.title} — nodes/${r.id}.md${r.promoted_to ? ` → ${r.promoted_to}` : ""}`,
		)
		.join("\n");
}

function text(content: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: content }],
		details,
	};
}

async function openAtom(ctx: ExtensionContext): Promise<Kb | undefined> {
	const enabled =
		typeof runtime.state.atomOverride === "boolean"
			? runtime.state.atomOverride
			: readAtomDefault(ctx);
	if (!enabled) return undefined;
	return await openKb(ctx.cwd);
}

function kbDisabled() {
	return text(
		'atom is disabled ({ "atom": false } in grill.json or /grill atom off). Enable it to query the knowledge base.',
	);
}

export function registerAtomTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "atom_query",
		label: "Query Grill Atom",
		description:
			"Query the repo-scoped grill atom knowledge base (nodes with type/status/keyword filters). Read-only. Use to find decisions, specs, research, tasks and their canon paths.",
		promptSnippet: "Query the grill atom knowledge base",
		promptGuidelines: [
			"Use atom_query instead of scanning docs/ manually when looking for decisions, specs, research or tasks.",
		],
		parameters: Type.Object({
			type: Type.Optional(
				Type.String({
					description: `Filter by node type (${NODE_TYPES.join("|")}).`,
				}),
			),
			status: Type.Optional(
				Type.String({
					description: `Filter by status (${NODE_STATUSES.join("|")}).`,
				}),
			),
			q: Type.Optional(
				Type.String({ description: "Keyword filter over title + body." }),
			),
			scope: Type.Optional(
				Type.String({ description: "Filter by scope value." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return kbDisabled();
			const kb = await openAtom(ctx);
			if (!kb) return kbDisabled();
			const opts: Parameters<typeof queryNodes>[1] = {};
			if (
				params.type &&
				(NODE_TYPES as readonly string[]).includes(params.type)
			) {
				opts.type = params.type as NodeType;
			}
			if (
				params.status &&
				(NODE_STATUSES as readonly string[]).includes(params.status)
			) {
				opts.status = params.status as NodeStatus;
			}
			if (params.q) opts.q = params.q;
			if (params.scope) opts.scope = params.scope;
			const rows = queryNodes(kb, opts).slice(0, QUERY_LIMIT);
			const body = rows.length ? renderRows(rows) : "no matching atoms";
			return text(`# atom query\n\n${body}`, { rows: rows.length });
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("atom_query ")) +
					theme.fg("muted", args.q ?? args.type ?? ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const count = (result.details as { rows?: number } | undefined)?.rows;
			return new Text(
				theme.fg(
					"success",
					`✓ atom query${count === undefined ? "" : ` (${count} atoms)`}`,
				),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "atom_digest",
		label: "Grill Atom Digest",
		description:
			"Print the compact digest of the repo-scoped grill atom knowledge base (node counts by type/status, recent sessions, active decisions). Optional task lens restricts the digest to atoms relevant to a task description. Read-only.",
		promptSnippet: "Print the grill atom digest",
		promptGuidelines: [
			"Use atom_digest for a quick orientation of what knowledge exists before planning work.",
			"Use the task param to get a task-lensed digest (matching atoms + their edges) instead of the full digest.",
		],
		parameters: Type.Object({
			task: Type.Optional(
				Type.String({
					description:
						"Task description for the lens, e.g. 'auth token refresh'. Matches atoms by keyword.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return kbDisabled();
			const kb = await openAtom(ctx);
			if (!kb) return kbDisabled();
			return text(
				renderDigest(kb, params.task ? { task: params.task } : undefined),
			);
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("atom_digest")), 0, 0);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "✓ atom digest"), 0, 0);
		},
	});

	pi.registerTool({
		name: "atom_link",
		label: "Link Grill Atoms",
		description:
			"Create a typed edge between two atoms in the grill atom knowledge base (e.g. supersedes, depends-on). Mutates .pi/knowledge/kb.db.",
		promptSnippet: "Create a typed edge between two atoms",
		promptGuidelines: [
			"Use atom_link to record supersedes/depends-on/refined-by relations between atoms.",
		],
		parameters: Type.Object({
			from: Type.String({ description: "Source atom id, e.g. dec-0002." }),
			to: Type.String({ description: "Target atom id, e.g. dec-0018." }),
			kind: Type.String({
				description: `Edge kind (${EDGE_KINDS.join("|")}).`,
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return kbDisabled();
			const kb = await openAtom(ctx);
			if (!kb) return kbDisabled();
			if (!(EDGE_KINDS as readonly string[]).includes(params.kind)) {
				return text(
					`Unknown edge kind: ${params.kind}. Valid kinds: ${EDGE_KINDS.join(", ")}.`,
				);
			}
			const from = getNode(kb, params.from);
			const to = getNode(kb, params.to);
			if (!from || !to) {
				return text(`Atom not found: ${!from ? params.from : params.to}.`);
			}
			addEdge(kb, params.from, params.to, params.kind as EdgeKind);
			return text(`Linked ${params.from} -[${params.kind}]-> ${params.to}.`, {
				from: params.from,
				to: params.to,
				kind: params.kind,
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("atom_link ")) +
					theme.fg(
						"muted",
						`${args.from ?? "?"} -[${args.kind ?? "?"}]-> ${args.to ?? "?"}`,
					),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const first =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("success", `✓ ${first.split("\n")[0]}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "atom_backfill",
		label: "Backfill Grill Atom Provenance",
		description:
			"Attach provenance to an atom: GitHub issue/project refs (and optionally a scope). Mutates .pi/knowledge/kb.db metadata columns.",
		promptSnippet: "Attach GitHub issue/project provenance to an atom",
		promptGuidelines: [
			"Use atom_backfill to fill github_issue/github_project/scope on atoms instead of leaving NULL provenance.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Atom id, e.g. dec-0004." }),
			issue: Type.Optional(
				Type.String({
					description: "GitHub issue ref, e.g. 'lingua-lair#123'.",
				}),
			),
			project: Type.Optional(
				Type.String({ description: "GitHub project ref." }),
			),
			scope: Type.Optional(
				Type.String({ description: "Scope label, e.g. 'auth' or 'ota'." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return kbDisabled();
			const kb = await openAtom(ctx);
			if (!kb) return kbDisabled();
			const node = getNode(kb, params.id);
			if (!node) return text(`Atom not found: ${params.id}.`);
			const touched: string[] = [];
			if (params.issue || params.project) {
				linkGithub(kb, params.id, {
					issue: params.issue,
					project: params.project,
				});
				touched.push(
					params.issue ? "github_issue" : "",
					params.project ? "github_project" : "",
				);
			}
			if (params.scope) {
				kb.db
					.prepare("UPDATE nodes SET scope = ? WHERE id = ?")
					.run(params.scope, params.id);
				touched.push("scope");
			}
			if (!touched.length) {
				return text("Nothing to backfill: pass issue, project or scope.");
			}
			return text(
				`Backfilled ${params.id}: ${touched.filter(Boolean).join(", ")}.`,
				{ id: params.id, touched: touched.filter(Boolean) },
			);
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("atom_backfill ")) +
					theme.fg("muted", args.id ?? ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const first =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(theme.fg("success", `✓ ${first.split("\n")[0]}`), 0, 0);
		},
	});
}
