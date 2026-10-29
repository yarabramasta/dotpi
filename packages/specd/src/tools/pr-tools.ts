import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type CheckReport,
	type OpenPrResult,
	openPr,
	watchChecks,
} from "../sinks/github/pr.js";
import { realGhRunner } from "../sinks/github/runner.js";
import { appendEvent, getItem } from "../store/store.js";
import { openSpecd, text } from "./store-tools.js";

/** PR/CI seam tools (plan-0006 slice 2). specd_open_pr enforces the review
 * gate in code (D4 — the gate IS gates.checkCanCompleteWork) and records
 * pr.created itself, so the run prompt stops carrying raw gh folklore.
 * watchChecks is a single non-blocking poll (D3) — the agent re-invokes. */
export function registerPrTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "specd_open_pr",
		label: "Open a PR for a specd task",
		description:
			"Open the PR for a task's convention branch via gh. Refuses without a passing review.completed. Idempotent: returns the existing PR URL; records pr.created.",
		promptSnippet: "Open a review-gated PR for a specd task",
		parameters: Type.Object({
			item: Type.String({ description: "Task id (e.g. task-0001)." }),
			summary: Type.Optional(
				Type.String({
					description: "PR body (plain prose); defaults to the task title.",
				}),
			),
			base: Type.Optional(
				Type.String({
					description: "Base branch; defaults to the repo default.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const task = getItem(store, params.item);
			if (!task) return text(`Unknown item: ${params.item}.`);
			let result: OpenPrResult;
			try {
				result = await openPr(store, realGhRunner, ctx.cwd, {
					taskId: params.item,
					summary: params.summary,
					base: params.base,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return text(`PR refused: ${message}`);
			}
			if (!result.created) {
				return text(`PR already open for ${result.branch}: ${result.url}`, {
					branch: result.branch,
					created: false,
					url: result.url,
				});
			}
			appendEvent(store, {
				item: params.item,
				type: "pr.created",
				payload: { url: result.url, branch: result.branch },
				actor: "agent",
			});
			return text(
				`PR opened: ${result.url} (branch ${result.branch}). Poll CI with specd_watch_checks(item=${params.item}) — a single non-blocking poll per call.`,
				{ branch: result.branch, created: true, url: result.url },
			);
		},
	});

	pi.registerTool({
		name: "specd_watch_checks",
		label: "Poll CI checks for a task's PR",
		description:
			"Single non-blocking poll of gh pr checks for the task's convention branch. Returns {state: passed|failed|pending, failing: [names]} — the agent re-invokes to re-poll and fixes failures between polls.",
		promptSnippet: "Poll CI checks for a specd task's PR",
		parameters: Type.Object({
			item: Type.String({ description: "Task id (e.g. task-0001)." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const task = getItem(store, params.item);
			if (!task) return text(`Unknown item: ${params.item}.`);
			let report: CheckReport;
			try {
				report = await watchChecks(store, realGhRunner, ctx.cwd, params.item);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return text(`Check poll failed: ${message}`);
			}
			const failing = report.failing.length
				? ` — failing: ${report.failing.join(", ")}`
				: "";
			const hint =
				report.state === "failed"
					? ` Diagnose before fixing: /spec diagnose ${params.item}.`
					: "";
			return text(`CI checks ${report.state}${failing}.${hint}`, { ...report });
		},
	});
}
