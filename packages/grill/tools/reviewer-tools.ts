import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	eligibleAuditors,
	type GroundingView,
	type ScoutAgent,
} from "../grounding.js";
import {
	appendCheckpointNote,
	deriveReviewerTask,
	reviewerResultText,
} from "../prompts.js";
import type { GrillHelpers } from "../runtime.js";
import {
	currentPhase,
	type GrillPhase,
	runtime,
	STATE_SCHEMA_VERSION,
} from "../state.js";

type ReviewerDetails = {
	reviewer?: GroundingView;
	rounds?: number;
	phase?: GrillPhase;
};

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const REVIEWER_TIMEOUT_MS = 15 * 60_000;
const MAX_REVIEWER_ROUNDS = 2;

interface RpcReply {
	version?: number;
	requestId?: string;
	success?: boolean;
	data?: { runId?: string; id?: string; [key: string]: unknown };
	error?: { code?: string; message?: string };
}

interface AsyncCompletePayload {
	runId?: string;
	summary?: string;
	results?: Array<{ agent?: string; summary?: string; status?: string }>;
	[key: string]: unknown;
}

/** Spawn one read-only reviewer through the pi-subagents RPC and resolve with
 * its report. Extension-driven spawn (first-class): the model never launches
 * the reviewer itself. Returns undefined fields when the run cannot start. */
