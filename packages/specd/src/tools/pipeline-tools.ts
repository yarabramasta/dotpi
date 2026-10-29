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
			"Read-only cross-artifact consistency check (coverage gaps, gate blockers, scope overlaps). Mechanical findings only — run before export or /spec run, then do the semantic pass. Fixes go to the SOURCE artifact.",
		promptSnippet: "Check spec/plan/task consistency",
		parameters: Type.Object({
			item: Type.Optional(
				Type.String({
					description:
						"Scope to an item's part-of subgraph; omit for the whole store.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const findings = checkConsistency(store, params.item);
			return text(formatFindings(findings));
		},
	});

	pi.registerTool({
		name: "specd_schedule",
		label: "Schedule specd task execution",
		description:
			"Compute execution waves for a spec's tasks (or all not-done tasks): phase-ordered; [P] tasks with disjoint scopes share a wave; collisions serialize later. Run wave 1 concurrently, then wave 2. Read-only.",
		promptSnippet: "Compute parallel execution waves",
		parameters: Type.Object({
			spec: Type.Optional(
				Type.String({
					description:
						"Tasks linked part-of this spec id; omit for all not-done tasks.",
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
				// Compact per-task lines (T8): collisions and their reasons are
				// already listed below — the schedule line carries only the
				// identity, phase, and parallel marker.
				lines.push(
					`Wave ${wave.n} (${concurrency}):\n${wave.tasks.map((t) => `- ${t.id} ${t.title}${t.phase ? ` [${t.phase}]` : ""}${t.parallel ? " [P]" : ""}`).join("\n")}`,
				);
			}
			for (const s of result.serialized) {
				lines.push(`serialized ${s.a} after ${s.b}: ${s.reason}`);
			}
			if (result.waves.length === 0) lines.push("No tasks to schedule.");
			return text(lines.join("\n\n"));
		},
	});
}
