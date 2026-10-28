import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	eligibleScouts,
	eligibleWriters,
	type GroundingView,
	type ScoutAgent,
} from "../grounding.js";
import { appendCheckpointNote, groundingResultText } from "../prompts.js";
import type { GrillHelpers } from "../runtime.js";
import {
	currentPhase,
	runtime,
	type ScoutsDetails,
	type WritersDetails,
} from "../state.js";

export function registerGroundingTools(
	pi: ExtensionAPI,
	helpers: GrillHelpers,
): void {
	const { persist, updateUi } = helpers;
	pi.registerTool({
		name: "grill_set_scouts",
		label: "Set Grill Scout Candidates",
		description:
			'Filter the live subagent capability list to executable read-only recon agents for Grill Me grounding. Call after subagent({ action: "list", capabilities: true }).',
		promptSnippet:
			"Filter installed subagents to safe read-only grounding scouts",
		promptGuidelines: [
			'When grounding assist is enabled, call subagent({ action: "list", capabilities: true }) once, then pass its live agent capability rows to grill_set_scouts.',
			"Use only the returned eligible scouts for a one-shot read-only grounding run; never guess or hardcode an unavailable agent.",
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
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<ScoutsDetails>> {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: { scouts: [] },
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
					details: { scouts: [] },
				};
			}
			const scouts = eligibleScouts(params.agents as ScoutAgent[]);
			runtime.state.availableScouts = scouts;
			runtime.state.lastChangeSummary = scouts.length
				? `Discovered ${scouts.length} eligible grounding scout${scouts.length === 1 ? "" : "s"}`
				: "No eligible read-only grounding scout discovered";
			persist();
			return {
				content: [
					{
						type: "text",
						text: scouts.length
							? `Eligible read-only scouts (canonical-first): ${scouts.map((scout) => scout.name).join(", ")}. Use one for grounding only if cymbal cannot answer.`
							: "No eligible read-only grounding scout found. Continue without subagent grounding.",
					},
				],
				details: { scouts },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_set_scouts ")) +
					theme.fg("muted", `${(args.agents ?? []).length} candidates`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const scouts =
				(result.details as { scouts?: ScoutAgent[] } | undefined)?.scouts ?? [];
			return new Text(
				theme.fg(
					scouts.length ? "success" : "warning",
					scouts.length
						? `✓ Eligible scouts: ${scouts.map((scout) => scout.name).join(", ")}`
						: "No eligible grounding scouts",
				),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "grill_show_grounding",
		label: "Show Grill Grounding",
		description:
			"Record a concise cymbal or read-only scout grounding summary in the Grill status row before the next question. Use skippedReason when grounding fails; the interview must continue ungrounded.",
		promptSnippet:
			"Show or record grounding evidence before the next grill question",
		promptGuidelines: [
			"After cymbal or scout grounding, call grill_show_grounding with a concise evidence summary before asking the next question.",
			"If grounding fails, call grill_show_grounding with skippedReason; continue with an ungrounded question and do not block the interview.",
		],
		parameters: Type.Object({
			summary: Type.String({ maxLength: 12000 }),
			source: Type.Optional(Type.String({ maxLength: 200 })),
			confidence: Type.Optional(Type.String({ maxLength: 120 })),
			skippedReason: Type.Optional(Type.String({ maxLength: 500 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {},
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
					details: {},
				};
			}
			const view: GroundingView = {
				summary: params.summary.trim(),
				source: params.source?.trim() || undefined,
				confidence: params.confidence?.trim() || undefined,
				skippedReason: params.skippedReason?.trim() || undefined,
			};
			runtime.state.grounding = { ...view, at: Date.now() };
			if (view.skippedReason) {
				runtime.state.checkpoint = appendCheckpointNote(
					runtime.state.checkpoint,
					`Grounding skipped: ${view.skippedReason}`,
				);
				runtime.state.lastChangeSummary = `Grounding skipped: ${view.skippedReason}`;
			} else {
				runtime.state.lastChangeSummary = `Grounding summary recorded${view.source ? ` from ${view.source}` : ""}`;
			}
			persist();
			updateUi(ctx);
			if (view.skippedReason)
				ctx.ui.notify(`Grounding skipped: ${view.skippedReason}`, "warning");
			return {
				content: [{ type: "text", text: groundingResultText(view) }],
				details: { grounding: runtime.state.grounding },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_show_grounding ")) +
					theme.fg("muted", args.source ?? "grounding"),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text =
				result.content[0]?.type === "text"
					? result.content[0].text
					: "Grounding recorded";
			return new Text(theme.fg("success", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "grill_set_writers",
		label: "Set Grill Write Delegates",
		description:
			'Filter the live subagent capability list to write-capable output delegates. Call after subagent({ action: "list", capabilities: true }). Passing zero eligible rows disables delegation for the session and the parent writes directly.',
		promptSnippet:
			"Filter installed subagents to write-capable output delegates",
		promptGuidelines: [
			'When the user chooses to delegate output writes, call subagent({ action: "list", capabilities: true }) once, then pass its live agent capability rows to grill_set_writers.',
			"grill_set_writers returns write-capable agents (canonical-first): mutating tools, external CLI/job runner, or writer-named. Use the first as the delegate.",
			"Spawn the delegate with subagent({ agent, output, task }) where `output` is an approved output path and `task` is the approved output plan; the extension blocks writer spawns whose `output` is outside the approved plan.",
			"If no eligible writer is discovered, grill_set_writers marks writers unavailable and delegation is skipped this session — parent writes directly. Call it again with eligible rows to re-enable the delegate picker.",
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
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<WritersDetails>> {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: { writers: [] },
				};
			}
			if (runtime.state.subagents === false) {
				return {
					content: [
						{
							type: "text",
							text: "Subagent integration is OFF for this session. The parent writes outputs directly. Enable with /grill subagents on.",
						},
					],
					details: { writers: [] },
				};
			}
			const writers = eligibleWriters(params.agents as ScoutAgent[]);
			runtime.state.availableWriters = writers;
			runtime.state.writersUnavailable = writers.length === 0;
			runtime.state.lastChangeSummary = writers.length
				? `Discovered ${writers.length} eligible write delegate${writers.length === 1 ? "" : "s"}`
				: "No eligible write delegate discovered; parent writes directly this session (pass rows later to re-enable delegation)";
			persist();
			return {
				content: [
					{
						type: "text",
						text: writers.length
							? `Eligible write delegates (canonical-first): ${writers.map((w) => w.name).join(", ")}. Use the first with subagent({ agent, output, task }) where output is an approved output path; the extension blocks writer spawns whose output is outside the approved plan. The parent keeps CLI mutations (gh/git).`
							: "No eligible write-capable subagents discovered. Delegation will be skipped: parent writes directly. Pass writer rows later to re-enable the delegate picker.",
					},
				],
				details: { writers, phase: currentPhase(runtime.state) },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_set_writers ")) +
					theme.fg("muted", `${(args.agents ?? []).length} candidates`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const writers =
				(result.details as { writers?: ScoutAgent[] } | undefined)?.writers ??
				[];
			return new Text(
				theme.fg(
					writers.length ? "success" : "warning",
					writers.length
						? `✓ Eligible write delegates: ${writers.map((w) => w.name).join(", ")}`
						: "No eligible write delegates",
				),
				0,
				0,
			);
		},
	});
}
