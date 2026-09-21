import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { ASSIST_OPTIONS } from "./options.js";
import { showPicker } from "./picker.js";
import { initialCheckpoint, statusMarkdown } from "./prompts.js";
import type { GrillHelpers } from "./runtime.js";
import {
	asIntent,
	asResearchMode,
	cloneState,
	DEFAULT_STATE,
	firstWord,
	type GrillState,
	INTENTS,
	inferTopic,
	parseArgs,
	RESEARCH_MODES,
	runtime,
} from "./state.js";

export function registerCommands(
	pi: ExtensionAPI,
	helpers: GrillHelpers,
): void {
	const { persist, updateUi } = helpers;
	async function startSession(
		topic: string,
		ctx: ExtensionContext,
		partial: Partial<GrillState> = {},
	): Promise<void> {
		runtime.state = {
			...cloneState(DEFAULT_STATE),
			...partial,
			active: true,
			topic,
			phase: "interview",
			outputPhase: false,
			outputSelection: undefined,
			approvedOutputPlan: undefined,
		};
		runtime.state.checkpoint = initialCheckpoint(topic, runtime.state);
		runtime.state.lastChangeSummary = "Started grill session";
		persist();
		updateUi(ctx);

		if (ctx.hasUI) {
			const result = await showPicker(
				ctx,
				"Use installed read-only subagents to ground this Grill Me session?",
				ASSIST_OPTIONS,
			);
			runtime.state.assistEnabled =
				result.status === "answered" && result.value === "yes";
		} else {
			runtime.state.assistEnabled = false;
		}
		runtime.state.lastChangeSummary = runtime.state.assistEnabled
			? "Grounding assist enabled for this session"
			: "Grounding assist disabled for this session";
		persist();
		updateUi(ctx);

		pi.sendUserMessage(
			`Start a Grill Me session for this topic:\n\n${topic}\n\nGrounding assist is ${runtime.state.assistEnabled ? "enabled" : "disabled"} for this session. Begin by updating the checkpoint if needed, seed or maintain the coverage checklist and decision branches, then call grill_set_alternatives with 2-5 concrete answer choices and ask the first focused Socratic question. Call grill_set_alternatives so an ↑/↓ + Enter picker overlay opens; it returns the user's structured answer as the tool result, which you record in the checkpoint before asking the next question. Use the single thorough grilling style. When the interview is ready to end, the mandatory hardcoded output-selection phase must be entered with grill_enter_output_selection_phase before producing outputs or stopping.`,
		);
	}

	async function showCheckpointOverlay(
		ctx: ExtensionContext,
	): Promise<"edit" | undefined> {
		if (!ctx.hasUI) {
			pi.sendMessage({
				customType: "grill-me-checkpoint",
				content: runtime.state.checkpoint,
				display: true,
			});
			return undefined;
		}

		return await ctx.ui.custom<"edit" | undefined>(
			(tui, theme, _keybindings, done) => {
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const markdown = new Markdown(
					runtime.state.checkpoint,
					1,
					0,
					getMarkdownTheme(),
				);
				let scrollOffset = 0;
				let cachedWidth = 0;
				let cachedBody: string[] = [];
				const maxBodyLines = 16;

				function bodyLines(width: number): string[] {
					if (cachedWidth !== width || cachedBody.length === 0) {
						cachedWidth = width;
						cachedBody = markdown.render(width);
					}
					return cachedBody;
				}

				function maxOffset(): number {
					return Math.max(0, cachedBody.length - maxBodyLines);
				}

				function move(delta: number): void {
					scrollOffset = Math.max(
						0,
						Math.min(maxOffset(), scrollOffset + delta),
					);
					tui.requestRender();
				}

				return {
					render(width: number) {
						const body = bodyLines(width);
						scrollOffset = Math.min(scrollOffset, maxOffset());
						const visible = body.slice(
							scrollOffset,
							scrollOffset + maxBodyLines,
						);
						const range =
							body.length > maxBodyLines
								? `lines ${scrollOffset + 1}-${Math.min(scrollOffset + maxBodyLines, body.length)} of ${body.length}`
								: "full checkpoint";
						return [
							...border.render(width),
							truncateToWidth(
								theme.fg("accent", theme.bold("🔥 Grill Me Checkpoint")),
								width,
							),
							truncateToWidth(
								theme.fg(
									"dim",
									`${range} • ↑↓/PgUp/PgDn scroll • e edit • Enter/Esc close`,
								),
								width,
							),
							...visible.map((line) => truncateToWidth(line, width, "")),
							...border.render(width),
						];
					},
					invalidate() {
						border.invalidate();
						markdown.invalidate();
						cachedWidth = 0;
						cachedBody = [];
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "enter"))
							done(undefined);
						else if (matchesKey(data, "e")) done("edit");
						else if (matchesKey(data, "up")) move(-1);
						else if (matchesKey(data, "down")) move(1);
						else if (matchesKey(data, "pageUp")) move(-maxBodyLines);
						else if (matchesKey(data, "pageDown")) move(maxBodyLines);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "80%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);
	}

	async function showCheckpoint(
		ctx: ExtensionContext,
		mode?: string,
	): Promise<void> {
		if (!runtime.state.checkpoint.trim()) {
			ctx.ui.notify("No grill checkpoint yet.", "warning");
			return;
		}

		const selected = mode?.trim().toLowerCase() || "overlay";
		if (selected.includes("edit")) {
			const edited = await ctx.ui.editor(
				"Edit Grill Me checkpoint",
				runtime.state.checkpoint,
			);
			if (edited !== undefined) {
				runtime.state.checkpoint = edited.trim() || runtime.state.checkpoint;
				runtime.state.lastChangeSummary = "Checkpoint edited by user";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill checkpoint updated.", "info");
			}
			return;
		}

		if (selected.includes("chat")) {
			pi.sendMessage({
				customType: "grill-me-checkpoint",
				content: runtime.state.checkpoint,
				display: true,
			});
			return;
		}

		const action = await showCheckpointOverlay(ctx);
		if (action === "edit") {
			await showCheckpoint(ctx, "edit");
		}
	}

	pi.registerCommand("checkpoint", {
		description: "Show the current Grill Me checkpoint in an overlay",
		handler: async (args, ctx) => {
			await showCheckpoint(ctx, args.trim());
		},
	});

	pi.registerCommand("grill", {
		description: "Start or control a Socratic Grill Me planning session",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const command = firstWord(trimmed);
			const rest = trimmed.slice(command.length).trim();

			if (command === "help") {
				pi.sendMessage({
					customType: "grill-me-help",
					content: `# Grill Me commands\n\n- /grill <topic>\n- /grill stop\n- /checkpoint [edit|chat]\n- /grill checkpoint [edit|chat]\n- /grill status\n- /grill intent auto|plan|learn|research|content|decide\n- /grill output <one or more outputs> (preference only; approval still required)\n- /grill research off|ask|auto\n\nGrill Me uses one thorough default Socratic style. The assistant must use the hardcoded output-selection phase before ending the interview, producing outputs, or stopping without outputs.\n\nWhen grounding assist is enabled, the session start picker also enables an advisory output audit: in the output phase, after producing/applying the approved output, the assistant runs one read-only auditor (grill_set_auditors → subagent → grill_show_output_audit). The audit is advisory and never blocks grill_finish_output_phase; it can be skipped if no eligible auditor exists.\n\nIn the output-selection phase, the assistant may discover write-capable subagents with grill_set_writers; if any exist, grill_enter_output_phase asks (via a picker) whether to delegate approved file writes to a writer subagent or have the parent write directly. When delegating, the parent is blocked from edit/write (keeps CLI mutations like gh/git), the writer subagent performs file writes scoped to the approved output paths, then the advisory audit runs. Delegation is per output batch; there is no persistent toggle.\n\nState (checkpoint, phase, alternatives, current question) auto-persists every change. Switching model mid-session is safe. Reloading pi into the same session resumes the grill automatically — the status chip returns and the next turn re-injects the prompt and checkpoint.`,
					display: true,
				});
				return;
			}

			if (command === "stop") {
				runtime.state.active = false;
				runtime.state.phase = "interview";
				runtime.state.outputPhase = false;
				runtime.state.outputSelection = undefined;
				runtime.state.approvedOutputPlan = undefined;
				runtime.state.currentQuestion = undefined;
				runtime.state.alternatives = [];
				runtime.state.auditing = false;
				runtime.state.auditTask = undefined;
				runtime.state.availableAuditors = [];
				runtime.state.outputAudit = undefined;
				runtime.state.availableWriters = [];
				runtime.state.delegate = undefined;
				runtime.state.chosenWriter = undefined;
				runtime.state.outputPaths = undefined;
				runtime.state.lastChangeSummary = "Stopped grill session";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill mode stopped.", "info");
				return;
			}

			if (command === "status") {
				pi.sendMessage({
					customType: "grill-me-status",
					content: statusMarkdown(runtime.state),
					display: true,
				});
				return;
			}

			if (command === "checkpoint") {
				await showCheckpoint(ctx, rest);
				return;
			}

			if (command === "intent") {
				const value = asIntent(rest);
				if (!value) {
					ctx.ui.notify(`Usage: /grill intent ${INTENTS.join("|")}`, "warning");
					return;
				}
				runtime.state.intent = value;
				runtime.state.lastChangeSummary = `Intent set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill intent: ${value}`, "info");
				return;
			}

			if (command === "output") {
				if (!rest) {
					ctx.ui.notify(
						"Usage: /grill output <one or more outputs, e.g. design-doc,issues>",
						"warning",
					);
					return;
				}
				runtime.state.outputPreference = rest;
				runtime.state.lastChangeSummary = `Output preference set to ${rest}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(
					`Grill output preference: ${rest}. This is not approval; Grill Me will still ask/confirm before producing outputs.`,
					"info",
				);
				return;
			}

			if (command === "research") {
				const value = asResearchMode(rest);
				if (!value) {
					ctx.ui.notify(
						`Usage: /grill research ${RESEARCH_MODES.join("|")}`,
						"warning",
					);
					return;
				}
				runtime.state.researchMode = value;
				runtime.state.lastChangeSummary = `Research mode set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill research mode: ${value}`, "info");
				return;
			}

			const parsed = parseArgs(trimmed);
			const partial: Partial<GrillState> = {};
			const intent = asIntent(parsed.flags.intent);
			const researchMode = asResearchMode(parsed.flags.research);
			if (intent) partial.intent = intent;
			if (researchMode) partial.researchMode = researchMode;
			if (typeof parsed.flags.output === "string")
				partial.outputPreference = parsed.flags.output;

			let topic = parsed.rest;
			if (!topic) {
				const inferred = inferTopic(ctx);
				if (ctx.hasUI) {
					const edited = await ctx.ui.editor(
						"What should I grill you about?",
						inferred || "",
					);
					if (!edited?.trim()) {
						ctx.ui.notify("Cancelled grill start.", "info");
						return;
					}
					topic = edited.trim();
				} else {
					topic = inferred || "Current conversation";
				}
			}

			await startSession(topic, ctx, partial);
		},
	});
}
