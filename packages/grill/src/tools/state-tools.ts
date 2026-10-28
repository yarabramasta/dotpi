import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { showPicker } from "../picker.js";
import type { GrillHelpers } from "../runtime.js";
import {
	type GrillAlternative,
	normalizeAlternatives,
	runtime,
} from "../state.js";

export function registerStateTools(
	pi: ExtensionAPI,
	helpers: GrillHelpers,
): void {
	const { persist, updateUi } = helpers;
	pi.registerTool({
		name: "grill_update_checkpoint",
		label: "Update Grill Checkpoint",
		description:
			"Replace the Grill Me shared-understanding checkpoint. Use before asking the next grill question whenever meaningful understanding changes.",
		promptSnippet:
			"Persist the evolving Grill Me shared-understanding Markdown checkpoint",
		promptGuidelines: [
			"Use grill_update_checkpoint before asking the next question whenever an active Grill Me session reaches a meaningful new decision, clarification, assumption, risk, or open question.",
		],
		parameters: Type.Object({
			markdown: Type.String({
				description: "The full replacement Markdown checkpoint.",
			}),
			changeSummary: Type.String({
				description: "Brief visible summary of what changed.",
			}),
		}),
		async execute(_toolCallId, params) {
			if (!runtime.state.active) {
				return {
					content: [
						{
							type: "text",
							text: "No active Grill Me session. Start one with /grill <topic>.",
						},
					],
					details: {
						checkpoint: runtime.state.checkpoint,
						changeSummary: "No active session",
						updatedAt: runtime.state.updatedAt,
					},
				};
			}
			runtime.state.checkpoint = params.markdown;
			runtime.state.lastChangeSummary = params.changeSummary;
			persist();
			return {
				content: [
					{
						type: "text",
						text: `Recorded checkpoint update: ${params.changeSummary}`,
					},
				],
				details: {
					checkpoint: runtime.state.checkpoint,
					changeSummary: params.changeSummary,
					updatedAt: runtime.state.updatedAt,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_update_checkpoint ")) +
					theme.fg("muted", args.changeSummary ?? ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const summary = (result.details as { changeSummary?: string } | undefined)
				?.changeSummary;
			const text = summary
				? `✓ ${summary}`
				: result.content[0]?.type === "text"
					? result.content[0].text
					: "Checkpoint updated";
			return new Text(theme.fg("success", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "grill_set_alternatives",
		label: "Set Grill Alternatives",
		description:
			"Set the visible Grill Me answer alternatives offered to the user via Tab autocomplete for the next question or readiness choice.",
		promptSnippet:
			"Present answer alternatives through the Grill Me Tab autocomplete UX",
		promptGuidelines: [
			"Before asking each grill question, call grill_set_alternatives with 2-5 concise, concrete alternatives the user can accept or edit with Tab autocomplete.",
			"Include one recommended alternative and make it clear in the label or description.",
			"Use alternatives that are useful defaults, not exhaustive menus; the user can still type a custom answer.",
		],
		parameters: Type.Object({
			question: Type.String({
				description: "The question these alternatives answer.",
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
						"2-5 suggested replies. Include a recommended/default option.",
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
					details: { alternatives: [] },
				};
			}
			runtime.state.currentQuestion = params.question;
			runtime.state.alternatives = normalizeAlternatives(
				params.alternatives as GrillAlternative[],
			);
			runtime.state.lastChangeSummary = `Set ${runtime.state.alternatives.length} picker alternatives`;
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
					runtime.state.lastChangeSummary = `Recorded answer: ${result.label}`;
					persist();
					return {
						content: [
							{
								type: "text",
								text: `Picked: ${result.label}${result.custom ? ` (custom: "${result.value}")` : ` (${result.value})`}${result.note ? `\nNote: ${result.note}` : ""}\n\nRecord this answer in the checkpoint (## Decisions) before asking the next question.`,
							},
						],
						details: {
							question: params.question,
							result,
							decisions: runtime.state.decisions,
						},
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Picker cancelled or unavailable. Ask the question in plain chat instead; the user can reply free-form. Question: ${params.question}`,
						},
					],
					details: {
						question: params.question,
						alternatives: runtime.state.alternatives,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `No interactive UI. Ask this in plain chat and let the user reply free-form:\n${params.question}\n\nAlternatives (text only): ${runtime.state.alternatives.map((a) => a.label).join(", ")}`,
					},
				],
				details: {
					question: runtime.state.currentQuestion,
					alternatives: runtime.state.alternatives,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_set_alternatives ")) +
					theme.fg("muted", args.question ?? ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const alternatives =
				(result.details as { alternatives?: GrillAlternative[] } | undefined)
					?.alternatives ?? [];
			const text = alternatives.length
				? `✓ Picker alternatives: ${alternatives.map((a) => a.label).join(" | ")}`
				: "No alternatives set";
			return new Text(
				theme.fg(alternatives.length ? "success" : "warning", text),
				0,
				0,
			);
		},
	});
}
