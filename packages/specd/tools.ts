import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_LANES,
	DEFAULT_NAMING,
	readProjectPlan,
	readSinkConfig,
	saveProjectPlan,
	saveSinkConfig,
} from "./backends/config.js";
import type { PlanWorkspace, TaskExport } from "./backends/contract.js";
import { resolveAdapter } from "./backends/resolve.js";
import { syncExportedTasks } from "./backends/sync.js";
import { renderDashboard } from "./dashboard.js";
import { checkConsistency, formatFindings } from "./pipeline/consistency.js";
import {
	assertCanCompleteWork,
	assertCanExport,
	assertCanStartWork,
	assertSpecCreationAllowed,
	checklistState,
} from "./pipeline/gates.js";
import { planWaves } from "./pipeline/schedule.js";
import {
	EVENT_TYPES,
	type EventType,
	ITEM_KINDS,
	type ItemKind,
	LINK_KINDS,
	type LinkKind,
} from "./store/schema.js";
import { demoteItem, promoteItem } from "./store/storage.js";
import {
	addLink,
	appendEvent,
	counts,
	createItem,
	getItem,
	history,
	type ItemRow,
	linkedItems,
	listItems,
	openStore,
	parseJsonLoose,
	type SpecdStore,
} from "./store/store.js";

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

function text(content: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: content }],
		details,
	};
}

async function openSpecd(ctx: ExtensionContext): Promise<SpecdStore> {
	return openStore(ctx.cwd);
}

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
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

export function buildTaskExport(store: SpecdStore, task: ItemRow): TaskExport {
	const specs = linkedItems(store, task.id, "part-of").filter(
		(i) => i.kind === "spec",
	);
	const spec = specs[0];
	const specSection = spec
		? `## Spec reference\n\n${spec.id} — ${spec.title}\n\n${spec.body.slice(0, 1500)}${spec.body.length > 1500 ? "\n…" : ""}`
		: "## Spec reference\n\n(none linked)";
	const body = `## Task\n\n${task.body || task.title}\n\n${specSection}\n\n---\nExported from specd (${task.id}).`;
	const labels = ["specd"];
	if (spec) labels.push(`spec:${slugify(spec.title)}`);
	const plan = readProjectPlan(store);
	if (plan) {
		for (const l of plan.labels) if (!labels.includes(l)) labels.push(l);
	}
	const naming = plan?.naming || DEFAULT_NAMING;
	const title = naming.replace("{ref}", task.id).replace("{title}", task.title);
	return { ref: task.id, title, body, labels };
}

