import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	keyHint,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const SEARCH_URL = "https://s.jina.ai/";
export const READER_URL = "https://r.jina.ai/";
export const DEEP_SEARCH_URL = "https://deepsearch.jina.ai/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 2_000;

type JsonObject = Record<string, unknown>;

type RenderTheme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

export function resolveApiKey(): string | undefined {
	const configured = process.env.JINA_API_KEY;
	if (configured) return configured;

	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	try {
		const auth = JSON.parse(
			readFileSync(join(agentDir, "auth.json"), "utf8"),
		) as { jina?: { key?: string } };
		const key = auth.jina?.key;
		if (!key) return undefined;
		return key.startsWith("$") ? process.env[key.slice(1)] : key;
	} catch {
		return undefined;
	}
}

export function result(text: string, isError = false): AgentToolResult {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		...(isError ? { isError: true } : {}),
	};
}

export function formatResponse(body: string): string {
	try {
		const parsed = JSON.parse(body) as JsonObject;
		const choice = (parsed.choices as JsonObject[] | undefined)?.[0];
		const message = choice?.message;
		if (
			message &&
			typeof message === "object" &&
			typeof (message as JsonObject).content === "string"
		) {
			return (message as JsonObject).content as string;
		}
		return JSON.stringify(parsed, null, 2);
	} catch {
		return body;
	}
}

// ponytail: web pages can be huge; keep head (titles/first results matter) and
// park the full body in tmp so the agent can read what was cut.
export function truncateWeb(text: string): string {
	const trunc = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!trunc.truncated) return text;
	const fullFile = join(tmpdir(), `jina-${Date.now()}.md`);
	try {
		writeFileSync(fullFile, text);
	} catch {
		// tmp write failed — notice still shows what was kept
	}
	return `${trunc.content}\n[Truncated: showing first ${trunc.outputLines} of ${trunc.totalLines} lines (${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}). Full content: ${fullFile}]`;
}

