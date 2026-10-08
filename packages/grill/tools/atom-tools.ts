import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AtomRow,
	addEdge,
	createAtom,
	demote,
	getAtom,
	promote,
	queryAtoms,
	updateAtom,
} from "../atom/atoms.js";
import { renderDigest } from "../atom/digest.js";
import {
	type AtomStore,
	EDGE_KINDS,
	type EdgeKind,
	NODE_STATUSES,
	NODE_TYPES,
	type NodeStatus,
	type NodeType,
	openAtomStore,
} from "../atom/store.js";
import { readAtomDefault } from "../settings.js";
import { runtime } from "../state.js";

const QUERY_LIMIT = 50;

function renderRows(
	rows: Array<
		Pick<AtomRow, "id" | "type" | "status" | "title" | "promoted_to" | "body">
	>,
): string {
	return rows
		.map((r) => {
			const firstLine = r.body.split("\n")[0].trim().slice(0, 80);
			let snippet = "";
			if (firstLine) {
				const ellipsis = r.body.length > firstLine.length ? "…" : "";
				snippet = `\n  ${firstLine}${ellipsis}`;
			}
			return `- **${r.id}** (${r.type}, ${r.status}) ${r.title}${r.promoted_to ? ` → ${r.promoted_to}` : ""}${snippet}`;
		})
		.join("\n");
}

function renderAtomFull(atom: AtomRow): string {
	const lines = [
		`# ${atom.id}`,
		"",
		`- type: ${atom.type}`,
		`- status: ${atom.status}`,
		`- scope: ${atom.scope ?? "—"}`,
		`- promoted_to: ${atom.promoted_to ?? "—"}`,
		`- sources: ${atom.sources ?? "—"}`,
		`- created: ${new Date(atom.created_at).toISOString()}`,
		"",
		atom.body,
	];
	return lines.join("\n");
}

function queryOptsFromParams(params: {
	id?: string;
	type?: string;
	status?: string;
	status_not?: string;
	q?: string;
	scope?: string;
	after?: string;
	limit?: number;
	sort?: string;
}): Parameters<typeof queryAtoms>[1] {
	const opts: Parameters<typeof queryAtoms>[1] = {};
	if (params.id) opts.id = params.id;
	if (params.type && (NODE_TYPES as readonly string[]).includes(params.type)) {
		opts.type = params.type as NodeType;
	}
	if (
		params.status &&
		(NODE_STATUSES as readonly string[]).includes(params.status)
	) {
		opts.status = params.status as NodeStatus;
	}
	if (
		params.status_not &&
		(NODE_STATUSES as readonly string[]).includes(params.status_not)
	) {
		opts.statusNot = params.status_not as NodeStatus;
	}
	if (params.q) opts.q = params.q;
	if (params.scope) opts.scope = params.scope;
	if (params.after) opts.after = params.after;
	if (typeof params.limit === "number") opts.limit = params.limit;
	if (params.sort === "created" || params.sort === "id") {
		opts.sort = params.sort;
	}
	return opts;
}

function text(content: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: content }],
		details,
	};
}

async function openAtom(ctx: ExtensionContext): Promise<AtomStore | undefined> {
	const enabled =
		typeof runtime.state.atomOverride === "boolean"
			? runtime.state.atomOverride
			: readAtomDefault(ctx);
	if (!enabled) return undefined;
	return await openAtomStore(ctx.cwd);
}

function atomDisabled() {
	return text(
		'atom is disabled ({ "atom": false } in grill.json or /grill atom off). Enable it to query the knowledge base.',
	);
}

