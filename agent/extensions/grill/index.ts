import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { showPicker } from "./picker.js";
import {
	eligibleScouts,
	type GroundingView,
	type ScoutAgent,
} from "./grounding.js";
import type { Language } from "./locales.js";

type Intent = "auto" | "plan" | "learn" | "research" | "content" | "decide";
type ResearchMode = "off" | "ask" | "auto";
type GrillPhase = "interview" | "output-selection" | "output";

interface GrillAlternative {
	value: string;
	label: string;
	description?: string;
	preview?: string;
}

interface GrillDecision {
	question: string;
	value: string;
	label: string;
	custom: boolean;
	note?: string;
	at: number;
}

interface GrillState {
	active: boolean;
	topic: string;
	intent: Intent;
	outputPreference: string;
	researchMode: ResearchMode;
	checkpoint: string;
	phase: GrillPhase;
	outputPhase: boolean;
	language: Language;
	decisions: GrillDecision[];
	assistEnabled?: boolean;
	availableScouts: ScoutAgent[];
	grounding?: GroundingView & { at: number };
	outputSelection?: {
		readinessRationale: string;
		recommendedOutputs: string;
		recommendedStrategy: string;
		question: string;
	};
	approvedOutputPlan?: string;
	alternatives: GrillAlternative[];
	currentQuestion?: string;
	updatedAt: number;
	lastChangeSummary?: string;
}

const STATE_ENTRY_TYPE = "grill-me-state";
const LEGACY_DEFAULT_OUTPUT_PREFERENCE =
	"design-doc by default; adapt/recommend near readiness";

const DEFAULT_STATE: GrillState = {
	active: false,
	topic: "",
	intent: "auto",
	outputPreference: "",
	researchMode: "auto",
	checkpoint: "",
	phase: "interview",
	outputPhase: false,
	outputSelection: undefined,
	approvedOutputPlan: undefined,
	alternatives: [],
	language: "en",
	decisions: [],
	assistEnabled: undefined,
	availableScouts: [],
	grounding: undefined,
	currentQuestion: undefined,
	updatedAt: Date.now(),
};

const INTENTS = [
	"auto",
	"plan",
	"learn",
	"research",
	"content",
	"decide",
] as const;
const RESEARCH_MODES = ["off", "ask", "auto"] as const;

const ASSIST_OPTIONS = [
	{
		value: "yes",
		label: "Enable grounding assist (Recommended)",
		description:
			"Use cymbal first, then an installed read-only scout when needed.",
	},
	{
		value: "no",
		label: "Continue without subagents",
		description: "Keep this Grill Me session local and lightweight.",
	},
];

const OUTPUT_DESTINATION_OPTIONS = [
	{
		label: "GitHub issues",
		value: "github-issues",
		description:
			"Issue titles/bodies/labels for implementation slices, research tasks, tutorial chapters, or milestones.",
	},
	{
		label: "Design doc",
		value: "design-doc",
		description:
			"A structured design proposal with goals, constraints, architecture, tradeoffs, risks, and rollout.",
	},
	{
		label: "README.md",
		value: "readme",
		description:
			"A README or README update covering setup, usage, behavior, examples, and caveats.",
	},
	{
		label: "ADR",
		value: "adr",
		description:
			"Architecture Decision Record(s) documenting decision context, options, choice, and consequences.",
	},
	{
		label: "PRD",
		value: "prd",
		description:
			"Product requirements, user stories, scope, acceptance criteria, and non-goals.",
	},
	{
		label: "Implementation plan",
		value: "implementation-plan",
		description:
			"Step-by-step engineering plan, milestones, sequencing, dependencies, and validation.",
	},
	{
		label: "Research brief",
		value: "research-brief",
		description:
			"Open questions, investigation plan, evidence to gather, and decision criteria.",
	},
	{
		label: "Summary / decision memo",
		value: "summary",
		description:
			"Concise summary of the checkpoint, decisions, assumptions, and next actions.",
	},
	{
		label: "Tutorial / content outline",
		value: "content-outline",
		description:
			"Chapters, lesson flow, examples, exercises, or publishing outline.",
	},
	{
		label: "Test plan / QA checklist",
		value: "test-plan",
		description:
			"Acceptance tests, manual QA steps, edge cases, and regression coverage.",
	},
	{
		label: "Changelog / release notes",
		value: "release-notes",
		description:
			"User-facing change summary, migration notes, and release caveats.",
	},
] as const;

const GITHUB_REPO_PERMISSION_GUIDANCE =
	"If approved GitHub issue output has no repo/remote, ask to initialize, create, or select one before creating the previewed issues; use drafts only if the user chooses.";

function cloneState(state: GrillState): GrillState {
	return { ...state };
}

function describeOutputPreference(state: GrillState): string {
	const preference =
		typeof state.outputPreference === "string"
			? state.outputPreference.trim()
			: "";
	return (
		preference ||
		"(none set; explicitly ask for one or more outputs before production)"
	);
}

function outputDestinationOptionsMarkdown(): string {
	return OUTPUT_DESTINATION_OPTIONS.map(
		(option) => `- ${option.label} (${option.value}): ${option.description}`,
	).join("\n");
}

function outputDestinationOptionNames(): string {
	return OUTPUT_DESTINATION_OPTIONS.map((option) => option.label).join(", ");
}