export async function request(
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const body = await response.text();
		if (!response.ok) {
			throw new Error(
				`Jina request failed (${response.status} ${response.statusText}): ${body.slice(0, MAX_ERROR_CHARS)}`,
			);
		}
		return body;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

type HeadersInit = Record<string, string>;

export function headers(apiKey: string | undefined): HeadersInit {
	return {
		Accept: "text/plain",
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
	};
}

export function rowHead(
	theme: RenderTheme,
	label: string,
	detail?: string,
): string {
	let s = theme.fg("toolTitle", theme.bold(label));
	if (detail) s += ` ${theme.fg("muted", detail)}`;
	return s;
}

export function resultHead(
	theme: RenderTheme,
	ok: boolean,
	text: string,
): string {
	const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const body = ok ? theme.fg("muted", text) : theme.fg("error", text);
	return `${mark} ${body}`;
}

export function partialRow(theme: RenderTheme, text: string): Text {
	return new Text(theme.fg("warning", `→ ${text}`), 0, 0);
}

export function resultText(result: {
	content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return result.content
		.map((item) => (item.type === "text" ? (item.text ?? "") : ""))
		.join("\n")
		.trim();
}

function expandText(theme: RenderTheme, text: string): string {
	if (!text) return "";
	return text
		.split("\n")
		.map((line) => theme.fg("dim", line))
		.join("\n");
}

export function resultRow(
	theme: RenderTheme,
	ok: boolean,
	done: string,
	text: string,
	opts: { expanded?: boolean; hint?: boolean } = {},
): Text {
	let s = resultHead(theme, ok, done);
	if (opts.hint && !opts.expanded) {
		s += ` ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
	}
	if (opts.expanded) s += `\n${expandText(theme, text)}`;
	return new Text(s, 0, 0);
}

export function short(text: string, max = 48): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export async function withStatus(
	ctx: ExtensionContext | undefined,
	status: string | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	run: () => Promise<string>,
): Promise<string> {
	if (status) {
		onUpdate?.({ content: [{ type: "text", text: status }], details: {} });
		if (ctx?.hasUI) {
			ctx.ui.setStatus("jina", ctx.ui.theme.fg("accent", `● ${status}`));
		}
	}
	try {
		return await run();
	} finally {
		if (status && ctx?.hasUI) ctx.ui.setStatus("jina", undefined);
	}
}

export function normalizeQueries(queries: string[]): {
	queries: string[];
	dropped: number;
} {
	const seen = new Set<string>();
	const out: string[] = [];
	let dropped = 0;
	for (const raw of queries) {
		const q = raw.trim();
		if (!q) {
			dropped++;
			continue;
		}
		const key = q.toLowerCase();
		if (seen.has(key)) {
			dropped++;
			continue;
		}
		seen.add(key);
		if (out.length >= 4) {
			dropped++;
			continue;
		}
		out.push(q);
	}
	return { queries: out, dropped };
}

export function sliceBounded(
	text: string,
	offset?: number,
	maxCharacters?: number,
): string {
	const start = Math.max(0, offset ?? 0);
	const limit =
		maxCharacters == null ? text.length : Math.min(maxCharacters, 100_000);
	return text.slice(start, start + limit);
}

const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	"can",
	"need",
	"ought",
	"used",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"among",
	"under",
	"over",
	"again",
	"further",
	"then",
	"once",
	"here",
	"there",
	"when",
	"where",
	"why",
	"how",
	"all",
	"any",
	"both",
	"each",
	"few",
	"more",
	"most",
	"other",
	"some",
	"such",
	"no",
	"nor",
	"not",
	"only",
	"own",
	"same",
	"so",
	"than",
	"too",
	"very",
	"s",
	"t",
	"just",
	"don",
	"should",
	"now",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"me",
	"my",
	"we",
	"our",
	"you",
	"your",
	"he",
	"him",
	"his",
	"she",
	"her",
	"they",
	"them",
	"their",
]);

function tokenizeClaim(claim: string): string[] {
	const matches = claim.toLowerCase().match(/\b[a-z]{2,}\b/g) ?? [];
	const tokens = new Set<string>();
	for (const m of matches) {
		if (!STOPWORDS.has(m) && !/^\d+$/.test(m)) tokens.add(m);
	}
	return [...tokens];
}

function splitSentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function tokenPattern(token: string): RegExp {
	const safe = token.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\b${safe}\\b`, "i");
}

const NEGATION_CUES = new Set([
	"not",
	"no",
	"denies",
	"refute",
	"refuted",
	"refutes",
]);

function hasNegationBeforeToken(sentence: string, token: string): boolean {
	const words = sentence.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
	for (let i = 0; i < words.length; i++) {
		if (tokenPattern(token).test(words[i])) {
			for (let j = Math.max(0, i - 3); j < i; j++) {
				if (NEGATION_CUES.has(words[j])) return true;
			}
		}
	}
	return false;
}

export function assessSupport(
	claim: string,
	content: string,
): {
	assessment: "supported" | "contradicted" | "unclear" | "missing-evidence";
	excerpt: string;
	citations: string[];
	heuristic: true;
} {
	const trimmed = content.trim();
	if (!trimmed) {
		return {
			assessment: "missing-evidence",
			excerpt: "",
			citations: [],
			heuristic: true,
		};
	}

	const tokens = tokenizeClaim(claim);
	if (tokens.length === 0) {
		return {
			assessment: "unclear",
			excerpt: "",
			citations: [],
			heuristic: true,
		};
	}

	const sentences = splitSentences(trimmed);
	const counts = new Map<number, number>();
	const matchedTokens = new Set<string>();
	const hitSentences = new Set<number>();
	const negatedSentences = new Set<number>();

	for (let i = 0; i < sentences.length; i++) {
		for (const token of tokens) {
			if (tokenPattern(token).test(sentences[i])) {
				hitSentences.add(i);
				matchedTokens.add(token);
				counts.set(i, (counts.get(i) ?? 0) + 1);
				if (hasNegationBeforeToken(sentences[i], token)) {
					negatedSentences.add(i);
				}
			}
		}
	}

	if (hitSentences.size === 0) {
		return {
			assessment: "unclear",
			excerpt: "",
			citations: [],
			heuristic: true,
		};
	}

	let bestIndex = -1;
	let bestCount = -1;
	for (const [index, count] of counts) {
		if (count > bestCount) {
			bestCount = count;
			bestIndex = index;
		}
	}
	const bestSentence = bestIndex >= 0 ? sentences[bestIndex] : "";
	const ratio = matchedTokens.size / tokens.length;

	for (const index of hitSentences) {
		if (negatedSentences.has(index)) {
			const citationSentences = [...hitSentences]
				.filter((i) => negatedSentences.has(i))
				.map((i) => sentences[i]);
			return {
				assessment: "contradicted",
				excerpt: sentences[index],
				citations: citationSentences,
				heuristic: true,
			};
		}
	}

	if (ratio > 0.5) {
		const citationSentences = [...hitSentences]
			.filter((i) => !negatedSentences.has(i))
			.map((i) => sentences[i]);
		return {
			assessment: "supported",
			excerpt: bestSentence,
			citations: citationSentences,
			heuristic: true,
		};
	}

	return {
		assessment: "unclear",
		excerpt: bestSentence,
		citations: bestSentence ? [bestSentence] : [],
		heuristic: true,
	};
}

export const webSearchTool = {
	name: "web_search",
	label: "Web Search",
	description: "Search the jina-backed web for sources.",
	parameters: Type.Object({
		queries: Type.Array(Type.String(), {
			minItems: 1,
			description:
				"One or more focused web search queries. Max 4 queries; extra queries are dropped (the result reports how many).",
		}),
		site: Type.Optional(
			Type.String({
				description: "Optional domain restriction for all queries.",
			}),
		),
		maxResults: Type.Optional(
			Type.Number({
				minimum: 1,
				maximum: 20,
				description: "Maximum results to return per query.",
			}),
		),
		workflow: Type.Optional(
			Type.String({
				description: "Ignored; kept for compatibility.",
			}),
		),
	}),
	async execute(
		_toolCallId: string,
		params: {
			queries: string[];
			site?: string;
			maxResults?: number;
			workflow?: string;
		},
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback | undefined,
		ctx: ExtensionContext,
	) {
		const apiKey = resolveApiKey();
		if (!apiKey) {
			return result("Jina search requires JINA_API_KEY.", true);
		}

		const { queries, dropped } = normalizeQueries(params.queries);
		if (queries.length === 0) {
			return result("queries must contain at least one non-empty query.", true);
		}

		try {
			const text = await withStatus(
				ctx,
				`searching ${queries.length} queries…`,
				onUpdate,
				async () => {
					const parts: string[] = [];
					for (const q of queries) {
						const body: JsonObject = { q };
						if (params.site) body.site = params.site;
						if (params.maxResults) body.max_num_results = params.maxResults;
						const raw = await request(
							SEARCH_URL,
							{
								method: "POST",
								headers: {
									...headers(apiKey),
									"Content-Type": "application/json",
								},
								body: JSON.stringify(body),
							},
							signal,
						);
						parts.push(`## ${q}\n\n${formatResponse(raw)}`);
					}
					return truncateWeb(parts.join("\n\n"));
				},
			);
			const note =
				dropped > 0 ? `\nnote: dropped ${dropped} extra queries (max 4)` : "";
			return result(`${text}${note}`);
		} catch (error) {
			return result(
				error instanceof Error ? error.message : String(error),
				true,
			);
		}
	},
	renderCall(args: { queries: string[] }, theme: RenderTheme) {
		const head = args.queries.length ? short(args.queries[0]) : "…";
		let line = rowHead(theme, "web_search", head);
		if (args.queries.length > 1) {
			line += ` ${theme.fg("dim", `+${args.queries.length - 1}`)}`;
		}
		return new Text(line, 0, 0);
	},
	renderResult(
		resultObj: AgentToolResult,
		{ expanded }: { expanded: boolean },
		theme: RenderTheme,
		context: { args: { queries: string[] }; isError: boolean },
	) {
		const label = context.args.queries.length
			? short(context.args.queries[0], 32)
			: "…";
		return resultRow(
			theme,
			!context.isError,
			`search ${label}`,
			resultText(resultObj),
			{ expanded, hint: true },
		);
	},
};

const fetchContentSchema = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
	maxCharacters: Type.Optional(
		Type.Number({
			minimum: 1_000,
			maximum: 100_000,
			description: "Maximum characters to return.",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			minimum: 0,
			description: "Character offset to start from.",
		}),
	),
});