export function registerAtomTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "atom_query",
		label: "Query Grill Atom",
		description:
			"Query the repo-scoped grill atom knowledge base (atoms with type/status/keyword filters). Read-only. Use to find decisions, specs, research, tasks and their canon paths.",
		promptSnippet: "Query the grill atom knowledge base",
		promptGuidelines: [
			"Use atom_query instead of scanning docs/ manually when looking for decisions, specs, research or tasks.",
		],
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({
					description:
						"Exact atom id (e.g. dec-0004) — returns that single atom with full body.",
				}),
			),
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
			status_not: Type.Optional(
				Type.String({
					description: `Exclude atoms in this status (${NODE_STATUSES.join("|")}).`,
				}),
			),
			q: Type.Optional(
				Type.String({ description: "Keyword filter over title + body." }),
			),
			scope: Type.Optional(
				Type.String({ description: "Filter by scope value." }),
			),
			after: Type.Optional(
				Type.String({
					description: "YYYY-MM-DD — only atoms created on/after this date.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max rows returned (default 50)." }),
			),
			sort: Type.Optional(
				Type.String({
					description: "created (recency, default) or id (id ASC).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			const opts = queryOptsFromParams(params);
			const rows = queryAtoms(store, {
				...opts,
				limit: opts.limit ?? QUERY_LIMIT,
			});
			if (params.id && rows.length) {
				return text(renderAtomFull(rows[0]), { rows: 1 });
			}
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
		name: "atom_create",
		label: "Create Grill Atom",
		description:
			"Create an atom: typed record with md body stored in .pi/knowledge/atoms.db. Returns the assigned id (e.g. dec-0005).",
		promptSnippet: "Create a grill atom",
		promptGuidelines: [
			"Use atom_create to record decisions, research, plans or other atoms without running a grill session.",
		],
		parameters: Type.Object({
			type: Type.String({
				description: `Atom type (${NODE_TYPES.join("|")}).`,
			}),
			title: Type.String({ description: "Short title." }),
			body: Type.String({ description: "Markdown body." }),
			scope: Type.Optional(
				Type.String({ description: "Scope label, e.g. 'auth'." }),
			),
			sources: Type.Optional(
				Type.Array(Type.String(), {
					description: "Source URLs/refs recorded as provenance.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			if (!(NODE_TYPES as readonly string[]).includes(params.type)) {
				return text(
					`Unknown type: ${params.type}. Valid types: ${NODE_TYPES.join(", ")}.`,
				);
			}
			const atom = createAtom(store, {
				type: params.type as NodeType,
				title: params.title,
				body: params.body,
				scope: params.scope,
				sources: params.sources,
			});
			return text(`Created ${atom.id} (${atom.type}) — ${atom.title}.`, {
				id: atom.id,
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("atom_create ")) +
					theme.fg("muted", args.title ?? ""),
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
		name: "atom_update",
		label: "Update Grill Atom",
		description:
			"Update an atom's body, status or scope in place. Changes to a promoted atom regenerate its md export.",
		promptSnippet: "Update a grill atom",
		promptGuidelines: [
			"Use atom_update to revise an atom body or move its status (e.g. draft → accepted). Prefer supersede for replacements.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Atom id, e.g. dec-0004." }),
			body: Type.Optional(
				Type.String({ description: "Replacement markdown body." }),
			),
			status: Type.Optional(
				Type.String({
					description: `New status (${NODE_STATUSES.join("|")}).`,
				}),
			),
			scope: Type.Optional(Type.String({ description: "New scope label." })),
			sources: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Full replacement source list (URLs/refs). Empty array clears provenance.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			if (
				params.status &&
				!(NODE_STATUSES as readonly string[]).includes(params.status)
			) {
				return text(
					`Unknown status: ${params.status}. Valid statuses: ${NODE_STATUSES.join(", ")}.`,
				);
			}
			if (
				params.body === undefined &&
				params.status === undefined &&
				params.scope === undefined &&
				params.sources === undefined
			) {
				return text("Nothing to update: pass body, status, scope or sources.");
			}
			const updated = updateAtom(store, params.id, {
				body: params.body,
				status: params.status as NodeStatus | undefined,
				scope: params.scope,
				sources: params.sources,
			});
			const touched = [
				params.body !== undefined ? "body" : "",
				params.status !== undefined ? "status" : "",
				params.scope !== undefined ? "scope" : "",
				params.sources !== undefined ? "sources" : "",
			].filter(Boolean);
			const regenerated =
				updated.status === "promoted" && updated.promoted_to
					? ` Export regenerated: ${updated.promoted_to}.`
					: "";
			return text(
				`Updated ${updated.id}: ${touched.join(", ")}.${regenerated}`,
				{ id: updated.id, touched },
			);
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("atom_update ")) +
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

	pi.registerTool({
		name: "atom_promote",
		label: "Promote Grill Atom",
		description:
			"Promote an atom: sets status=promoted and writes a readable md export into the repo tree (decisions → docs/decisions/<slug>.md, others → docs/atoms/<slug>.md; pass docs_path to override).",
		promptSnippet: "Promote a grill atom to a repo-tree export",
		promptGuidelines: [
			"Use atom_promote only when the repo needs the human-readable md export; promotion is an explicit step, never automatic.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Atom id, e.g. dec-0004." }),
			docs_path: Type.Optional(
				Type.String({
					description:
						"Repo-relative export path override, e.g. docs/decisions/my-call.md.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			const updated = promote(store, params.id, params.docs_path);
			return text(`Promoted ${updated.id} → ${updated.promoted_to}.`, {
				id: updated.id,
				promoted_to: updated.promoted_to,
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("atom_promote ")) +
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

	pi.registerTool({
		name: "atom_demote",
		label: "Demote Grill Atom",
		description:
			"Reverse a promotion: status → accepted, promoted_to cleared, md export deleted from the repo tree. Non-promoted atoms are a no-op.",
		promptSnippet: "Demote a promoted atom and remove its export",
		promptGuidelines: [
			"Use atom_demote when a promoted atom should no longer surface in the repo tree; the atom stays in the store.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Atom id, e.g. dec-0004." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			const result = demote(store, params.id);
			if (result.atom.status !== "promoted" && !result.removedExport) {
				return text(`${params.id} is not promoted — nothing to do.`, {
					id: params.id,
				});
			}
			const exportNote = result.removedExport
				? ` Export removed: ${result.removedExport}.`
				: " Export file was already absent.";
			return text(`Demoted ${result.atom.id} → accepted.${exportNote}`, {
				id: result.atom.id,
				removed: result.removedExport ?? null,
			});
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("atom_demote ")) +
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
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			return text(
				renderDigest(store, params.task ? { task: params.task } : undefined),
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
			"Create a typed edge between two atoms in the grill atom knowledge base (e.g. supersedes, depends-on). Mutates .pi/knowledge/atoms.db.",
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
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			if (!(EDGE_KINDS as readonly string[]).includes(params.kind)) {
				return text(
					`Unknown edge kind: ${params.kind}. Valid kinds: ${EDGE_KINDS.join(", ")}.`,
				);
			}
			const from = getAtom(store, params.from);
			const to = getAtom(store, params.to);
			if (!from || !to) {
				return text(`Atom not found: ${!from ? params.from : params.to}.`);
			}
			addEdge(store, params.from, params.to, params.kind as EdgeKind);
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
		label: "Backfill Atom Scope",
		description:
			"Attach a scope label to an atom after creation. Mutates .pi/knowledge/atoms.db metadata columns.",
		promptSnippet: "Attach a scope label to an atom",
		promptGuidelines: [
			"Use atom_backfill to fill scope on atoms instead of leaving it empty.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Atom id, e.g. dec-0004." }),
			scope: Type.String({
				description: "Scope label, e.g. 'auth' or 'ota'.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx) return atomDisabled();
			const store = await openAtom(ctx);
			if (!store) return atomDisabled();
			const atom = getAtom(store, params.id);
			if (!atom) return text(`Atom not found: ${params.id}.`);
			store.db
				.prepare("UPDATE atoms SET scope = ? WHERE id = ?")
				.run(params.scope, params.id);
			return text(`Backfilled ${params.id}: scope = ${params.scope}.`, {
				id: params.id,
				touched: ["scope"],
			});
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
