import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { branchName, ccTypeOf, scopeOf } from "../naming.js";
import { assertCanExport } from "../pipeline/gates.js";
import {
	DEFAULT_NAMING,
	readSinkConfig,
	readSinkSetup,
	saveSinkConfig,
} from "../sinks/config.js";
import type { TaskExport } from "../sinks/contract.js";
import { resolveAdapter } from "../sinks/resolve.js";
import {
	appendEvent,
	getItem,
	type ItemRow,
	linkedItems,
	type SpecdStore,
} from "../store/store.js";
import { openSpecd, text } from "./store-tools.js";

function slugify(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}

export function buildTaskExport(store: SpecdStore, task: ItemRow): TaskExport {
	// Sort by id so spec selection is deterministic even when SQLite
	// returns rows in an undefined order or a task is linked to more
	// than one spec.
	const specs = linkedItems(store, task.id, "part-of")
		.filter((i) => i.kind === "spec")
		.sort((a, b) => a.id.localeCompare(b.id));
	const spec = specs[0];
	const specSection = spec
		? `## Spec reference\n\n${spec.id} — ${spec.title}\n\n${spec.body.slice(0, 1500)}${spec.body.length > 1500 ? "\n…" : ""}`
		: "## Spec reference\n\n(none linked)";
	const body = `## Task\n\n${task.body || task.title}\n\n${specSection}\n\n---\nExported from specd (${task.id}).`;
	const labels = ["specd"];
	if (spec) labels.push(`spec:${slugify(spec.title)}`);
	const plan = readSinkSetup(store);
	if (plan) {
		for (const l of plan.labels) if (!labels.includes(l)) labels.push(l);
	}
	const naming = plan?.naming || DEFAULT_NAMING;
	const title = naming
		.replace("{type}", ccTypeOf(store, task.id))
		.replace("{scope}", scopeOf(task.path_scope) || task.id)
		.replace("{ref}", task.id)
		.replace("{title}", task.title);
	return { ref: task.id, title, body, labels };
}

export function registerExecTools(pi: ExtensionAPI): void {
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
			const branch = branchName(task, ccTypeOf(store, task.id));
			const parent = path.dirname(ctx.cwd);
			const leaf = path.basename(ctx.cwd);
			const worktreePath = path.join(
				parent,
				`${leaf}-specd-${task.id}`,
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
			const { snapshotGrill } = await import("../import/grill-source.js");
			const { mapSnapshot } = await import("../import/map.js");
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
			const { snapshotGrill } = await import("../import/grill-source.js");
			const { mapSnapshot } = await import("../import/map.js");
			const { planImport, applyImport } = await import("../import/run.js");
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
				"../import/run.js"
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
}
