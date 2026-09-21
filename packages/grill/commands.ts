import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { buildDossier } from "./dossier.js";
import { initialCheckpoint, statusMarkdown } from "./prompts.js";
import type { GrillHelpers } from "./runtime.js";
import { readSubagentsDefault } from "./settings.js";
import {
	asIntent,
	asResearchMode,
	asSubagentsValue,
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
import { shouldRewriteTitle, titleFromTopic } from "./title.js";

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
		// First-class grounding: one compact dossier up front, no per-session
		// enable/disable decision. Best-effort — failure just skips the section.
		// Subagent integration defaults from settings, overridable per session.
		if (typeof partial.subagents !== "boolean") {
			partial.subagents = readSubagentsDefault(ctx);
		}
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

		// Startup feedback: the dossier (cymbal structure + git) can take a few
		// seconds on a cold cache. Show a working indicator so the quiet gap
		// doesn't look like the extension died; updateUi below restores tokens.
		ctx.ui.setStatus(
			"grill-me",
			ctx.ui.theme.fg("accent", "🔥 grill · warming up…"),
		);

		// First-class grounding: one compact dossier up front, no per-session
		// enable/disable decision. Best-effort — failure just skips the section.
		const dossier = await buildDossier(pi, ctx.cwd);
		runtime.state.dossier = dossier
			? { text: dossier, at: Date.now() }
			: undefined;
		runtime.state.lastChangeSummary = dossier
			? "Grounding dossier captured"
			: "Grounding dossier unavailable (cymbal/git)";

		// Session-title fix: rewrite generic grill-default titles so resume lists
		// are distinguishable. Custom user titles are left alone.
		if (shouldRewriteTitle(pi.getSessionName?.())) {
			pi.setSessionName?.(titleFromTopic(topic));
			runtime.state.titleSet = true;
		}

		persist();
		updateUi(ctx);

		pi.sendUserMessage(
			`Start a Grill Me session for this topic:\n\n${topic}\n\nGrounding is first-class for this session: the repo dossier below was captured automatically; use cymbal tools for spot-checks and grill_set_scouts + one read-only scout when cymbal cannot answer.\n\n${dossier ? `Repo grounding dossier (auto-captured at session start):\n\n${dossier}\n\n` : ""}Begin by updating the checkpoint if needed, seed or maintain the coverage checklist and decision branches, then call grill_set_alternatives with 2-5 concrete answer choices and ask the first focused Socratic question. Call grill_set_alternatives so an ↑/↓ + Enter picker overlay opens; it returns the user's structured answer as the tool result, which you record in the checkpoint before asking the next question. Use the single thorough grilling style. When the interview is ready to end, the mandatory hardcoded output-selection phase must be entered with grill_enter_output_selection_phase before producing outputs or stopping.`,
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
					content: `# Grill Me commands

- /grill <topic> — start a session
- /grill stop — stop the session
- /grill status — show session status
- /grill checkpoint [edit|chat] — show/edit the checkpoint (also /checkpoint)
- /grill intent auto|plan|learn|research|content|decide
- /grill output <one or more outputs> (preference only; approval still required)
- /grill research off|ask|auto
- /grill subagents on|off — toggle the first-class subagent integration (auto grounding scouts, end-of-process reviewer, write delegation)

Grill Me uses one thorough default Socratic style. Grounding is first-class: a compact repo dossier is captured automatically at session start; per-question spot-checks use cymbal tools and read-only scouts.

Subagent integration defaults from ~/.pi/agent/grill.json ({ "subagents": true|false }) or .pi/grill.json in the project; /grill subagents overrides per session. When on, the session uses installed read-only scouts for grounding, an end-of-process reviewer pass (grill_run_reviewer: checkpoint vs produced outputs vs edited files, PASS or gap list, 2-round cap), and optional write delegation in the approved output phase.

The mandatory output-selection phase still gates all output production: grill_enter_output_selection_phase → user choice → grill_enter_output_phase. State auto-persists every change; switching model mid-session is safe. Old grill sessions from previous versions are not resumed after upgrading.`,
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
				runtime.state.availableWriters = [];
				runtime.state.reviewer = undefined;
				runtime.state.reviewerRounds = 0;
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

			if (command === "subagents") {
				const value = asSubagentsValue(rest);
				if (!runtime.state.active && value === undefined) {
					ctx.ui.notify("Usage: /grill subagents on|off", "warning");
					return;
				}
				if (value === undefined) {
					ctx.ui.notify(
						`Subagent integration: ${runtime.state.subagents ? "on" : "off"}. Toggle with /grill subagents on|off.`,
						"info",
					);
					return;
				}
				runtime.state.subagents = value;
				runtime.state.lastChangeSummary = `Subagent integration ${value ? "enabled" : "disabled"}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(
					`Grill subagent integration: ${value ? "on" : "off"}.`,
					"info",
				);
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