function currentPhase(state: GrillState): GrillPhase {
	if (state.outputPhase) return "output";
	return state.phase ?? "interview";
}

function phaseLabel(state: GrillState): string {
	const phase = currentPhase(state);
	if (phase === "output") return "output production; approved mutations allowed";
	if (phase === "output-selection")
		return "mandatory output selection; choose final outputs/continue/stop";
	return "interview; read-only enforcement active";
}

function initialCheckpoint(topic: string, state: GrillState): string {
	return `# Shared Understanding

## Topic

${topic}

## Current Understanding

We are starting a grill-me session to reach shared understanding before producing outputs or implementation work.

## Working Configuration

- Intent: ${state.intent}
- Grilling style: thorough Socratic interview
- Research mode: ${state.researchMode}
- Grounding assist: ${state.assistEnabled === undefined ? "unanswered" : state.assistEnabled ? "enabled" : "disabled"}
- Eligible grounding scouts: ${state.availableScouts.length ? state.availableScouts.map((scout) => scout.name).join(", ") : "none discovered"}
- Output preference: ${describeOutputPreference(state)}

## Decisions

- Grill mode uses a single thorough default style.
- Grill mode should adapt to the subject rather than force hardcoded interview phases.
- A hardcoded output-selection phase is mandatory at the end of the interview before output production or stopping.
- Grill mode must not assume a default output. The assistant must explicitly ask which output(s) to produce.

## Assumptions

- The checkpoint should evolve as meaningful understanding changes.
- The assistant should ask enough follow-up questions to resolve the decision tree instead of rushing to readiness.

## Risks / Unknowns

- The user's desired outcome mode and output set may still be ambiguous.
- Some branches may need to be explicitly deferred if they are not worth resolving now.

## Coverage Checklist

Use this as an adaptive checklist, not a rigid phase order. Mark each branch resolved, intentionally deferred, or still open.

- [ ] Desired outcome and success criteria
- [ ] Scope boundaries and non-goals
- [ ] User/audience/stakeholder context
- [ ] Constraints, dependencies, and available resources
- [ ] Alternatives, tradeoffs, and decision criteria
- [ ] Risks, failure modes, edge cases, and open unknowns
- [ ] Validation, testing, or evidence plan
- [ ] Rollout/next steps and ownership
- [ ] Output artifact selection (only in the mandatory terminal phase)

## Decision Branches

- Root: clarify the user's desired outcome and success criteria, then follow dependent branches one at a time.

## Open Questions

- What outcome is the user ultimately trying to achieve with this topic?
- What constraints or risks should shape the next branch of questioning?
- Which output artifact(s) should be produced, if any, once shared understanding is sufficient?

## Explicit Output Destination Options

${outputDestinationOptionsMarkdown()}
`;
}

function statusMarkdown(state: GrillState): string {
	return `# Grill Status

- Active: ${state.active ? "yes" : "no"}
- Topic: ${state.topic || "(none)"}
- Intent: ${state.intent}
- Style: thorough default
- Research: ${state.researchMode}
- Grounding assist: ${state.assistEnabled === undefined ? "unanswered" : state.assistEnabled ? "on" : "off"}
- Eligible scouts: ${state.availableScouts.length ? state.availableScouts.map((scout) => scout.name).join(", ") : "(none discovered)"}
- Phase: ${phaseLabel(state)}
- Output preference: ${describeOutputPreference(state)}
${
	state.outputSelection
		? `- Output selection rationale: ${state.outputSelection.readinessRationale}
- Recommended outputs: ${state.outputSelection.recommendedOutputs}
- Recommended strategy: ${state.outputSelection.recommendedStrategy}
`
		: ""
}${
	state.approvedOutputPlan
		? `- Approved output plan: ${state.approvedOutputPlan}
`
		: ""
}- Current question: ${state.currentQuestion || "(none)"}
- Picker alternatives: ${state.alternatives.length ? state.alternatives.map((a) => a.label).join(" | ") : "(none set)"}
- Checkpoint last updated: ${state.updatedAt ? new Date(state.updatedAt).toLocaleString() : "never"}
${
	state.grounding
		? `- Last grounding: ${state.grounding.skippedReason ? `skipped — ${state.grounding.skippedReason}` : (state.grounding.source ?? "summary shown")}
`
		: ""
}${
	state.lastChangeSummary
		? `- Last checkpoint change: ${state.lastChangeSummary}
`
		: ""
}`;
}

function appendGroundingNote(checkpoint: string, note: string): string {
	const heading = "## Grounding Notes";
	return checkpoint.includes(heading)
		? `${checkpoint.trimEnd()}\n- ${note}\n`
		: `${checkpoint.trimEnd()}\n\n${heading}\n\n- ${note}\n`;
}

function groundingStatusText(view: GroundingView): string {
	if (view.skippedReason)
		return `⚠ grounding skipped: ${view.skippedReason}`.slice(0, 100);
	const source = view.source ? ` · ${view.source}` : "";
	return `🔥 grounding${source}`.slice(0, 100);
}

function groundingResultText(view: GroundingView): string {
	if (view.skippedReason) return `Grounding skipped: ${view.skippedReason}`;
	return `Grounding summary recorded${view.source ? ` (${view.source})` : ""}. Ask the next focused question.`;
}

