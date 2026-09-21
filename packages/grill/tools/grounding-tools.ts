import type {
	AgentToolResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	eligibleAuditors,
	eligibleScouts,
	eligibleWriters,
	type GroundingView,
	type ScoutAgent,
} from "../grounding.js";
import {
	appendCheckpointNote,
	deriveAuditTask,
	groundingResultText,
	outputAuditResultText,
} from "../prompts.js";
import type { GrillHelpers } from "../runtime.js";
import {
	type AuditorsDetails,
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
			if (runtime.state.assistEnabled !== true) {
				return {
					content: [
						{
							type: "text",
							text: "Grounding assist is disabled for this session.",
						},
					],
					details: { scouts: [], assistEnabled: runtime.state.assistEnabled },
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
				details: { scouts, assistEnabled: runtime.state.assistEnabled },
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
			if (runtime.state.assistEnabled !== true) {
				return {
					content: [
						{
							type: "text",
							text: "Grounding assist is disabled for this session.",
						},
					],
					details: { assistEnabled: runtime.state.assistEnabled },
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
			'Filter the live subagent capability list to executable write-capable agents for delegating approved-output file writes. Call after subagent({ action: "list", capabilities: true }).',
		promptSnippet:
			"Filter installed subagents to write-capable output delegates",
		promptGuidelines: [
			'When the user chooses to delegate output writes, call subagent({ action: "list", capabilities: true }) once, then pass its live agent capability rows to grill_set_writers.',
			"grill_set_writers returns write-capable agents (canonical-first): mutating tools, external CLI/job runner, or writer-named. Use the first as the delegate.",
			"Spawn the delegate with subagent({ agent, output, task }) where `output` is an approved output path and `task` is the approved output plan; the extension blocks writer spawns whose `output` is outside the approved plan.",
			"If no write-capable agent exists, the delegate picker is skipped and the parent writes directly.",
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
			const writers = eligibleWriters(params.agents as ScoutAgent[]);
			runtime.state.availableWriters = writers;
			runtime.state.lastChangeSummary = writers.length
				? `Discovered ${writers.length} eligible write delegate${writers.length === 1 ? "" : "s"}`
				: "No eligible write delegate discovered; parent writes directly";
			persist();
			return {
				content: [
					{
						type: "text",
						text: writers.length
							? `Eligible write delegates (canonical-first): ${writers.map((w) => w.name).join(", ")}. Use the first with subagent({ agent, output, task }) where output is an approved output path; the extension blocks writer spawns whose output is outside the approved plan. The parent keeps CLI mutations (gh/git).`
							: "No eligible write delegate found. The parent writes directly (current behavior).",
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

	pi.registerTool({
		name: "grill_set_auditors",
		label: "Set Grill Output Auditors",
		description:
			'Filter the live subagent capability list to executable read-only audit/review agents for an advisory output audit. Call after subagent({ action: "list", capabilities: true }) during the approved output phase, before producing/after-producing the audit run.',
		promptSnippet:
			"Filter installed subagents to safe read-only output auditors and derive the audit task",
		promptGuidelines: [
			'When output audit is enabled (grounding assist on) and the output phase is active, after producing/applying the approved output call subagent({ action: "list", capabilities: true }) once, then pass its live capability rows to grill_set_auditors.',
			"grill_set_auditors derives a read-only audit task from the approved output plan (docs verify claims vs codebase; code edits review the diff; mixed both). Provide `task` to override the derived task.",
			"Then run ONE eligible auditor with subagent({ agent, task }) and record the result with grill_show_output_audit. The audit is advisory; it never blocks grill_finish_output_phase.",
			"Use only the returned eligible auditors; never guess or hardcode an unavailable agent. If none qualify, call grill_show_output_audit with skippedReason and skip the audit.",
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
						"Override the extension-derived audit task. When omitted, the task is derived from the approved output plan (docs verify claims vs codebase; code edits review the diff; mixed both).",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<AuditorsDetails>> {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: { auditors: [] },
				};
			}
			if (runtime.state.assistEnabled !== true) {
				return {
					content: [
						{
							type: "text",
							text: "Grounding assist is disabled for this session; output audit is not available.",
						},
					],
					details: { auditors: [], assistEnabled: runtime.state.assistEnabled },
				};
			}
			if (!runtime.state.outputPhase) {
				return {
					content: [
						{
							type: "text",
							text: "Output audit is only available in the approved output phase. Call grill_enter_output_selection_phase, get output approval, then grill_enter_output_phase first.",
						},
					],
					details: { auditors: [], phase: currentPhase(runtime.state) },
				};
			}
			const auditors = eligibleAuditors(params.agents as ScoutAgent[]);
			runtime.state.availableAuditors = auditors;
			runtime.state.auditing = auditors.length > 0;
			const derivedTask = params.task?.trim()
				? params.task.trim()
				: deriveAuditTask(runtime.state.approvedOutputPlan);
			runtime.state.auditTask = derivedTask || undefined;
			runtime.state.lastChangeSummary = auditors.length
				? `Discovered ${auditors.length} eligible output auditor${auditors.length === 1 ? "" : "s"}${params.task?.trim() ? " (task overridden)" : ""}`
				: "No eligible read-only output auditor discovered; audit skipped";
			persist();
			return {
				content: [
					{
						type: "text",
						text: auditors.length
							? `Eligible read-only output auditors (canonical-first): ${auditors.map((a) => a.name).join(", ")}. Audit task: ${runtime.state.auditTask ?? "(none)"}. Run ONE auditor with subagent({ agent, task }), then record the result with grill_show_output_audit. While auditing, only subagent spawns targeting these auditors are allowed; other subagent calls are blocked until the audit is recorded.`
							: "No eligible read-only output auditor found. Call grill_show_output_audit with a skippedReason and skip the audit.",
					},
				],
				details: {
					auditors,
					assistEnabled: runtime.state.assistEnabled,
					auditTask: runtime.state.auditTask,
					auditing: runtime.state.auditing,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_set_auditors ")) +
					theme.fg("muted", `${(args.agents ?? []).length} candidates`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const auditors =
				(result.details as { auditors?: ScoutAgent[] } | undefined)?.auditors ??
				[];
			return new Text(
				theme.fg(
					auditors.length ? "success" : "warning",
					auditors.length
						? `✓ Eligible auditors: ${auditors.map((a) => a.name).join(", ")}`
						: "No eligible output auditors",
				),
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "grill_show_output_audit",
		label: "Show Grill Output Audit",
		description:
			"Record a concise read-only auditor result for the produced output before grill_finish_output_phase. Use skippedReason when no eligible auditor exists or the audit run failed; the audit is advisory and never blocks finishing.",
		promptSnippet:
			"Record the output-audit result before finishing the output phase",
		promptGuidelines: [
			"After running one eligible auditor (or failing to), call grill_show_output_audit to record the result. This clears the audit window so production subagents are unblocked again.",
			"If no eligible auditor was found or the run failed, pass skippedReason; continue and call grill_finish_output_phase. Do not block finishing.",
			"If the auditor found gaps, revise the output and re-audit, or call grill_finish_output_phase. The audit is advisory; the user decides.",
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
			if (runtime.state.assistEnabled !== true) {
				return {
					content: [
						{
							type: "text",
							text: "Grounding assist is disabled for this session; output audit is not available.",
						},
					],
					details: { assistEnabled: runtime.state.assistEnabled },
				};
			}
			const view: GroundingView = {
				summary: params.summary.trim(),
				source: params.source?.trim() || undefined,
				confidence: params.confidence?.trim() || undefined,
				skippedReason: params.skippedReason?.trim() || undefined,
			};
			runtime.state.outputAudit = { ...view, at: Date.now() };
			runtime.state.auditing = false;
			if (view.skippedReason) {
				runtime.state.checkpoint = appendCheckpointNote(
					runtime.state.checkpoint,
					`Output audit skipped: ${view.skippedReason}`,
					"## Output Audit Notes",
				);
				runtime.state.lastChangeSummary = `Output audit skipped: ${view.skippedReason}`;
			} else {
				runtime.state.checkpoint = appendCheckpointNote(
					runtime.state.checkpoint,
					`Output audit recorded${view.source ? ` from ${view.source}` : ""}: ${view.summary.slice(0, 280)}`,
					"## Output Audit Notes",
				);
				runtime.state.lastChangeSummary = `Output audit recorded${view.source ? ` from ${view.source}` : ""}`;
			}
			persist();
			updateUi(ctx);
			if (view.skippedReason)
				ctx.ui.notify(`Output audit skipped: ${view.skippedReason}`, "warning");
			return {
				content: [{ type: "text", text: outputAuditResultText(view) }],
				details: { outputAudit: runtime.state.outputAudit },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_show_output_audit ")) +
					theme.fg("muted", args.source ?? "output audit"),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text =
				result.content[0]?.type === "text"
					? result.content[0].text
					: "Output audit recorded";
			return new Text(theme.fg("success", text), 0, 0);
		},
	});
}