async function fetchContentExecute(
	toolName: string,
	params: {
		url: string;
		maxCharacters?: number;
		offset?: number;
	},
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback | undefined,
	ctx: ExtensionContext,
) {
	let target: URL;
	try {
		target = new URL(params.url);
		if (!["http:", "https:"].includes(target.protocol)) {
			throw new Error("URL must use http or https.");
		}
	} catch {
		const hint =
			toolName === "get_search_content"
				? "get_search_content takes a source URL; pass the URL of the stored result"
				: `Invalid URL: ${params.url}`;
		return result(hint, true);
	}

	try {
		const text = await withStatus(
			ctx,
			`reading ${target.hostname}…`,
			onUpdate,
			() =>
				request(
					`${READER_URL}${target.toString()}`,
					{
						headers: {
							...headers(resolveApiKey()),
							"X-Return-Format": "markdown",
						},
					},
					signal,
				),
		);
		const sliced = sliceBounded(text, params.offset, params.maxCharacters);
		return result(truncateWeb(sliced));
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}
}

export const fetchContentTool = {
	name: "fetch_content",
	label: "Fetch Content",
	description: "Fetch a jina-backed Markdown view of a web page.",
	parameters: fetchContentSchema,
	async execute(
		_toolCallId: string,
		params: { url: string; maxCharacters?: number; offset?: number },
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback | undefined,
		ctx: ExtensionContext,
	) {
		return fetchContentExecute("fetch_content", params, signal, onUpdate, ctx);
	},
	renderCall(args: { url: string }, theme: RenderTheme) {
		return new Text(rowHead(theme, "fetch_content", short(args.url)), 0, 0);
	},
	renderResult(
		resultObj: AgentToolResult,
		{ expanded }: { expanded: boolean },
		theme: RenderTheme,
		context: { args: { url: string }; isError: boolean },
	) {
		return resultRow(
			theme,
			!context.isError,
			`fetch ${short(context.args.url, 32)}`,
			resultText(resultObj),
			{ expanded, hint: true },
		);
	},
};

