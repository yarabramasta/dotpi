import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	assertCanCompleteWork,
	assertCanExport,
	assertCanStartWork,
	assertSpecCreationAllowed,
	checklistState,
} from "../pipeline/gates.js";
import { renderDashboard } from "../report.js";
import { syncExportedTasks } from "../sinks/sync.js";
import { isSpecdStore, resolveReferenceStores } from "../store/registry.js";
import {
	EVENT_TYPES,
	type EventType,
	ITEM_KINDS,
	type ItemKind,
	LINK_KINDS,
	type LinkKind,
} from "../store/schema.js";
import { demoteItem, promoteItem } from "../store/storage.js";
import {
	addLink,
	appendEvent,
	counts,
	createItem,
	getItem,
	history,
	listItems,
	openStore,
	openStoreReadOnly,
	parseJsonLoose,
	type SpecdStore,
} from "../store/store.js";

export function text(content: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: content }],
		details,
	};
}

export async function openSpecd(ctx: ExtensionContext): Promise<SpecdStore> {
	return openStore(ctx.cwd);
}

/** Render a work.paused capsule payload (decisions / openQuestions /
 * evidence / nextStep) as a readable block above the event timeline.
 * Anything unknown is preserved as-is under "extras" so callers don't
 * lose information if the schema grows. */
function renderCapsule(payload: Record<string, unknown> | undefined): string {
	if (!payload) return "";
	const section = (label: string, value: unknown): string => {
		if (value === undefined || value === null) return "";
		const items = Array.isArray(value)
			? value.map((v) => `- ${String(v)}`).join("\n")
			: String(value);
		if (!items.trim()) return "";
		return `\n### ${label}\n${items}`;
	};
	const known = new Set(["decisions", "openQuestions", "evidence", "nextStep"]);
	const extras = Object.entries(payload)
		.filter(([k]) => !known.has(k))
		.map(([k, v]) => `- ${k}: ${String(v)}`)
		.join("\n");
	return (
		"\n\n## Resume Capsule\n" +
		section("Decisions", payload.decisions) +
		section("Open Questions", payload.openQuestions) +
		section("Evidence", payload.evidence) +
		section("Next Step", payload.nextStep ? [payload.nextStep] : undefined) +
		(extras ? `\n### Extras\n${extras}` : "")
	);
}

/** Render a checklist with [x]/[ ] markers based on reviewer-owned
 * `checklist.item.checked` events. Returns empty when the item is not
 * a checklist or the items list is missing — caller omits the section. */
function renderChecklist(
	state: ReturnType<typeof checklistState> | undefined,
): string {
	if (!state || state.items.length === 0) return "";
	const lines = state.items.map((text, i) => {
		const mark = state.checkedIndexes.includes(i) ? "[x]" : "[ ]";
		return `- ${mark} ${text}`;
	});
	const remaining = state.items.length - state.checkedIndexes.length;
	const summary =
		remaining === 0
			? `\n*(${state.items.length}/${state.items.length} checked — all clear.)*`
			: `\n*(${state.checkedIndexes.length}/${state.items.length} checked — ${remaining} remaining.)*`;
	return `\n\n## Checklist\n${lines.join("\n")}${summary}`;
}

/** Dashboard content shared by the /spec command and the specd_dashboard
 * tool. Read-back sync runs best-effort first (exported tasks whose sink
 * item closed become done), then the projection snapshot renders. */
export async function dashboardContent(store: SpecdStore): Promise<string> {
	try {
		await syncExportedTasks(store);
	} catch {
		// best-effort: an unreachable sink never breaks the dashboard
	}
	const rows = listItems(store, { limit: 20 });
	const paused = rows
		.filter((r) => history(store, r.id).at(-1)?.type === "work.paused")
		.map((r) => r.id);
	return renderDashboard(rows, counts(store), paused);
}

