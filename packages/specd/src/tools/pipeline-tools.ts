import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkConsistency, formatFindings } from "../pipeline/consistency.js";
import { planWaves } from "../pipeline/schedule.js";
import { childItems, getItem, listItems } from "../store/store.js";
import { openSpecd, text } from "./store-tools.js";

export function registerPipelineTools(pi: ExtensionAPI): void {
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
				// Directional: tasks point at their spec (task part-of
				// spec) — a bidirectional read would match whatever the
				// spec links OUT to as well (plans, constitutions).
				const ids = new Set(
					childItems(store, params.spec, "part-of").map((i) => i.id),
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
}