export const getSearchContentTool = {
	name: "get_search_content",
	label: "Get Search Content",
	description:
		"Fetch a jina-backed Markdown view of a stored source URL (ids are not supported).",
	parameters: fetchContentSchema,
	async execute(
		_toolCallId: string,
		params: { url: string; maxCharacters?: number; offset?: number },
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback | undefined,
		ctx: ExtensionContext,
	) {
		return fetchContentExecute(
			"get_search_content",
			params,
			signal,
			onUpdate,
			ctx,
		);
	},
	renderCall(args: { url: string }, theme: RenderTheme) {
		return new Text(
			rowHead(theme, "get_search_content", short(args.url)),
			0,
			0,
		);
	},
	renderResult(
		resultObj: AgentToolResult,
		{ expanded }: { expanded: boolean },
		theme: RenderTheme,
		context: { args: { url: string }; isError: boolean },
	) {
		return resultRow(
			theme,
			!context.isError,
			`source ${short(context.args.url, 32)}`,
			resultText(resultObj),
			{ expanded, hint: true },
		);
	},
};

function formatSourceCheckResult(
	support: ReturnType<typeof assessSupport>,
	source?: string,
): string {
	const lines: string[] = [];
	lines.push(`Assessment: ${support.assessment}`);
	if (support.excerpt) lines.push(`Excerpt: ${support.excerpt}`);
	const cites = source ? [...support.citations, source] : support.citations;
	if (cites.length) {
		lines.push("Citations:");
		for (const c of cites) lines.push(`- ${c}`);
	}
	lines.push(
		"heuristic: true — This is a naive textual heuristic; treat it as a signal and verify the source.",
	);
	return lines.join("\n");
}

export const sourceCheckTool = {
	name: "source_check",
	label: "Source Check",
	description:
		"Check whether a claim is supported by jina-backed source content.",
	parameters: Type.Object({
		claim: Type.String({ description: "Claim to evaluate." }),
		url: Type.Optional(Type.String({ description: "Source URL to read." })),
		content: Type.Optional(
			Type.String({ description: "Source content to evaluate." }),
		),
	}),
	async execute(
		_toolCallId: string,
		params: {
			claim: string;
			url?: string;
			content?: string;
		},
		signal: AbortSignal | undefined,
		_onUpdate: AgentToolUpdateCallback | undefined,
		_ctx: ExtensionContext,
	) {
		const claim = params.claim.trim();
		if (!claim) return result("claim is required", true);

		if (params.content != null && params.content.trim().length > 0) {
			const support = assessSupport(claim, params.content);
			return result(formatSourceCheckResult(support));
		}

		if (params.url) {
			let target: URL;
			try {
				target = new URL(params.url);
				if (!["http:", "https:"].includes(target.protocol)) {
					throw new Error("URL must use http or https.");
				}
			} catch {
				return result(`Invalid URL: ${params.url}`, true);
			}

			try {
				const text = await request(
					`${READER_URL}${target.toString()}`,
					{
						headers: {
							...headers(resolveApiKey()),
							"X-Return-Format": "markdown",
						},
					},
					signal,
				);
				const support = assessSupport(claim, text);
				return result(formatSourceCheckResult(support, params.url));
			} catch (_error) {
				const support = assessSupport(claim, "");
				return result(formatSourceCheckResult(support, params.url), true);
			}
		}

		const support = assessSupport(claim, "");
		return result(formatSourceCheckResult(support));
	},
	renderCall(args: { claim: string }, theme: RenderTheme) {
		return new Text(rowHead(theme, "source_check", short(args.claim)), 0, 0);
	},
	renderResult(
		resultObj: AgentToolResult,
		{ expanded }: { expanded: boolean },
		theme: RenderTheme,
		context: { args: { claim: string }; isError: boolean },
	) {
		return resultRow(
			theme,
			!context.isError,
			"source check",
			resultText(resultObj),
			{ expanded, hint: true },
		);
	},
};

export const aliasTools = [
	defineTool(webSearchTool),
	defineTool(fetchContentTool),
	defineTool(getSearchContentTool),
	defineTool(sourceCheckTool),
];
