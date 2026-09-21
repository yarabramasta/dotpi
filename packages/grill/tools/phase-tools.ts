import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DELEGATE_OPTIONS,
	GITHUB_REPO_PERMISSION_GUIDANCE,
	OUTPUT_DESTINATION_OPTIONS,
	outputDestinationOptionNames,
	outputDestinationOptionsMarkdown,
} from "../options.js";
import { showPicker } from "../picker.js";
import type { GrillHelpers } from "../runtime.js";
import {
	approvedOutputPaths,
	currentPhase,
	type GrillAlternative,
	type GrillState,
	normalizeAlternatives,
	runtime,
} from "../state.js";

export function registerPhaseTools(
	pi: ExtensionAPI,
	helpers: GrillHelpers,
): void {
	const { persist, updateUi } = helpers;
	pi.registerTool({
		name: "grill_enter_output_selection_phase",
		label: "Enter Grill Output Selection",
		description: `Enter the mandatory hardcoded output-selection phase at the end of the Grill Me interview before stopping or producing outputs. The phase must explicitly mention available output destinations: ${outputDestinationOptionNames()}.`,
		promptSnippet: "Start the mandatory Grill Me output-selection phase",
		promptGuidelines: [
			"Use grill_enter_output_selection_phase after the final checkpoint update when the Grill Me interview is ready to end.",
			"Do not stop a Grill Me interview, claim the work is complete, or enter output production until grill_enter_output_selection_phase has been called and the user has selected what happens next.",
			`In the output-selection chat response, explicitly list these output destination options before asking for a choice: ${outputDestinationOptionNames()}.`,
		],
		parameters: Type.Object({
			readinessRationale: Type.String({
				description:
					"Why shared understanding is sufficient to leave interview mode.",
			}),
			recommendedOutputs: Type.String({
				description: `One or more recommended output destinations/formats from the explicit catalog (${outputDestinationOptionNames()}), or 'none' if no artifact is recommended.`,
			}),
			recommendedStrategy: Type.String({
				description:
					"Recommended output strategy, distinct from destination/format.",
			}),
			question: Type.String({
				description:
					"The explicit output-selection question to ask the user. It should name concrete output options rather than saying only 'outputs'.",
			}),
			alternatives: Type.Array(
				Type.Object({
					value: Type.String({
						description:
							"The exact reply inserted into the user's editor when selected.",
					}),
					label: Type.String({
						description: "Short visible label for the alternative.",
					}),
					description: Type.Optional(
						Type.String({
							description: "Brief explanation or recommendation note.",
						}),
					),
					preview: Type.Optional(
						Type.String({
							description:
								"Optional markdown preview shown when this option is focused in the picker.",
						}),
					),
				}),
				{
					description:
						"2-5 choices covering produce output(s), continue grilling, review checkpoint, or stop with no output as appropriate.",
				},
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!runtime.state.active) {
				return {
					content: [
						{
							type: "text",
							text: "No active Grill Me session. Start one with /grill <topic>.",
						},
					],
					details: { phase: currentPhase(runtime.state) },
				};
			}
			runtime.state.phase = "output-selection";
			runtime.state.outputPhase = false;
			runtime.state.outputSelection = {
				readinessRationale: params.readinessRationale,
				recommendedOutputs: params.recommendedOutputs,
				recommendedStrategy: params.recommendedStrategy,
				question: params.question,
			};
			runtime.state.approvedOutputPlan = undefined;
			runtime.state.delegate = undefined;
			runtime.state.chosenWriter = undefined;
			runtime.state.outputPaths = undefined;
			runtime.state.availableWriters = [];
			runtime.state.currentQuestion = params.question;
			runtime.state.alternatives = normalizeAlternatives(
				params.alternatives as GrillAlternative[],
			);
			runtime.state.lastChangeSummary =
				"Entered mandatory output-selection phase";
			persist();
			if (ctx) updateUi(ctx);

			if (ctx?.hasUI) {
				const result = await showPicker(
					ctx,
					params.question,
					runtime.state.alternatives,
				);
				if (result.status === "answered") {
					runtime.state.decisions = [
						...runtime.state.decisions,
						{
							question: params.question,
							value: result.value,
							label: result.label,
							custom: result.custom,
							note: result.note,
							at: Date.now(),
						},
					];
					runtime.state.lastChangeSummary = `Output selection answered: ${result.label}`;
					persist();
					return {
						content: [
							{
								type: "text",
								text: `User chose: ${result.label}${result.custom ? ` (custom: "${result.value}")` : ` (${result.value})`}${result.note ? `\nNote: ${result.note}` : ""}\n\nIn the chat response, name the concrete output options from the catalog (GitHub issues, Design doc, README.md, ADR, PRD, Implementation plan, Research brief, Summary / decision memo, Tutorial / content outline, Test plan / QA checklist, Changelog / release notes). If the user approved concrete output production, call grill_enter_output_phase; if they chose to continue or stop without output, call grill_finish_output_selection_phase.`,
							},
						],
						details: {
							phase: currentPhase(runtime.state),
							outputSelection: runtime.state.outputSelection,
							result,
							alternatives: runtime.state.alternatives,
						},
					};
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `Output-selection phase is active. In the chat response, explicitly show these output destination options:\n${outputDestinationOptionsMarkdown()}\n\nThen ask the user to choose one or more, customize the set, continue grilling, review the checkpoint, or stop without output. Alternatives: ${runtime.state.alternatives.map((a) => a.label).join(", ")}`,
					},
				],
				details: {
					phase: currentPhase(runtime.state),
					outputSelection: runtime.state.outputSelection,
					outputDestinationOptions: OUTPUT_DESTINATION_OPTIONS,
					alternatives: runtime.state.alternatives,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg(
					"toolTitle",
					theme.bold("grill_enter_output_selection_phase "),
				) + theme.fg("muted", args.question ?? ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const selection = (
				result.details as
					| { outputSelection?: GrillState["outputSelection"] }
					| undefined
			)?.outputSelection;
			const text = selection
				? `✓ Output selection: ${selection.recommendedOutputs}`
				: result.content[0]?.type === "text"
					? result.content[0].text
					: "Output selection phase updated";
			return new Text(theme.fg(selection ? "success" : "warning", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "grill_finish_output_selection_phase",
		label: "Finish Grill Output Selection",
		description:
			"Resolve the mandatory output-selection phase without entering output production, either by continuing the interview or stopping with no outputs.",
		promptSnippet:
			"Resolve Grill Me output selection without output production",
		promptGuidelines: [
			"Use grill_finish_output_selection_phase when the user responds to the mandatory output-selection phase by choosing to continue grilling or stop without producing outputs.",
			"If the user approves concrete output production, use grill_enter_output_phase instead.",
		],
		parameters: Type.Object({
			outcome: Type.String({
				description: "Either 'continue-grilling' or 'stop-without-output'.",
			}),
			summary: Type.Optional(
				Type.String({
					description: "Brief summary of the user's output-selection decision.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
					},
				};
			}
			if (currentPhase(runtime.state) !== "output-selection") {
				return {
					content: [
						{
							type: "text",
							text: "No active output-selection phase. Call grill_enter_output_selection_phase before resolving output selection.",
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
					},
				};
			}

			const outcome = String(params.outcome ?? "")
				.trim()
				.toLowerCase();
			if (
				outcome === "continue-grilling" ||
				outcome === "continue" ||
				outcome === "grill"
			) {
				runtime.state.phase = "interview";
				runtime.state.outputPhase = false;
				runtime.state.outputSelection = undefined;
				runtime.state.delegate = undefined;
				runtime.state.chosenWriter = undefined;
				runtime.state.outputPaths = undefined;
				runtime.state.availableWriters = [];
				runtime.state.currentQuestion = undefined;
				runtime.state.alternatives = [];
				runtime.state.lastChangeSummary = params.summary
					? `Output selection resolved: ${params.summary}`
					: "Output selection resolved: continue grilling";
				persist();
				if (ctx) updateUi(ctx);
				return {
					content: [
						{
							type: "text",
							text: "Returned to Grill Me interview mode. Ask the next Socratic question with grill_set_alternatives.",
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
						outcome,
					},
				};
			}

			if (
				outcome === "stop-without-output" ||
				outcome === "stop" ||
				outcome === "no-output" ||
				outcome === "none"
			) {
				runtime.state.active = false;
				runtime.state.phase = "interview";
				runtime.state.outputPhase = false;
				runtime.state.outputSelection = undefined;
				runtime.state.approvedOutputPlan = undefined;
				runtime.state.delegate = undefined;
				runtime.state.chosenWriter = undefined;
				runtime.state.outputPaths = undefined;
				runtime.state.availableWriters = [];
				runtime.state.currentQuestion = undefined;
				runtime.state.alternatives = [];
				runtime.state.lastChangeSummary = params.summary
					? `Stopped after output selection: ${params.summary}`
					: "Stopped after output selection without outputs";
				persist();
				if (ctx) updateUi(ctx);
				return {
					content: [{ type: "text", text: runtime.state.lastChangeSummary }],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
						outcome,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "Unsupported outcome. Use 'continue-grilling' or 'stop-without-output'. If outputs were approved, call grill_enter_output_phase instead.",
					},
				],
				details: {
					phase: currentPhase(runtime.state),
					active: runtime.state.active,
					outcome,
				},
			};
		},
	});

	pi.registerTool({
		name: "grill_enter_output_phase",
		label: "Enter Grill Output Phase",
		description:
			"Mark that the user approved output production after mandatory output selection, allowing the assistant to use tools required to create the approved artifacts.",
		promptSnippet: "Enter approved Grill Me output-production phase",
		promptGuidelines: [
			"Use grill_enter_output_phase only after grill_enter_output_selection_phase has run and the user explicitly approves a concrete output plan or preview during an active Grill Me session.",
			"During output phase, do not refuse approved mutating output work merely because it mutates runtime.state, such as creating GitHub issues. If a tool, CLI, platform, or pi permission/authentication gate blocks the mutation, stop and ask the user for the needed permission, confirmation, credentials, or plan change; do not bypass it or broaden scope.",
			"If write delegates were discovered via grill_set_writers, this tool asks the user (via a picker) whether to delegate approved file writes to a writer subagent or have the parent write directly. When delegating, the parent is blocked from edit/write and spawns the writer with subagent({ agent, output, task }); the writer is scoped to the approved output paths. If no write delegate exists, the picker is skipped and the parent writes directly.",
			GITHUB_REPO_PERMISSION_GUIDANCE,
		],
		parameters: Type.Object({
			outputPlan: Type.String({
				description:
					"The approved output plan, including one or more outputs/artifacts/files/issues and intended tool use.",
			}),
			delegate: Type.Optional(
				Type.Boolean({
					description:
						"If true, delegate approved file writes to a write-capable subagent (parent stays read-only for files, keeps CLI mutations). If false, parent writes directly. When omitted and write delegates were discovered via grill_set_writers, the user is asked via a picker.",
				}),
			),
			writer: Type.Optional(
				Type.String({
					description:
						"Override the canonical-first writer selection with a specific eligible writer name. Must be in runtime.state.availableWriters.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {
						phase: currentPhase(runtime.state),
						outputPhase: false,
						outputPlan: params.outputPlan,
					},
				};
			}
			if (
				currentPhase(runtime.state) !== "output-selection" &&
				!runtime.state.outputPhase
			) {
				return {
					content: [
						{
							type: "text",
							text: "Output production requires the mandatory output-selection phase first. Call grill_enter_output_selection_phase, ask the user to choose/approve outputs, then call grill_enter_output_phase.",
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						outputPhase: false,
						outputPlan: params.outputPlan,
					},
				};
			}

			// Per-batch write-delegation runtime.state. Reset, then resolve via param or
			// picker. The picker only runs when write delegates were discovered
			// (grill_set_writers in the output-selection phase); if none exist the
			// parent writes directly (current behavior).
			runtime.state.delegate = undefined;
			runtime.state.chosenWriter = undefined;

			let delegate = params.delegate;
			if (delegate === undefined && runtime.state.availableWriters.length > 0) {
				if (ctx?.hasUI) {
					const result = await showPicker(
						ctx,
						"Delegate approved file writes to a writer subagent, or have the parent write directly?",
						DELEGATE_OPTIONS,
					);
					delegate = result.status === "answered" && result.value === "yes";
				} else {
					delegate = false;
				}
			} else if (delegate === undefined) {
				delegate = false;
			}
			runtime.state.delegate = delegate;
			if (delegate) {
				const requested = params.writer?.trim();
				const writer = requested
					? runtime.state.availableWriters.find((w) => w.name === requested)
					: runtime.state.availableWriters[0];
				runtime.state.chosenWriter = writer?.name;
			}

			runtime.state.phase = "output";
			runtime.state.outputPhase = true;
			runtime.state.approvedOutputPlan = params.outputPlan;
			runtime.state.outputPaths = approvedOutputPaths(params.outputPlan);
			runtime.state.auditing = false;
			runtime.state.auditTask = undefined;
			runtime.state.availableAuditors = [];
			runtime.state.outputAudit = undefined;
			runtime.state.lastChangeSummary = runtime.state.delegate
				? `Entered approved output phase (delegating file writes to ${runtime.state.chosenWriter ?? "?"})`
				: "Entered approved output phase (parent writes directly)";
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Output phase enabled for approved plan:\n${params.outputPlan}\n\n${runtime.state.delegate ? `File writes delegated to ${runtime.state.chosenWriter ?? "the chosen writer"}; the parent keeps CLI mutations (gh/git) and spawns the writer with subagent({ agent, output, task }). ${GITHUB_REPO_PERMISSION_GUIDANCE}` : `Parent writes the approved outputs directly. ${GITHUB_REPO_PERMISSION_GUIDANCE}`}`,
					},
				],
				details: {
					phase: currentPhase(runtime.state),
					outputPhase: true,
					outputPlan: params.outputPlan,
					delegate: runtime.state.delegate,
					chosenWriter: runtime.state.chosenWriter,
					availableWriters: runtime.state.availableWriters,
				},
			};
		},
	});

	pi.registerTool({
		name: "grill_finish_output_phase",
		label: "Finish Grill Output Phase",
		description:
			"Return an active Grill Me session to read-only interview/planning enforcement after output production.",
		promptSnippet:
			"Return Grill Me to read-only interview mode after output production",
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({ description: "Brief summary of outputs created." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			runtime.state.phase = "interview";
			runtime.state.outputPhase = false;
			runtime.state.outputSelection = undefined;
			runtime.state.approvedOutputPlan = undefined;
			runtime.state.auditing = false;
			runtime.state.auditTask = undefined;
			runtime.state.availableAuditors = [];
			runtime.state.outputAudit = undefined;
			runtime.state.delegate = undefined;
			runtime.state.chosenWriter = undefined;
			runtime.state.outputPaths = undefined;
			runtime.state.availableWriters = [];
			runtime.state.lastChangeSummary = params.summary
				? `Finished output phase: ${params.summary}`
				: "Finished output phase";
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [{ type: "text", text: runtime.state.lastChangeSummary }],
				details: {
					phase: currentPhase(runtime.state),
					outputPhase: false,
					summary: params.summary,
				},
			};
		},
	});
}
