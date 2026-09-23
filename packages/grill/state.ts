import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GroundingView, ScoutAgent } from "./grounding.js";

export type Intent =
	| "auto"
	| "plan"
	| "learn"
	| "research"
	| "content"
	| "decide";
export type ResearchMode = "off" | "ask" | "auto";
export type GrillPhase = "interview" | "output-selection" | "output";

/** Master switch for the first-class subagent integration (PRD: spawn can be
 * deactivated via settings/command). Defaults on; gated by settings file and
 * /grill subagents on|off. */
export type SubagentsSetting = boolean;

export interface ScoutsDetails {
	scouts: ScoutAgent[];
}
export interface WritersDetails {
	writers: ScoutAgent[];
	phase?: GrillPhase;
}

export interface GrillAlternative {
	value: string;
	label: string;
	description?: string;
	preview?: string;
}

export interface GrillDecision {
	question: string;
	value: string;
	label: string;
	custom: boolean;
	note?: string;
	at: number;
}

export interface GrillState {
	active: boolean;
	topic: string;
	intent: Intent;
	outputPreference: string;
	researchMode: ResearchMode;
	checkpoint: string;
	phase: GrillPhase;
	outputPhase: boolean;
	dossier?: { text: string; at: number };
	decisions: GrillDecision[];
	subagents: SubagentsSetting;
	/** Isolation backend preference from settings (fed by settings.ts at /grill
	 * start). "auto" lets the output phase choose. */
	isolationSetting?: "worktrees" | "gitbutler" | "slices" | "auto";
	/** Session-only isolation override set by commands.ts (/grill isolation);
	 * never persisted to settings files. */
	sessionIsolationOverride?: "worktrees" | "gitbutler" | "slices" | "auto";
	/** Effective isolation backend chosen for this output batch. */
	resolvedIsolation?: { backend: string; reason: string };
	availableScouts: ScoutAgent[];
	grounding?: GroundingView & { at: number };
	reviewer?: GroundingView & { at: number };
	reviewerRounds: number;
	availableWriters: ScoutAgent[];
	delegate?: boolean;
	chosenWriter?: string;
	outputPaths?: string[];
	outputSlices?: { paths: string[] }[];
	writerDiscoveryRequired?: boolean;
	writersUnavailable?: boolean;
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
	schemaVersion: number;
	titleSet?: boolean;
}

export const STATE_ENTRY_TYPE = "grill-me-state";
/** Bump when GrillState shape changes incompatibly; old sessions are not
 * resumed (accepted scope cut), but /reload restore within a session still
 * works for entries written by the same version. */
export const STATE_SCHEMA_VERSION = 2;
export const LEGACY_DEFAULT_OUTPUT_PREFERENCE =
	"design-doc by default; adapt/recommend near readiness";

export const DEFAULT_STATE: GrillState = {
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
	decisions: [],
	dossier: undefined,
	subagents: true,
	availableScouts: [],
	grounding: undefined,
	reviewer: undefined,
	reviewerRounds: 0,
	availableWriters: [],
	delegate: undefined,
	chosenWriter: undefined,
	outputPaths: undefined,
	currentQuestion: undefined,
	updatedAt: Date.now(),
	schemaVersion: STATE_SCHEMA_VERSION,
};

export const INTENTS = [
	"auto",
	"plan",
	"learn",
	"research",
	"content",
	"decide",
] as const;
export const RESEARCH_MODES = ["off", "ask", "auto"] as const;

// Module-level runtime state. The extension is single-instance per process;
// every module shares this holder instead of one giant closure.
let current: GrillState = cloneState(DEFAULT_STATE);
export const runtime = {
	get state(): GrillState {
		return current;
	},
	set state(next: GrillState) {
		current = next;
	},
};

export function cloneState(state: GrillState): GrillState {
	return { ...state };
}

export function currentPhase(state: GrillState): GrillPhase {
	if (state.outputPhase) return "output";
	return state.phase ?? "interview";
}

export function normalizeAlternatives(
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

function extractTextFromMessage(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

export function inferTopic(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	const chunks: string[] = [];
	for (
		let i = branch.length - 1;
		i >= 0 && chunks.join("\n").length < 1600;
		i--
	) {
		const entry = branch[i] as { type?: string; message?: { role?: string } };
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

export function parseArgs(args: string): {
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

export function asIntent(value: unknown): Intent | undefined {
	return typeof value === "string" &&
		(INTENTS as readonly string[]).includes(value)
		? (value as Intent)
		: undefined;
}

export function asResearchMode(value: unknown): ResearchMode | undefined {
	return typeof value === "string" &&
		(RESEARCH_MODES as readonly string[]).includes(value)
		? (value as ResearchMode)
		: undefined;
}

/** Parse the /grill subagents on|off argument. Pure and exported for tests. */
export function asSubagentsValue(
	value: string | undefined,
): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "on" || normalized === "true" || normalized === "yes")
		return true;
	if (normalized === "off" || normalized === "false" || normalized === "no")
		return false;
	return undefined;
}

export function firstWord(text: string): string {
	return text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

/** Parse approved output file/directory paths out of the approved output plan
 * text. The plan is free-form markdown, so we look for path-like tokens
 * (agent/extensions/..., README.md, etc.) and repo-relative paths. Used to
 * constrain writer-subagent `output` to the approved scope. */
export function approvedOutputPaths(plan: string | undefined): string[] {
	if (!plan) return [];
	const paths = new Set<string>();
	const lines = plan.split(/\r?\n/);
	for (const line of lines) {
		const stripped = line.trim();
		if (!stripped || stripped.startsWith("#")) continue;
		// Match tokens that look like repo paths (contain a slash + a dot, or end
		// in a known file ext) OR a bare filename with a known ext.
		const tokens =
			stripped.match(
				/(?<![\w/])([A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+|[A-Za-z0-9._-]+\.(?:ts|js|json|md|py|go|rs|sh|ya?ml|txt|tsx|jsx))/g,
			) ?? [];
		for (const token of tokens) {
			if (
				token.length >= 3 &&
				!/^https?:\/\//.test(token) &&
				!/^ssh:/.test(token)
			)
				paths.add(token);
		}
	}
	return [...paths];
}

/** True if `target` is within (or equal to) one of the approved output paths
 * or their parent directories. Pure: takes the approved list explicitly so it
 * is testable without Grill state. */
export function isWithinApprovedOutputPath(
	target: string,
	approved: readonly string[],
): boolean {
	const t = target.trim();
	if (!t) return false;
	if (approved.length === 0) return true; // no paths parsed → do not block.
	const norm = (p: string) => p.replace(/\/+$/, "");
	const nt = norm(t);
	return approved.some((p) => {
		const np = norm(p);
		return nt === np || nt.startsWith(np.endsWith("/") ? `${np}` : `${np}/`);
	});
}