function spawnReviewer(
	pi: ExtensionAPI,
	agent: string,
	task: string,
): Promise<GroundingView | undefined> {
	const requestId = `grill-reviewer-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;

	return new Promise((resolve) => {
		let runId: string | undefined;
		let settled = false;
		const offReply = pi.events.on(
			`subagents:rpc:v1:reply:${requestId}`,
			(data: unknown) => {
				const reply = data as RpcReply | undefined;
				if (!reply?.success) {
					resolve({
						summary: "",
						skippedReason: `pi-subagents spawn failed: ${reply?.error?.message ?? "unknown error"}`,
					});
					return;
				}
				runId = reply.data?.runId ?? reply.data?.id;
				if (!runId) {
					resolve({
						summary: "",
						skippedReason: "pi-subagents spawn returned no run id",
					});
				}
			},
		);
		const offComplete = pi.events.on(ASYNC_COMPLETE_EVENT, (data: unknown) => {
			if (!runId) return;
			const payload = data as AsyncCompletePayload | undefined;
			if (payload?.runId !== runId) return;
			const child = payload.results?.find((r) => r?.summary);
			const summary = child?.summary ?? payload.summary;
			resolve(
				summary
					? { summary: summary.slice(0, 12000) }
					: {
							summary: "",
							skippedReason: "reviewer completed without a report",
						},
			);
		});
		const timeout = setTimeout(() => {
			resolve({
				summary: "",
				skippedReason: `reviewer run timed out after ${Math.round(REVIEWER_TIMEOUT_MS / 60_000)} min`,
			});
		}, REVIEWER_TIMEOUT_MS);
		timeout.unref?.();

		// Single settle guard: first resolve wins, listeners detached.
		const guardedResolve = (view: GroundingView | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			offReply();
			offComplete();
			resolve(view);
		};
		// Wrap the two inline resolvers through guardedResolve.
		offReply();
		offComplete();
		const replyHandler = (data: unknown) => {
			const reply = data as RpcReply | undefined;
			if (!reply?.success) {
				guardedResolve({
					summary: "",
					skippedReason: `pi-subagents spawn failed: ${reply?.error?.message ?? "unknown error"}`,
				});
				return;
			}
			runId = reply.data?.runId ?? reply.data?.id;
			if (!runId) {
				guardedResolve({
					summary: "",
					skippedReason: "pi-subagents spawn returned no run id",
				});
			}
		};
		const completeHandler = (data: unknown) => {
			if (!runId) return;
			const payload = data as AsyncCompletePayload | undefined;
			if (payload?.runId !== runId) return;
			const child = payload.results?.find((r) => r?.summary);
			const summary = child?.summary ?? payload.summary;
			guardedResolve(
				summary
					? { summary: summary.slice(0, 12000) }
					: {
							summary: "",
							skippedReason: "reviewer completed without a report",
						},
			);
		};
		pi.events.on(`subagents:rpc:v1:reply:${requestId}`, replyHandler);
		pi.events.on(ASYNC_COMPLETE_EVENT, completeHandler);

		pi.events.emit(RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method: "spawn",
			params: {
				agent,
				task,
				context: "fresh",
				outputSchema: {
					type: "object",
					properties: {
						verdict: { type: "string", enum: ["PASS", "GAPS"] },
						gaps: { type: "array", items: { type: "string" } },
					},
					required: ["verdict"],
				},
			},
		});
	});
}

export function registerReviewerTools(
	pi: ExtensionAPI,
	helpers: GrillHelpers,
): void {
	const { persist, updateUi } = helpers;
	pi.registerTool({
		name: "grill_run_reviewer",
		label: "Run Grill Reviewer",
		description:
			"Spawn ONE read-only reviewer subagent via the pi-subagents RPC to verify the grill session is in sync: checkpoint decisions vs produced outputs vs edited files. Returns PASS or a gap list. Capped at 2 rounds per session.",
		promptSnippet: "Run the end-of-process Grill Me reviewer sync pass",
		promptGuidelines: [
			'After producing/applying the approved outputs, call subagent({ action: "list", capabilities: true }) once, then pass its live capability rows to grill_run_reviewer.',
			"grill_run_reviewer spawns the reviewer itself; you never launch it. If it reports gaps, fix them, then call grill_run_reviewer once more. Hard cap: 2 rounds.",
			"If no eligible reviewer exists or the run fails, the tool returns a skippedReason; continue and call grill_finish_output_phase. Do not block finishing.",
		],
		parameters: Type.Object({
			agents: Type.Array(
				Type.Object(
					{
						name: Type.String(),
						description: Type.Optional(Type.String()),
						executable: Type.Optional(Type.Boolean()),
						source: Type.Optional(Type.String()),
						runner: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
						tools: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
						mutationTools: Type.Optional(Type.Array(Type.String())),
					},
					{ additionalProperties: true },
				),
				{ maxItems: 100 },
			),
			task: Type.Optional(
				Type.String({
					description:
						"Override the extension-derived reviewer task. When omitted, the task is derived from the approved output plan and checkpoint.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<ReviewerDetails>> {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {
						rounds: runtime.state.reviewerRounds,
						phase: currentPhase(runtime.state),
					},
				};
			}
			if (!runtime.state.outputPhase) {
				return {
					content: [
						{
							type: "text",
							text: "The reviewer pass runs in the approved output phase after outputs are produced. Call grill_enter_output_selection_phase, get approval, grill_enter_output_phase, produce the outputs, then run the reviewer.",
						},
					],
					details: { phase: currentPhase(runtime.state) },
				};
			}
			if (runtime.state.subagents === false) {
				return {
					content: [
						{
							type: "text",
							text: "Subagent integration is OFF for this session. Enable with /grill subagents on.",
						},
					],
					details: {
						rounds: runtime.state.reviewerRounds,
						phase: currentPhase(runtime.state),
					},
				};
			}
			if (runtime.state.reviewerRounds >= MAX_REVIEWER_ROUNDS) {
				return {
					content: [
						{
							type: "text",
							text: `Reviewer cap reached (${MAX_REVIEWER_ROUNDS} rounds). Call grill_finish_output_phase.`,
						},
					],
					details: {
						rounds: runtime.state.reviewerRounds,
						reviewer: runtime.state.reviewer,
						phase: currentPhase(runtime.state),
					},
				};
			}

			const reviewers = eligibleAuditors(params.agents as ScoutAgent[]);
			if (!reviewers.length) {
				const view: GroundingView = {
					summary: "",
					skippedReason: "no eligible read-only reviewer discovered",
				};
				runtime.state.reviewer = { ...view, at: Date.now() };
				runtime.state.reviewerRounds += 1;
				runtime.state.lastChangeSummary =
					"Reviewer skipped: no eligible read-only reviewer";
				persist();
				updateUi;
				return {
					content: [
						{
							type: "text",
							text: "No eligible read-only reviewer found. Continue and call grill_finish_output_phase.",
						},
					],
					details: {
						reviewer: runtime.state.reviewer,
						rounds: runtime.state.reviewerRounds,
					},
				};
			}

			const task =
				params.task?.trim() ||
				deriveReviewerTask(
					runtime.state.approvedOutputPlan,
					runtime.state.checkpoint,
				);

			// Schema marker so old persisted sessions stay distinguishable.
			runtime.state.schemaVersion = STATE_SCHEMA_VERSION;
			runtime.state.reviewerRounds += 1;
			persist();

			const view = await spawnReviewer(pi, reviewers[0].name, task);
			const recorded: GroundingView = view ?? {
				summary: "",
				skippedReason: "reviewer spawn failed silently",
			};
			runtime.state.reviewer = { ...recorded, at: Date.now() };
			if (recorded.skippedReason) {
				runtime.state.checkpoint = appendCheckpointNote(
					runtime.state.checkpoint,
					`Reviewer skipped: ${recorded.skippedReason}`,
					"## Reviewer Notes",
				);
				runtime.state.lastChangeSummary = `Reviewer skipped: ${recorded.skippedReason}`;
			} else {
				runtime.state.checkpoint = appendCheckpointNote(
					runtime.state.checkpoint,
					`Reviewer round ${runtime.state.reviewerRounds}: ${recorded.summary.slice(0, 280)}`,
					"## Reviewer Notes",
				);
				runtime.state.lastChangeSummary = `Reviewer round ${runtime.state.reviewerRounds} recorded`;
			}
			persist();
			updateUi;
			return {
				content: [
					{
						type: "text",
						text: reviewerResultText(recorded),
					},
				],
				details: {
					reviewer: runtime.state.reviewer,
					rounds: runtime.state.reviewerRounds,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_run_reviewer ")) +
					theme.fg("muted", `${(args.agents ?? []).length} candidates`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const reviewer = (
				result.details as
					| { reviewer?: GroundingView & { skippedReason?: string } }
					| undefined
			)?.reviewer;
			const text = reviewer?.skippedReason
				? `⚠ reviewer skipped: ${reviewer.skippedReason}`
				: reviewer
					? "✓ reviewer recorded"
					: "Reviewer not run";
			return new Text(
				theme.fg(reviewer?.skippedReason ? "warning" : "success", text),
				0,
				0,
			);
		},
	});
}