export function registerStoreTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "specd_create_item",
		label: "Create specd item",
		description:
			"Create an item in the specd store. Kinds: spec (requires cycle with explore decision go), plan, task, cycle, epic, roadmap, constitution, checklist, knowledge. Returns the generated id.",
		promptSnippet: "Create a specd store item",
		parameters: Type.Object({
			kind: Type.String({
				description: `Item kind (${ITEM_KINDS.join("|")}).`,
			}),
			title: Type.String({ description: "Short title." }),
			body: Type.Optional(
				Type.String({
					description:
						"Item body. For specs use the template: Intent / Requirements (numbered, testable) / Acceptance criteria / Out of scope.",
				}),
			),
			path_scope: Type.Optional(
				Type.String({
					description:
						"For tasks: the file paths this task owns (e.g. src/auth/**).",
				}),
			),
			cycle: Type.Optional(
				Type.String({
					description:
						"For specs (required): the cycle id whose latest explore decision must be 'go'. The spec is auto-linked part-of the cycle.",
				}),
			),
			phase: Type.Optional(
				Type.String({
					description:
						"For tasks: execution phase (setup/foundational/story/polish).",
				}),
			),
			parallel: Type.Optional(
				Type.Boolean({
					description:
						"For tasks: true when the task may run concurrently with others.",
				}),
			),
			extra: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description:
						"Kind-specific extras merged into the created event (e.g. checklists: { items: [...] }).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			if (params.kind === "spec") {
				// The explore decision gate: only a cycle whose latest explore
				// decision is "go" may spawn a spec.
				assertSpecCreationAllowed(store, params.cycle);
			}
			const item = createItem(store, {
				kind: params.kind as ItemKind,
				title: params.title,
				body: params.body,
				pathScope: params.path_scope,
				phase: params.phase,
				parallel: params.parallel,
				extra: params.extra,
				actor: "agent",
			});
			if (params.kind === "spec" && params.cycle) {
				addLink(store, item.id, params.cycle, "part-of");
			}
			return text(
				`Created ${item.id} (${item.kind}, draft) — ${item.title}.${params.kind === "spec" && params.cycle ? ` Linked part-of ${params.cycle}.` : ""}`,
				{ id: item.id },
			);
		},
	});

	pi.registerTool({
		name: "specd_append_event",
		label: "Append specd event",
		description:
			"Append an event to a specd item's history. Status-changing events move the item's projected state. Gated events: task.exported requires an approved spec; work.started requires reviewer-checked requirements checklists and no overlapping in-progress path scope; work.completed requires a passing review.completed.",
		promptSnippet: "Append an event to a specd item",
		parameters: Type.Object({
			item: Type.String({ description: "Item id (e.g. task-0001)." }),
			type: Type.String({
				description: `Event type (${EVENT_TYPES.join("|")}).`,
			}),
			payload: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Event payload (free-form JSON object).",
				}),
			),
			batch: Type.Optional(
				Type.String({ description: "Batch id (migration runs use this)." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const type = params.type as EventType;
			if (type === "task.exported") {
				assertCanExport(store, params.item); // throws with plain-language reason
			}
			if (type === "work.started") {
				// Execution gates: reviewer-owned checklists clear, and no
				// in-progress task claims an overlapping path scope.
				assertCanStartWork(store, params.item);
			}
			if (type === "work.completed") {
				// A reviewer subagent must have signed off (review.completed
				// with passed=true) — failing review blocks completion.
				assertCanCompleteWork(store, params.item);
			}
			const event = appendEvent(store, {
				item: params.item,
				type,
				payload: params.payload,
				actor: "agent",
				batch: params.batch,
			});
			// Push-side status flow (D15): after a status-changing event,
			// push the mapped workflow option to the sink. Must run AFTER
			// appendEvent — pushStatusToSink reads the item's new status.
			// Best-effort — sink failure doesn't block the store event, but
			// it is surfaced so pushes can't fail silently.
			let sinkPush: string | undefined;
			if (type === "work.started" || type === "work.completed") {
				try {
					const { pushStatusToSink } = await import("../sinks/sync.js");
					sinkPush = await pushStatusToSink(store, params.item);
				} catch (e) {
					sinkPush = `push failed: ${e instanceof Error ? e.message : String(e)}`;
				}
			}
			const item = getItem(store, params.item);
			return text(
				`Appended ${event.type} to ${event.item}. Current state: ${item?.status ?? "?"}.${sinkPush ? ` Sink: ${sinkPush}.` : ""}`,
			);
		},
	});

	pi.registerTool({
		name: "specd_add_link",
		label: "Link specd items",
		description:
			"Link two specd items with a typed relation (e.g. task part-of spec).",
		promptSnippet: "Link two specd items",
		parameters: Type.Object({
			from: Type.String({ description: "Source item id." }),
			to: Type.String({ description: "Target item id." }),
			kind: Type.String({
				description: `Relation kind (${LINK_KINDS.join("|")}).`,
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			addLink(store, params.from, params.to, params.kind as LinkKind);
			return text(`Linked ${params.from} -[${params.kind}]-> ${params.to}.`);
		},
	});

	pi.registerTool({
		name: "specd_show",
		label: "Show specd item",
		description:
			"Show one specd item in full: current state, body, and its complete event history.",
		promptSnippet: "Show a specd item with its history",
		parameters: Type.Object({
			item: Type.String({ description: "Item id (e.g. spec-0001)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			let item = getItem(store, params.item);
			let itemStore: SpecdStore = store;
			let from: string | undefined;
			const opened: SpecdStore[] = [];
			try {
				if (!item) {
					for (const dir of resolveReferenceStores(ctx.cwd)) {
						const ref = openStoreReadOnly(dir);
						if (!ref) continue;
						opened.push(ref);
						const found = getItem(ref, params.item);
						if (found) {
							item = found;
							itemStore = ref;
							from = dir;
							break;
						}
					}
				}
				if (!item) {
					const refNote =
						resolveReferenceStores(ctx.cwd).length > 0
							? " (searched referenced stores too)"
							: "";
					return text(`Unknown item: ${params.item}.${refNote}`);
				}
				const events = history(itemStore, params.item);
				const capsule = events.findLast((e) => e.type === "work.paused");
				const capsuleSection = capsule
					? renderCapsule(
							parseJsonLoose<Record<string, unknown>>(capsule.payload),
						)
					: "";
				const checklistSection =
					item.kind === "checklist"
						? renderChecklist(checklistState(itemStore, params.item))
						: "";
				const historySection = events
					.map((e) => `- ${e.at} ${e.actor}: ${e.type}`)
					.join("\n");
				const fromLine = from ? `- from: ${from}\n` : "";
				return text(
					`# ${item.id}\n\n- kind: ${item.kind}\n- status: ${item.status}\n- path scope: ${item.path_scope ?? "—"}\n${fromLine}\n${item.body}${capsuleSection}${checklistSection}\n\n## History\n\n${historySection}`,
				);
			} finally {
				for (const ref of opened) {
					if (ref !== itemStore) {
						ref.db.close();
					}
				}
				if (itemStore !== store) {
					itemStore.db.close();
				}
			}
		},
	});

	pi.registerTool({
		name: "specd_dashboard",
		label: "specd dashboard",
		description:
			"Current state of the specd store: all items, statuses, counts. Runs sink read-back sync first (best-effort).",
		promptSnippet: "Show the specd dashboard",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			return text(await dashboardContent(store));
		},
	});

	pi.registerTool({
		name: "specd_query",
		label: "Query specd items",
		description:
			"Query specd items with filters and get short insight: filter by kind/status/text, scope to items linked to an item, and render one-line digests (state, last event, links). For full histories use specd_show; for store-wide state use specd_dashboard.",
		promptSnippet: "Query and summarize items",
		parameters: Type.Object({
			kind: Type.Optional(
				Type.String({ description: "Filter by item kind (e.g. task, spec)." }),
			),
			status: Type.Optional(
				Type.String({
					description: "Filter by projected status (e.g. exported, done).",
				}),
			),
			q: Type.Optional(
				Type.String({
					description:
						"Case-insensitive substring search over titles and bodies.",
				}),
			),
			of: Type.Optional(
				Type.String({
					description:
						"Item id — restrict to items linked to/from it (part-of family, direction annotated by the digest).",
				}),
			),
			insight: Type.Optional(
				Type.Boolean({
					description:
						"true renders one-line digests per match (state, last event, links) and, for exactly one match, a fuller summary.",
				}),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max matches returned. Defaults to 20." }),
			),
			store: Type.Optional(
				Type.String({
					description:
						'Store to query: omit for local only, "all" for local plus referenced stores, or an absolute store directory path.',
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { insightLine, queryItems, renderInsight } = await import(
				"../query.js"
			);
			const scope = params.store;
			let primary: SpecdStore;
			let referenced: SpecdStore[] = [];
			let primaryIsLocal = false;
			let specificHandle: SpecdStore | undefined;
			const openRefs = (): SpecdStore[] =>
				resolveReferenceStores(ctx.cwd)
					.map((dir) => openStoreReadOnly(dir))
					.filter((s): s is SpecdStore => s !== undefined);
			try {
				if (!scope) {
					primary = await openSpecd(ctx);
					primaryIsLocal = true;
				} else if (scope === "all") {
					primary = await openSpecd(ctx);
					primaryIsLocal = true;
					referenced = openRefs();
				} else {
					const dir = path.resolve(scope);
					if (!isSpecdStore(dir)) {
						return text(
							`Not a specd store: ${dir}\n\nProvide an absolute path to a store directory containing store.db.`,
						);
					}
					const ref = openStoreReadOnly(dir);
					if (!ref) {
						return text(
							`Could not open specd store read-only: ${dir}\n\nThe store.db may be missing or uninitialized.`,
						);
					}
					specificHandle = ref;
					primary = ref;
				}
				const rows = queryItems(
					primary,
					{
						kind: params.kind,
						status: params.status,
						q: params.q,
						of: params.of,
						limit: params.limit,
					},
					referenced,
				);
				if (rows.length === 0) {
					return text("No items match the query.", { matches: [] });
				}
				if (params.insight) {
					const lines = rows
						.map((r) => insightLine(primary, r.id, referenced, r.source))
						.join("\n");
					const deep =
						rows.length === 1
							? `\n\n${renderInsight(primary, rows[0].id, referenced, rows[0].source)}`
							: "";
					return text(lines + deep);
				}
				const table = rows
					.map(
						(r) =>
							`- **${r.id}** (${r.kind}, ${r.status})${r.source ? ` (from: ${r.source})` : ""} ${r.title}`,
					)
					.join("\n");
				return text(`${rows.length} match(es):\n${table}`);
			} finally {
				for (const ref of referenced) {
					ref.db.close();
				}
				if (!primaryIsLocal && specificHandle) {
					specificHandle.db.close();
				}
			}
		},
	});

	pi.registerTool({
		name: "specd_remove_link",
		label: "Remove a specd link",
		description:
			"Remove one typed relation between two items (e.g. to exercise a consistency negative probe, or correct a mistyped link). Destructive but surgical: only this edge is deleted; items and events are untouched. Note: links are not event-sourced — the removal is not recorded in any item's history.",
		promptSnippet: "Remove a link between items",
		parameters: Type.Object({
			from: Type.String({ description: "Source item id." }),
			to: Type.String({ description: "Target item id." }),
			kind: Type.String({
				description: `Relation kind (${LINK_KINDS.join("|")}).`,
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const result = store.db
				.prepare(
					"DELETE FROM links WHERE from_item = ? AND to_item = ? AND kind = ?",
				)
				.run(params.from, params.to, params.kind);
			if (result.changes === 0) {
				return text(
					`No ${params.kind} link from ${params.from} to ${params.to} — nothing removed.`,
				);
			}
			return text(`Removed ${params.kind} link ${params.from} → ${params.to}.`);
		},
	});

	pi.registerTool({
		name: "specd_promote",
		label: "Promote specd item to md",
		description:
			"Write (or remove) an item's readable md mirror, per the configured storage mode (/spec storage). db-only mode refuses; md-inrepo writes docs/specd/<id>.md; md-external writes into the configured directory. Re-promoting is idempotent.",
		promptSnippet: "Promote an item to an md file",
		parameters: Type.Object({
			item: Type.String({ description: "Item id (e.g. spec-0001)." }),
			demote: Type.Optional(
				Type.Boolean({
					description:
						"true removes the md mirror and promotion record instead of writing it. Defaults to false.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			if (params.demote) {
				const removed = demoteItem(store, params.item);
				return text(
					removed
						? `Removed the md mirror for ${params.item}.`
						: `${params.item} has no promoted md mirror.`,
				);
			}
			const path = promoteItem(store, params.item);
			return text(`Promoted ${params.item} → ${path}`);
		},
	});
}