function normalizeAlternatives(
	alternatives: GrillAlternative[],
): GrillAlternative[] {
	return alternatives
		.map((alt) => ({
			value: String(alt.value ?? "").trim(),
			label: String(alt.label ?? alt.value ?? "").trim(),
			description: alt.description ? String(alt.description).trim() : undefined,
			preview: alt.preview ? String(alt.preview) : undefined,
		}))
		.filter((alt) => alt.value && alt.label)
		.slice(0, 5);
}

function extractTextFromMessage(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function inferTopic(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	const chunks: string[] = [];
	for (
		let i = branch.length - 1;
		i >= 0 && chunks.join("\n").length < 1600;
		i--
	) {
		const entry: any = branch[i];
		if (entry?.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractTextFromMessage(entry.message).trim();
		if (!text || text.startsWith("/grill")) continue;
		chunks.unshift(`${role}: ${text}`);
	}
	const inferred = chunks.join("\n\n").trim();
	return inferred ? `Current conversation context:\n\n${inferred}` : "";
}

function parseArgs(args: string): {
	flags: Record<string, string | true>;
	rest: string;
} {
	const tokens = args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const flags: Record<string, string | true> = {};
	const rest: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i].replace(/^"|"$/g, "");
		if (token.startsWith("--")) {
			const eq = token.indexOf("=");
			if (eq > 2) {
				flags[token.slice(2, eq)] = token.slice(eq + 1);
			} else {
				const key = token.slice(2);
				const next = tokens[i + 1]?.replace(/^"|"$/g, "");
				if (next && !next.startsWith("--")) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else {
			rest.push(token);
		}
	}
	return { flags, rest: rest.join(" ").trim() };
}

function asIntent(value: unknown): Intent | undefined {
	return typeof value === "string" &&
		(INTENTS as readonly string[]).includes(value)
		? (value as Intent)
		: undefined;
}

function asResearchMode(value: unknown): ResearchMode | undefined {
	return typeof value === "string" &&
		(RESEARCH_MODES as readonly string[]).includes(value)
		? (value as ResearchMode)
		: undefined;
}

function firstWord(text: string): string {
	return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function shellSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\n/) // pipelines are handled separately to avoid flagging read-only grep pipelines as mutating.
		.map((s) => s.trim())
		.filter(Boolean);
}

function isReadOnlyGit(args: string[]): boolean {
	const sub = args[1];
	return [
		"status",
		"log",
		"diff",
		"show",
		"branch",
		"grep",
		"ls-files",
		"remote",
		"rev-parse",
		"describe",
	].includes(sub);
}

function isReadOnlyGh(args: string[]): boolean {
	const sub = args[1];
	const sub2 = args[2];
	if (
		["status", "auth", "repo", "pr", "issue", "label", "milestone"].includes(
			sub,
		) === false
	)
		return false;
	if (sub === "repo") return [undefined, "view", "list"].includes(sub2);
	if (sub === "issue")
		return [undefined, "list", "view", "status"].includes(sub2);
	if (sub === "pr")
		return [undefined, "list", "view", "status", "diff", "checks"].includes(sub2);
	if (sub === "label" || sub === "milestone")
		return [undefined, "list", "view"].includes(sub2);
	return true;
}

function isProbablyReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;

	// Redirection and common write helpers are mutations even if the command itself is read-only.
	if (/(^|[^<])>(>|&)?\s*\S/.test(trimmed) || /\btee\b/.test(trimmed))
		return false;

	const definitelyMutating =
		/\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|sudo|kill|pkill|reboot|shutdown|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash))\b/;
	if (definitelyMutating.test(trimmed)) return false;

	const unsafePhrases = [
		"git add",
		"git commit",
		"git push",
		"git checkout",
		"git switch",
		"git reset",
		"git merge",
		"git rebase",
		"npm install",
		"npm i",
		"npm add",
		"pnpm install",
		"pnpm add",
		"yarn add",
		"yarn install",
		"pip install",
		"cargo install",
		"cargo add",
		"gh issue create",
		"gh issue edit",
		"gh issue close",
		"gh pr create",
		"gh pr edit",
	];
	const lower = trimmed.toLowerCase();
	if (unsafePhrases.some((phrase) => lower.includes(phrase))) return false;

	for (const segment of shellSegments(trimmed)) {
		const args = segment.split(/\s+/);
		const cmd = args[0];
		if (!cmd) continue;
		if (
			[
				"cat",
				"head",
				"tail",
				"less",
				"more",
				"grep",
				"rg",
				"find",
				"fd",
				"ls",
				"pwd",
				"tree",
				"wc",
				"sort",
				"uniq",
				"cut",
				"awk",
				"sed",
				"date",
				"whoami",
				"uname",
				"which",
				"where",
				"echo",
			].includes(cmd)
		) {
			continue;
		}
		if (["npm", "pnpm", "yarn"].includes(cmd)) {
			if (["list", "outdated", "view", "info", "why"].includes(args[1])) continue;
			return false;
		}
		if (cmd === "git") {
			if (isReadOnlyGit(args)) continue;
			return false;
		}
		if (cmd === "gh") {
			if (isReadOnlyGh(args)) continue;
			return false;
		}
		// Unknown commands may mutate; block in grill interview mode.
		return false;
	}
	return true;
}