export function registerSpecdTools(pi: ExtensionAPI): void {
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
			const item = getItem(store, params.item);
			return text(
				`Appended ${event.type} to ${event.item}. Current state: ${item?.status ?? "?"}.`,
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
			const item = getItem(store, params.item);
			if (!item) return text(`Unknown item: ${params.item}.`);
			const events = history(store, params.item);
			const capsule = events.findLast((e) => e.type === "work.paused");
			const capsuleSection = capsule
				? renderCapsule(
						parseJsonLoose<Record<string, unknown>>(capsule.payload),
					)
				: "";
			const checklistSection =
				item.kind === "checklist"
					? renderChecklist(checklistState(store, params.item))
					: "";
			const historySection = events
				.map((e) => `- ${e.at} ${e.actor}: ${e.type}`)
				.join("\n");
			return text(
				`# ${item.id}\n\n- kind: ${item.kind}\n- status: ${item.status}\n- path scope: ${item.path_scope ?? "—"}\n\n${item.body}${capsuleSection}${checklistSection}\n\n## History\n\n${historySection}`,
			);
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
		name: "specd_consistency",
		label: "Specd consistency check",
		description:
			"Read-only cross-artifact consistency check over specs, plans, tasks and checklists: coverage gaps, gate blockers, parallel path-scope overlaps. Mechanical findings only — run it before export or /spec run, then do the semantic pass (contradictions, duplication, ambiguity). Fixes go to the SOURCE artifact, never downstream.",
		promptSnippet: "Check spec/plan/task consistency",
		parameters: Type.Object({
			item: Type.Optional(
				Type.String({
					description:
						"Scope the check to an item's part-of subgraph (e.g. a cycle or spec id). Omit for the whole store.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const findings = checkConsistency(store, params.item);
			return text(formatFindings(findings), { findings });
		},
	});

	pi.registerTool({
		name: "specd_schedule",
		label: "Schedule specd task execution",
		description:
			"Compute the execution waves for a spec's tasks (or all not-done tasks): tasks ordered by phase (setup → foundational → story → polish), [P]-marked tasks with disjoint path scopes share a wave, scope collisions are serialized into later waves. Run wave 1 concurrently, then wave 2, and so on. Read-only.",
		promptSnippet: "Compute parallel execution waves",
		parameters: Type.Object({
			spec: Type.Optional(
				Type.String({
					description:
						"Scope to the tasks linked part-of this spec id (e.g. spec-0001). Omit for all not-done tasks in the store.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			let tasks = listItems(store, { kind: "task" }).filter(
				(t) => t.status !== "done" && t.status !== "stopped",
			);
			if (params.spec) {
				const spec = getItem(store, params.spec);
				if (!spec) return text(`Unknown item: ${params.spec}.`);
				const ids = new Set(
					linkedItems(store, params.spec, "part-of").map((i) => i.id),
				);
				tasks = tasks.filter((t) => ids.has(t.id));
			}
			const result = planWaves(tasks);
			const lines: string[] = [];
			for (const wave of result.waves) {
				const concurrency =
					wave.tasks.length > 1
						? `run these ${wave.tasks.length} concurrently`
						: "single task";
				lines.push(
					`Wave ${wave.n} (${concurrency}):\n${wave.tasks.map((t) => `- ${t.id} ${t.title}${t.phase ? ` [${t.phase}]` : ""}${t.parallel ? " [P]" : ""} scope=${t.pathScope ?? "(unscoped)"}`).join("\n")}`,
				);
			}
			for (const s of result.serialized) {
				lines.push(`serialized ${s.a} after ${s.b}: ${s.reason}`);
			}
			if (result.waves.length === 0) lines.push("No tasks to schedule.");
			return text(lines.join("\n\n"), {
				waves: result.waves,
				serialized: result.serialized,
			});
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

	pi.registerTool({
		name: "specd_import_revert",
		label: "Revert a specd import batch",
		description:
			"Revert one grill→specd import batch: removes every batch item (plus its events, links, FTS rows) restoring the exact pre-import projection. Atomic and conservative — refuses when any batch item carries post-import work or links to native items. Pass no batch to list known batches.",
		promptSnippet: "Revert an import batch",
		parameters: Type.Object({
			batch: Type.Optional(
				Type.String({
					description:
						"The import batch id to revert. Omit to list known batches.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { listImportBatches, revertImport } = await import(
				"./import/run.js"
			);
			const store = await openSpecd(ctx);
			if (!params.batch) {
				const batches = listImportBatches(store);
				return text(
					batches.length === 0
						? "No import batches in this store."
						: `Known import batches:\n${batches.map((b) => `- ${b.batch}: ${b.items} items (imported ${b.at ?? "?"})`).join("\n")}\n\nRevert with specd_import_revert(batch=<id>).`,
					{ batches },
				);
			}
			const report = revertImport(store, params.batch);
			return text(
				`Reverted batch ${report.batch}: removed ${report.itemsRemoved.length} item(s) and ${report.linksRemoved} link(s). Pre-import projection restored.`,
				{ ...report },
			);
		},
	});

	pi.registerTool({
		name: "specd_export",
		label: "Export specd task to sink",
		description:
			"Export an approved task to a work sink (null = store-native, github = issues). Gated: the task's linked spec must be approved. First github export needs the project owner/number (persisted for later exports).",
		promptSnippet: "Export a task to the team's work sink",
		parameters: Type.Object({
			item: Type.String({ description: "Task item id (e.g. task-0001)." }),
			sink: Type.Optional(
				Type.String({
					description: 'Sink id ("null" or "github"). Defaults to null.',
				}),
			),
			lane: Type.Optional(
				Type.String({
					description: "Lane to place the item in (e.g. MVP).",
				}),
			),
			github_owner: Type.Optional(
				Type.String({
					description:
						"First github export: the project owner (user or org). Persisted for later exports.",
				}),
			),
			github_project_number: Type.Optional(
				Type.Number({
					description:
						"First github export: the Projects v2 project number. Persisted for later exports.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const sink = params.sink ?? "null";
			if (sink === "github") {
				const existing = readSinkConfig(store, "sink.github");
				if (params.github_owner && params.github_project_number) {
					saveSinkConfig(store, "sink.github", {
						owner: params.github_owner,
						projectNumber: params.github_project_number,
						lane: params.lane ?? existing?.lane,
					});
				}
			}
			const adapter = resolveAdapter(store, sink);
			const task = getItem(store, params.item);
			if (!task) return text(`Unknown item: ${params.item}.`);
			assertCanExport(store, params.item); // throws with plain-language reason
			const taskExport = buildTaskExport(store, task);
			const created = await adapter.createTask(taskExport);
			appendEvent(store, {
				item: task.id,
				type: "task.exported",
				payload: {
					sink: adapter.id,
					externalRef: created.externalRef,
					url: created.url,
				},
				actor: "agent",
			});
			let laneNote = "";
			const lane =
				params.lane ??
				(readSinkConfig(store, "sink.github")?.lane as string | undefined);
			if (adapter.placeInLane && lane) {
				try {
					await adapter.placeInLane(created.externalRef, lane);
					laneNote = ` Placed in lane "${lane}".`;
				} catch (error) {
					laneNote = ` Lane placement failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			return text(
				`Exported ${task.id} via ${adapter.id}${created.url ? ` — ${created.url}` : " (store-native)"}.${laneNote}`,
				{ externalRef: created.externalRef, url: created.url },
			);
		},
	});

	function sanitizeWorkspace(
		raw: Record<string, unknown> | undefined,
	): PlanWorkspace {
		const out: PlanWorkspace = {};
		for (const [k, v] of Object.entries(raw ?? {})) {
			if (typeof v === "string" || typeof v === "number") out[k] = v;
		}
		return out;
	}

	pi.registerTool({
		name: "specd_apply_plan",
		label: "Apply specd project plan",
		description:
			"Preview (default) or apply the project plan for a sink: workspace, lanes, label taxonomy, naming convention. Preview is read-only and lists what would change. Apply is idempotent — a converged plan yields no changes. The plan persists in the store and drives export titles, labels, and lane placement.",
		promptSnippet: "Preview/apply the project plan",
		parameters: Type.Object({
			sink: Type.String({
				description:
					'Sink id ("null", "github", "linear", "jira", "notion", "trello", or "clickup").',
			}),
			apply: Type.Optional(
				Type.Boolean({
					description:
						"true to apply (write); omit/false to preview only (read-only). Defaults to false.",
				}),
			),
			github_owner: Type.Optional(
				Type.String({
					description: "github workspace: owner (user or org).",
				}),
			),
			github_project_number: Type.Optional(
				Type.Number({
					description: "github workspace: Projects v2 project number.",
				}),
			),
			workspace: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description:
						"Non-github sinks: workspace coords — linear {teamId}; jira {projectKey, issueTypeName?}; notion {databaseId}; trello {boardId, listId?}; clickup {teamId, spaceId, listId}. Persisted and reused.",
				}),
			),
			lanes: Type.Optional(
				Type.Array(Type.String(), {
					description: `Lanes (board status options). Defaults: ${DEFAULT_LANES.join(", ")}.`,
				}),
			),
			labels: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Label taxonomy ensured on the workspace. Defaults: specd.",
				}),
			),
			naming: Type.Optional(
				Type.String({
					description: `Export title convention with {ref} and {title} placeholders. Defaults: "${DEFAULT_NAMING}".`,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const sink = params.sink;

			// Build the workspace from params + stored config.
			const stored = readSinkConfig(store, "sink.github");
			const workspace: PlanWorkspace =
				sink === "github"
					? {
							owner:
								params.github_owner ??
								(typeof stored?.owner === "string" ? stored.owner : undefined),
							projectNumber:
								params.github_project_number ??
								(typeof stored?.projectNumber === "number"
									? stored.projectNumber
									: undefined),
						}
					: sanitizeWorkspace(
							params.workspace ?? readSinkConfig(store, `sink.${sink}`),
						);

			// Persist the workspace coords so later exports resolve the
			// adapter straight from the store.
			const priorConfig = readSinkConfig(store, `sink.${sink}`) ?? {};
			saveSinkConfig(store, `sink.${sink}`, {
				...priorConfig,
				...workspace,
			});

			// Merge with defaults and any stored plan.
			const prior = readProjectPlan(store);
			const plan = {
				workspace,
				lanes: params.lanes ?? prior?.lanes ?? [...DEFAULT_LANES],
				labels: params.labels ?? prior?.labels ?? ["specd"],
				naming: params.naming ?? prior?.naming ?? DEFAULT_NAMING,
			};

			const adapter = resolveAdapter(store, sink);
			if (!adapter.previewPlan || !adapter.ensurePlan) {
				return text(
					`Sink "${sink}" does not support project plans (no external board). Nothing to apply.`,
				);
			}

			if (!params.apply) {
				const changes = await adapter.previewPlan(plan);
				saveProjectPlan(store, plan, sink); // persist intent even on preview
				return text(
					changes.length === 0
						? `Plan preview for ${sink}: already converged — no changes needed.`
						: `Plan preview for ${sink} (${changes.length} change(s)):\n${changes.map((c) => `- ${c}`).join("\n")}\n\nRe-run with apply=true to apply.`,
					{ changes, plan },
				);
			}

			const changes = await adapter.ensurePlan(plan);
			saveProjectPlan(store, plan, sink);
			return text(
				changes.length === 0
					? `Plan applied for ${sink}: already converged — no changes.`
					: `Plan applied for ${sink} (${changes.length} change(s)):\n${changes.map((c) => `- ${c}`).join("\n")}`,
				{ changes, plan },
			);
		},
	});

	pi.registerTool({
		name: "specd_create_worktree",
		label: "Create specd execution worktree",
		description:
			"Create a plain git worktree for the task with branch specd/<task-id>-<slug>. The /spec run prompt expects this tool to be called before spawning the worker so branch naming and isolation are convention-owned. Returns the worktree path and branch.",
		promptSnippet: "Create a specd-style worktree for task execution",
		parameters: Type.Object({
			item: Type.String({ description: "Task id (e.g. task-0001)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const task = getItem(store, params.item);
			if (!task) return text(`Unknown item: ${params.item}.`);
			const slug = slugify(task.title);
			const branch = `specd/${task.id}-${slug}`.slice(0, 96);
			const parent = path.dirname(ctx.cwd);
			const leaf = path.basename(ctx.cwd);
			const worktreePath = path.join(
				parent,
				`${leaf}-${branch.replace(/\//g, "-")}`,
			);
			const { execFileSync } = await import("node:child_process");
			try {
				execFileSync("git", ["worktree", "add", "-b", branch, worktreePath], {
					cwd: ctx.cwd,
					stdio: "pipe",
				});
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return text(`Worktree creation failed: ${msg}`);
			}
			return text(
				`Worktree ready.\n- path: ${worktreePath}\n- branch: ${branch}\n\nSpawn the worker in cwd=${worktreePath} (subagent tool, agent=worker, worktree=false — the worker inherits the prepared worktree).`,
				{ path: worktreePath, branch },
			);
		},
	});

	pi.registerTool({
		name: "specd_import_preview",
		label: "Preview grill→specd import",
		description:
			"Read-only preview of a grill atoms.db → specd store migration. Returns counts by grill type, sample items, and the number of edges that will become specd links. Pass apply=true to specd_import_apply to run.",
		promptSnippet: "Preview a grill→specd import",
		parameters: Type.Object({
			source: Type.String({
				description:
					"Path to the grill repo root (where .pi/knowledge/atoms.db lives).",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { snapshotGrill } = await import("./import/grill-source.js");
			const { mapSnapshot } = await import("./import/map.js");
			const snap = snapshotGrill(params.source);
			const mapped = mapSnapshot(snap);
			const counts = new Map<string, number>();
			for (const atom of snap.atoms) {
				counts.set(atom.type, (counts.get(atom.type) ?? 0) + 1);
			}
			const sample = mapped.items
				.slice(0, 5)
				.map(
					(item) =>
						`- ${item.originId} (${item.originalType}) → ${item.kind}: ${item.title}`,
				)
				.join("\n");
			return text(
				`Import preview from ${params.source}:\n\nAtoms by grill type:\n${[
					...counts.entries(),
				]
					.map(([k, v]) => `  - ${k}: ${v}`)
					.join(
						"\n",
					)}\n\nMapped items: ${mapped.items.length}\nMapped links: ${mapped.links.length}\nSkipped edges (promoted-to / unknown): ${mapped.skippedEdges.length}\n\nSample:\n${sample}\n\nRe-run as specd_import_apply(source=<path>, apply=true) to write.`,
				{
					source: params.source,
					counts: Object.fromEntries(counts),
					sample: mapped.items.slice(0, 5),
				},
			);
		},
	});

	pi.registerTool({
		name: "specd_import_apply",
		label: "Apply grill→specd import",
		description:
			"Run the grill→specd import in one transaction. Returns counts of items + links created. Idempotent: re-running with the same source skips already-imported atoms via the `imported` event origin_id.",
		promptSnippet: "Apply a grill→specd import",
		parameters: Type.Object({
			source: Type.String({
				description:
					"Path to the grill repo root (where .pi/knowledge/atoms.db lives).",
			}),
			apply: Type.Boolean({ description: "Must be true to write." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.apply) {
				return text(
					"Import refused: apply=true is required to write. Run specd_import_preview first to inspect the mapping.",
				);
			}
			const { snapshotGrill } = await import("./import/grill-source.js");
			const { mapSnapshot } = await import("./import/map.js");
			const { planImport, applyImport } = await import("./import/run.js");
			const store = await openSpecd(ctx);
			const snap = snapshotGrill(params.source);
			const mapped = mapSnapshot(snap);
			const batch = `import-${Date.now()}`;
			const plan = planImport(store, mapped, batch);
			// Build the id map from the plan so applyImport doesn't need
			// to look it up again.
			const idMap = new Map<string, string>();
			for (const c of plan.created) idMap.set(c.originId, c.itemId);
			const report = applyImport(
				store,
				plan.steps,
				plan.links,
				idMap,
				batch,
				ctx.ui ? "agent" : "system",
			);
			return text(
				`Import applied.\n- items created: ${report.created.length}\n- links added: ${report.linksAdded}\n- links skipped (cross-import or duplicates): ${report.linksSkipped}\n- batch: ${batch}`,
				{ report },
			);
		},
	});
}