export default function grillMeExtension(pi: ExtensionAPI): void {
	let state: GrillState = cloneState(DEFAULT_STATE);

	function persist(): void {
		state.updatedAt = Date.now();
		pi.appendEntry(STATE_ENTRY_TYPE, cloneState(state));
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!state.active) {
			ctx.ui.setStatus("grill-me", undefined);
			ctx.ui.setStatus("grill-grounding", undefined);
			return;
		}

		const phase = currentPhase(state);
		const status =
			phase === "output"
				? "🔥 grill: output"
				: phase === "output-selection"
					? "🔥 grill: select output"
					: "🔥 grill";
		ctx.ui.setStatus(
			"grill-me",
			ctx.ui.theme.fg(
				phase === "output"
					? "warning"
					: phase === "output-selection"
						? "success"
						: "accent",
				status,
			),
		);
		ctx.ui.setStatus(
			"grill-grounding",
			state.grounding?.skippedReason
				? ctx.ui.theme.fg("warning", groundingStatusText(state.grounding))
				: undefined,
		);
	}

	async function startSession(
		topic: string,
		ctx: ExtensionContext,
		partial: Partial<GrillState> = {},
	): Promise<void> {
		state = {
			...cloneState(DEFAULT_STATE),
			...partial,
			active: true,
			topic,
			phase: "interview",
			outputPhase: false,
			outputSelection: undefined,
			approvedOutputPlan: undefined,
		};
		state.checkpoint = initialCheckpoint(topic, state);
		state.lastChangeSummary = "Started grill session";
		persist();
		updateUi(ctx);

		if (ctx.hasUI) {
			const result = await showPicker(
				ctx,
				"Use installed read-only subagents to ground this Grill Me session?",
				ASSIST_OPTIONS,
				state.language,
			);
			state.assistEnabled = result.status === "answered" && result.value === "yes";
		} else {
			state.assistEnabled = false;
		}
		state.lastChangeSummary = state.assistEnabled
			? "Grounding assist enabled for this session"
			: "Grounding assist disabled for this session";
		persist();
		updateUi(ctx);

		pi.sendUserMessage(
			`Start a Grill Me session for this topic:\n\n${topic}\n\nGrounding assist is ${state.assistEnabled ? "enabled" : "disabled"} for this session. Begin by updating the checkpoint if needed, seed or maintain the coverage checklist and decision branches, then call grill_set_alternatives with 2-5 concrete answer choices and ask the first focused Socratic question. Call grill_set_alternatives so an ↑/↓ + Enter picker overlay opens; it returns the user's structured answer as the tool result, which you record in the checkpoint before asking the next question. Use the single thorough grilling style. When the interview is ready to end, the mandatory hardcoded output-selection phase must be entered with grill_enter_output_selection_phase before producing outputs or stopping.`,
		);
	}

	async function showCheckpointOverlay(
		ctx: ExtensionContext,
	): Promise<"edit" | undefined> {
		if (!ctx.hasUI) {
			pi.sendMessage({
				customType: "grill-me-checkpoint",
				content: state.checkpoint,
				display: true,
			});
			return undefined;
		}

		return await ctx.ui.custom<"edit" | undefined>(
			(tui, theme, _keybindings, done) => {
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const markdown = new Markdown(state.checkpoint, 1, 0, getMarkdownTheme());
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
					scrollOffset = Math.max(0, Math.min(maxOffset(), scrollOffset + delta));
					tui.requestRender();
				}

				return {
					render(width: number) {
						const body = bodyLines(width);
						scrollOffset = Math.min(scrollOffset, maxOffset());
						const visible = body.slice(scrollOffset, scrollOffset + maxBodyLines);
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
		if (!state.checkpoint.trim()) {
			ctx.ui.notify("No grill checkpoint yet.", "warning");
			return;
		}

		const selected = mode?.trim().toLowerCase() || "overlay";
		if (selected.includes("edit")) {
			const edited = await ctx.ui.editor(
				"Edit Grill Me checkpoint",
				state.checkpoint,
			);
			if (edited !== undefined) {
				state.checkpoint = edited.trim() || state.checkpoint;
				state.lastChangeSummary = "Checkpoint edited by user";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill checkpoint updated.", "info");
			}
			return;
		}

		if (selected.includes("chat")) {
			pi.sendMessage({
				customType: "grill-me-checkpoint",
				content: state.checkpoint,
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
					content: `# Grill Me commands\n\n- /grill <topic>\n- /grill stop\n- /checkpoint [edit|chat]\n- /grill checkpoint [edit|chat]\n- /grill status\n- /grill intent auto|plan|learn|research|content|decide\n- /grill output <one or more outputs> (preference only; approval still required)\n- /grill research off|ask|auto\n\nGrill Me uses one thorough default Socratic style. The assistant must use the hardcoded output-selection phase before ending the interview, producing outputs, or stopping without outputs.`,
					display: true,
				});
				return;
			}

			if (command === "stop") {
				state.active = false;
				state.phase = "interview";
				state.outputPhase = false;
				state.outputSelection = undefined;
				state.approvedOutputPlan = undefined;
				state.currentQuestion = undefined;
				state.alternatives = [];
				state.lastChangeSummary = "Stopped grill session";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill mode stopped.", "info");
				return;
			}

			if (command === "status") {
				pi.sendMessage({
					customType: "grill-me-status",
					content: statusMarkdown(state),
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
				state.intent = value;
				state.lastChangeSummary = `Intent set to ${value}`;
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
				state.outputPreference = rest;
				state.lastChangeSummary = `Output preference set to ${rest}`;
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
				state.researchMode = value;
				state.lastChangeSummary = `Research mode set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill research mode: ${value}`, "info");
				return;
			}

			if (command === "language") {
				const value = rest.trim().toLowerCase();
				if (value !== "en" && value !== "id") {
					ctx.ui.notify("Usage: /grill language en|id", "warning");
					return;
				}
				state.language = value;
				state.lastChangeSummary = `Language set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill language: ${value}`, "info");
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
			if (!state.active) {
				return {
					content: [
						{
							type: "text",
							text: "No active Grill Me session. Start one with /grill <topic>.",
						},
					],
					details: {
						checkpoint: state.checkpoint,
						changeSummary: "No active session",
						updatedAt: state.updatedAt,
					},
				};
			}
			state.checkpoint = params.markdown;
			state.lastChangeSummary = params.changeSummary;
			persist();
			return {
				content: [
					{
						type: "text",
						text: `Recorded checkpoint update: ${params.changeSummary}`,
					},
				],
				details: {
					checkpoint: state.checkpoint,
					changeSummary: params.changeSummary,
					updatedAt: state.updatedAt,
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
			const summary = (result.details as any)?.changeSummary;
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
						Type.String({ description: "Brief explanation or recommendation note." }),
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
			if (!state.active) {
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
			state.currentQuestion = params.question;
			state.alternatives = normalizeAlternatives(
				params.alternatives as GrillAlternative[],
			);
			state.lastChangeSummary = `Set ${state.alternatives.length} picker alternatives`;
			persist();
			if (ctx) updateUi(ctx);

			if (ctx?.hasUI) {
				const result = await showPicker(
					ctx,
					params.question,
					state.alternatives,
					state.language,
				);
				if (result.status === "answered") {
					state.decisions = [
						...state.decisions,
						{
							question: params.question,
							value: result.value,
							label: result.label,
							custom: result.custom,
							note: result.note,
							at: Date.now(),
						},
					];
					state.lastChangeSummary = `Recorded answer: ${result.label}`;
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
							decisions: state.decisions,
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
					details: { question: params.question, alternatives: state.alternatives },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `No interactive UI. Ask this in plain chat and let the user reply free-form:\n${params.question}\n\nAlternatives (text only): ${state.alternatives.map((a) => a.label).join(", ")}`,
					},
				],
				details: {
					question: state.currentQuestion,
					alternatives: state.alternatives,
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
			const alternatives = ((result.details as any)?.alternatives ??
				[]) as GrillAlternative[];
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
		async execute(_toolCallId, params) {
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: { scouts: [] },
				};
			}
			if (state.assistEnabled !== true) {
				return {
					content: [
						{ type: "text", text: "Grounding assist is disabled for this session." },
					],
					details: { scouts: [], assistEnabled: state.assistEnabled },
				};
			}
			const scouts = eligibleScouts(params.agents as ScoutAgent[]);
			state.availableScouts = scouts;
			state.lastChangeSummary = scouts.length
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
				details: { scouts, assistEnabled: state.assistEnabled },
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
			const scouts = ((result.details as any)?.scouts ?? []) as ScoutAgent[];
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
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {},
				};
			}
			if (state.assistEnabled !== true) {
				return {
					content: [
						{ type: "text", text: "Grounding assist is disabled for this session." },
					],
					details: { assistEnabled: state.assistEnabled },
				};
			}
			const view: GroundingView = {
				summary: params.summary.trim(),
				source: params.source?.trim() || undefined,
				confidence: params.confidence?.trim() || undefined,
				skippedReason: params.skippedReason?.trim() || undefined,
			};
			state.grounding = { ...view, at: Date.now() };
			if (view.skippedReason) {
				state.checkpoint = appendGroundingNote(
					state.checkpoint,
					`Grounding skipped: ${view.skippedReason}`,
				);
				state.lastChangeSummary = `Grounding skipped: ${view.skippedReason}`;
			} else {
				state.lastChangeSummary = `Grounding summary recorded${view.source ? ` from ${view.source}` : ""}`;
			}
			persist();
			updateUi(ctx);
			if (view.skippedReason)
				ctx.ui.notify(`Grounding skipped: ${view.skippedReason}`, "warning");
			return {
				content: [{ type: "text", text: groundingResultText(view) }],
				details: { grounding: state.grounding },
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
						Type.String({ description: "Brief explanation or recommendation note." }),
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
			if (!state.active) {
				return {
					content: [
						{
							type: "text",
							text: "No active Grill Me session. Start one with /grill <topic>.",
						},
					],
					details: { phase: currentPhase(state) },
				};
			}
			state.phase = "output-selection";
			state.outputPhase = false;
			state.outputSelection = {
				readinessRationale: params.readinessRationale,
				recommendedOutputs: params.recommendedOutputs,
				recommendedStrategy: params.recommendedStrategy,
				question: params.question,
			};
			state.approvedOutputPlan = undefined;
			state.currentQuestion = params.question;
			state.alternatives = normalizeAlternatives(
				params.alternatives as GrillAlternative[],
			);
			state.lastChangeSummary = "Entered mandatory output-selection phase";
			persist();
			if (ctx) updateUi(ctx);

			if (ctx?.hasUI) {
				const result = await showPicker(
					ctx,
					params.question,
					state.alternatives,
					state.language,
				);
				if (result.status === "answered") {
					state.decisions = [
						...state.decisions,
						{
							question: params.question,
							value: result.value,
							label: result.label,
							custom: result.custom,
							note: result.note,
							at: Date.now(),
						},
					];
					state.lastChangeSummary = `Output selection answered: ${result.label}`;
					persist();
					return {
						content: [
							{
								type: "text",
								text: `User chose: ${result.label}${result.custom ? ` (custom: "${result.value}")` : ` (${result.value})`}${result.note ? `\nNote: ${result.note}` : ""}\n\nIn the chat response, name the concrete output options from the catalog (GitHub issues, Design doc, README.md, ADR, PRD, Implementation plan, Research brief, Summary / decision memo, Tutorial / content outline, Test plan / QA checklist, Changelog / release notes). If the user approved concrete output production, call grill_enter_output_phase; if they chose to continue or stop without output, call grill_finish_output_selection_phase.`,
							},
						],
						details: {
							phase: currentPhase(state),
							outputSelection: state.outputSelection,
							result,
							alternatives: state.alternatives,
						},
					};
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `Output-selection phase is active. In the chat response, explicitly show these output destination options:\n${outputDestinationOptionsMarkdown()}\n\nThen ask the user to choose one or more, customize the set, continue grilling, review the checkpoint, or stop without output. Alternatives: ${state.alternatives.map((a) => a.label).join(", ")}`,
					},
				],
				details: {
					phase: currentPhase(state),
					outputSelection: state.outputSelection,
					outputDestinationOptions: OUTPUT_DESTINATION_OPTIONS,
					alternatives: state.alternatives,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("grill_enter_output_selection_phase ")) +
					theme.fg("muted", args.question ?? ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const selection = (result.details as any)?.outputSelection;
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
		promptSnippet: "Resolve Grill Me output selection without output production",
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
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: { phase: currentPhase(state), active: state.active },
				};
			}
			if (currentPhase(state) !== "output-selection") {
				return {
					content: [
						{
							type: "text",
							text:
								"No active output-selection phase. Call grill_enter_output_selection_phase before resolving output selection.",
						},
					],
					details: { phase: currentPhase(state), active: state.active },
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
				state.phase = "interview";
				state.outputPhase = false;
				state.outputSelection = undefined;
				state.currentQuestion = undefined;
				state.alternatives = [];
				state.lastChangeSummary = params.summary
					? `Output selection resolved: ${params.summary}`
					: "Output selection resolved: continue grilling";
				persist();
				if (ctx) updateUi(ctx);
				return {
					content: [
						{
							type: "text",
							text:
								"Returned to Grill Me interview mode. Ask the next Socratic question with grill_set_alternatives.",
						},
					],
					details: { phase: currentPhase(state), active: state.active, outcome },
				};
			}

			if (
				outcome === "stop-without-output" ||
				outcome === "stop" ||
				outcome === "no-output" ||
				outcome === "none"
			) {
				state.active = false;
				state.phase = "interview";
				state.outputPhase = false;
				state.outputSelection = undefined;
				state.approvedOutputPlan = undefined;
				state.currentQuestion = undefined;
				state.alternatives = [];
				state.lastChangeSummary = params.summary
					? `Stopped after output selection: ${params.summary}`
					: "Stopped after output selection without outputs";
				persist();
				if (ctx) updateUi(ctx);
				return {
					content: [{ type: "text", text: state.lastChangeSummary }],
					details: { phase: currentPhase(state), active: state.active, outcome },
				};
			}

			return {
				content: [
					{
						type: "text",
						text:
							"Unsupported outcome. Use 'continue-grilling' or 'stop-without-output'. If outputs were approved, call grill_enter_output_phase instead.",
					},
				],
				details: { phase: currentPhase(state), active: state.active, outcome },
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
			"During output phase, do not refuse approved mutating output work merely because it mutates state, such as creating GitHub issues. If a tool, CLI, platform, or pi permission/authentication gate blocks the mutation, stop and ask the user for the needed permission, confirmation, credentials, or plan change; do not bypass it or broaden scope.",
			GITHUB_REPO_PERMISSION_GUIDANCE,
		],
		parameters: Type.Object({
			outputPlan: Type.String({
				description:
					"The approved output plan, including one or more outputs/artifacts/files/issues and intended tool use.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {
						phase: currentPhase(state),
						outputPhase: false,
						outputPlan: params.outputPlan,
					},
				};
			}
			if (currentPhase(state) !== "output-selection" && !state.outputPhase) {
				return {
					content: [
						{
							type: "text",
							text:
								"Output production requires the mandatory output-selection phase first. Call grill_enter_output_selection_phase, ask the user to choose/approve outputs, then call grill_enter_output_phase.",
						},
					],
					details: {
						phase: currentPhase(state),
						outputPhase: false,
						outputPlan: params.outputPlan,
					},
				};
			}
			state.phase = "output";
			state.outputPhase = true;
			state.approvedOutputPlan = params.outputPlan;
			state.lastChangeSummary = "Entered approved output phase";
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Output phase enabled for approved plan:\n${params.outputPlan}\n\n${GITHUB_REPO_PERMISSION_GUIDANCE}`,
					},
				],
				details: {
					phase: currentPhase(state),
					outputPhase: true,
					outputPlan: params.outputPlan,
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
			state.phase = "interview";
			state.outputPhase = false;
			state.outputSelection = undefined;
			state.approvedOutputPlan = undefined;
			state.lastChangeSummary = params.summary
				? `Finished output phase: ${params.summary}`
				: "Finished output phase";
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [{ type: "text", text: state.lastChangeSummary }],
				details: {
					phase: currentPhase(state),
					outputPhase: false,
					summary: params.summary,
				},
			};
		},
	});

	pi.on("tool_call", async (event) => {
		if (!state.active || state.outputPhase) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason:
					"Grill Me is read-only until the mandatory output-selection phase runs and the user approves a concrete output plan. Call grill_enter_output_selection_phase first, then grill_enter_output_phase before writing artifacts.",
			};
		}

		if (event.toolName === "bash") {
			const command = String((event.input as any)?.command ?? "");
			if (!isProbablyReadOnlyBash(command)) {
				return {
					block: true,
					reason: `Grill Me read-only mode blocked a potentially mutating command. Run the mandatory output-selection phase with grill_enter_output_selection_phase, get output approval, then call grill_enter_output_phase first.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.active) return;

		const thoroughGrillingGuidance = [
			"Use one thorough default style throughout the interview.",
			"Be relentlessly curious but collaborative: challenge vague answers, surface contradictions, and test assumptions without changing persona.",
			"Ask enough follow-up questions to resolve the decision tree. Prefer one more high-value question over premature readiness.",
			"Maintain a coverage checklist and decision-branch ledger in the checkpoint; mark branches resolved, deferred, or still open as understanding evolves.",
			"Walk dependent branches one at a time. If an answer changes upstream assumptions, revisit affected downstream decisions before moving on.",
			"Do not enter output selection until major objective, scope, constraints, dependencies, risks, validation, and output branches are resolved or explicitly deferred.",
		].join("\n- ");

		const researchGuidance: Record<ResearchMode, string> = {
			off: "Do not proactively inspect files or research. Ask the user instead unless they explicitly provide context.",
			ask: "If a question could be answered by inspecting files/code/research, ask permission before doing so.",
			auto:
				"For coding/project contexts, if a question can be answered by inspecting available files/code, inspect instead of asking. Use read-only tools during interview mode.",
		};

		const groundingGuidance =
			state.assistEnabled === true
				? 'Grounding assist is enabled. Before each repo-relevant question, use cymbal_* tools first when they can answer. If cymbal cannot answer, call subagent({ action: "list", capabilities: true }), pass its live capability rows to grill_set_scouts, then run one eligible read-only scout with subagent({ agent, task }). Call grill_show_grounding with a concise evidence summary before the question. If grounding fails, call grill_show_grounding with skippedReason and continue ungrounded. If a scout reports follow-up work, use subagent mission.create/missionId for durable escalation rather than silently launching repeated work.'
				: state.assistEnabled === false
					? "Grounding assist is disabled for this session. Do not call subagents for Grill Me grounding."
					: "Grounding assist was not answered. Ask the user before using subagents for Grill Me grounding.";

		const phase = currentPhase(state);
		const outputPhaseGuidance =
			phase === "output"
				? `Approved output phase: produce only the approved outputs. If a required mutation is blocked by permissions, auth, or repo setup, ask the user instead of bypassing or faking success. ${GITHUB_REPO_PERMISSION_GUIDANCE} When done, call grill_finish_output_phase.`
				: phase === "output-selection"
					? "You are in the mandatory output-selection phase. Do not ask new interview questions unless the user chooses to continue grilling. Ask the user to choose outputs/continue/review/stop from the active output-selection alternatives. If they approve concrete output production, call grill_enter_output_phase. If they choose to continue or stop without output, call grill_finish_output_selection_phase."
					: "You are in read-only interview mode. Do not implement, write files, create issues, install packages, run mutating commands, or stop the Grill Me work. When ready to end the interview, first update the checkpoint if needed, then call grill_enter_output_selection_phase to enter the mandatory hardcoded output-selection phase before output production or stopping.";

		const outputSelectionSummary = state.outputSelection
			? `\n\nActive output selection:\n- Rationale: ${state.outputSelection.readinessRationale}\n- Recommended outputs: ${state.outputSelection.recommendedOutputs}\n- Recommended strategy: ${state.outputSelection.recommendedStrategy}\n- Question: ${state.outputSelection.question}`
			: "";

		const prompt = `\n\n[GRILL ME EXTENSION ACTIVE]\nTopic:\n${state.topic}\n\nConfiguration:\n- Intent preset: ${state.intent}\n- Grilling style: thorough default
- Research mode: ${state.researchMode}
- Grounding assist: ${state.assistEnabled === undefined ? "unanswered" : state.assistEnabled ? "enabled" : "disabled"}
- Eligible grounding scouts: ${state.availableScouts.length ? state.availableScouts.map((scout) => scout.name).join(", ") : "none discovered"}
- Output preference: ${describeOutputPreference(state)}
- Phase: ${phase}\n- Output phase: ${state.outputPhase ? "yes" : "no"}${outputSelectionSummary}\n\nCurrent checkpoint:\n${state.checkpoint || "(No checkpoint yet.)"}\n\nCurrent picker alternatives (shown in the ↑/↓ + Enter overlay):\n${state.alternatives.length ? state.alternatives.map((a) => `- ${a.label}: ${a.value}${a.description ? ` (${a.description})` : ""}`).join("\n") : "(None set.)"}\n\nDecisions so far:\n${state.decisions.length ? state.decisions.map((d) => `- ${d.question} → ${d.label}${d.note ? ` (note: ${d.note})` : ""}`).join("\n") : "(None recorded.)"}\n\nBehavior:\n- Apply the Socratic method to reach shared understanding of the topic.\n- Avoid hardcoded interview phases. Adapt the dimensions you explore to the subject and to the user's expertise.\n- The output-selection phase is the one hardcoded terminal phase: it is mandatory before stopping the Grill Me work, stopping without outputs, or producing outputs.\n- Treat desired outcome mode as important: learning, building, researching, content/tutorial creation, decision review, etc.\n- Do not set or assume a default output mode for the session. A missing output preference means no output has been chosen yet, not design-doc or any other default.\n- Treat /grill output as a preference only, not production approval. Always explicitly ask/confirm which output(s) to produce before output production.\n- Support 1..n outputs in one approved output plan; for example, a design doc AND uploaded GitHub issues.\n- The output-selection phase must explicitly mention concrete output destinations by name. Use this catalog and allow custom combinations:\n${outputDestinationOptionsMarkdown()}\n- ${groundingGuidance}
- Ask mostly one focused question at a time. Small grouped questions are allowed only when inseparable.
- Ask more than the minimum needed for a shallow summary: keep drilling until the meaningful dependency branches are resolved, contradicted, or intentionally deferred.\n- Every grill question must present 2-5 concrete answer alternatives. Before asking the question, call grill_set_alternatives with 2-5 concrete alternatives (and optional previews); it opens an ↑/↓ + Enter picker overlay with a "Type something." custom-answer row and an n-note key, and returns the user's structured answer as the tool result. Show the same alternatives briefly in chat, and record the picked answer (with any note) as a structured decision in the checkpoint before asking the next question.\n- Include your recommended answer by default with each grill question and mark it as recommended.\n- ${thoroughGrillingGuidance}\n- ${researchGuidance[state.researchMode]}\n- ${outputPhaseGuidance}\n\nCheckpoint rule:\n- The checkpoint is the source of durable shared understanding.\n- Whenever the user's answer meaningfully changes shared understanding, call grill_update_checkpoint with a full replacement Markdown checkpoint and a concise changeSummary BEFORE asking the next grill question.\n- The checkpoint should be adaptive Markdown. Add/remove sections as appropriate for the topic.\n- Keep a coverage checklist and decision-branch ledger in the checkpoint when useful; update branch status as resolved, open, contradicted, or intentionally deferred.\n- If there is no meaningful change, you may ask the next question without updating.\n\nReadiness/output rule:\n- When you think shared understanding is good enough, do not merely present a prompt-only readiness gate. First verify that the major coverage branches are resolved or explicitly deferred, then call grill_enter_output_selection_phase with the rationale, recommended output destination(s), recommended strategy, explicit output-selection question, and 2-5 alternatives.\n- The mandatory output-selection phase must explicitly ask the user which output(s) to produce, even if you have a recommendation or /grill output preference. In the chat response, name the concrete options from the catalog above, including GitHub issues, design doc, README.md, ADR, PRD, implementation plan, research brief, summary/decision memo, tutorial/content outline, test plan/QA checklist, and changelog/release notes.\n- Offer useful single-output and multi-output alternatives where appropriate, and make clear the user can choose 1..n outputs or customize the list.\n- Output-selection alternatives should include continue grilling and/or review checkpoint when useful, and stop-without-output when producing no artifact is a reasonable choice.\n- Output destination and strategy are separate. For example, GitHub issues can be implementation slices, tutorial chapters, research investigations, content installments, or prototype experiments.\n- For file outputs, draft before writing. For GitHub issues, preview titles/bodies/labels before creating. For multiple outputs, preview the full set and dependencies/order before creation.\n- Mutating output actions require explicit user approval of the concrete output set/plan, an active output-selection phase, and grill_enter_output_phase first.\n- During approved output phase, perform only approved mutations, and do not refuse approved mutating output actions merely because they mutate state. If a permission/authentication/tool/repo setup gate blocks an approved mutation (for example gh issue create), ask the user for permission, confirmation, credentials, or a revised plan instead of bypassing or faking success. ${GITHUB_REPO_PERMISSION_GUIDANCE}\n- If the user chooses to continue grilling or stop without output during output selection, call grill_finish_output_selection_phase with that outcome.\n[/GRILL ME EXTENSION ACTIVE]`;

		return { systemPrompt: event.systemPrompt + prompt };
	});

	pi.on("session_start", async (_event, ctx) => {
		state = cloneState(DEFAULT_STATE);
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries as any[]) {
			if (
				entry?.type === "custom" &&
				entry.customType === STATE_ENTRY_TYPE &&
				entry.data
			) {
				state = { ...cloneState(DEFAULT_STATE), ...entry.data };
				if (state.outputPreference === LEGACY_DEFAULT_OUTPUT_PREFERENCE)
					state.outputPreference = "";
				if (!state.phase) state.phase = state.outputPhase ? "output" : "interview";
				if (state.phase !== "output") state.outputPhase = false;
				if (!Array.isArray(state.availableScouts)) state.availableScouts = [];
				if (state.grounding && typeof state.grounding !== "object")
					state.grounding = undefined;
			}
		}
		updateUi(ctx);
	});
}
