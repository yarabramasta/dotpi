import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getMarkdownTheme,
	keyHint,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type JsonObject = Record<string, unknown>;

const SEARCH_URL = "https://s.jina.ai/";
const DEEP_SEARCH_URL = "https://deepsearch.jina.ai/v1/chat/completions";
const READER_URL = "https://r.jina.ai/";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 2_000;

function resolveApiKey(): string | undefined {
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

function result(text: string, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		...(isError ? { isError: true } : {}),
	};
}

function formatResponse(body: string): string {
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
function truncateWeb(text: string): string {
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

async function request(
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

function headers(apiKey: string | undefined): HeadersInit {
	return {
		Accept: "text/plain",
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
	};
}

// --- branded tool-row helpers (same visual language as android-cli) ---

type RenderTheme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

function rowHead(theme: RenderTheme, label: string, detail?: string): string {
	let s = theme.fg("toolTitle", theme.bold(label));
	if (detail) s += ` ${theme.fg("muted", detail)}`;
	return s;
}

function resultHead(theme: RenderTheme, ok: boolean, text: string): string {
	const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const body = ok ? theme.fg("muted", text) : theme.fg("error", text);
	return `${mark} ${body}`;
}

function partialRow(theme: RenderTheme, text: string): Text {
	return new Text(theme.fg("warning", `→ ${text}`), 0, 0);
}

function resultText(result: {
	content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return result.content
		.map((item) => (item.type === "text" ? (item.text ?? "") : ""))
		.join("\n")
		.trim();
}

function expandText(theme: RenderTheme, text: string): string {
	if (!text) return "";
	// TUI: styles do not carry across lines — reapply per line
	return text
		.split("\n")
		.map((line) => theme.fg("dim", line))
		.join("\n");
}

function resultRow(
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

function short(text: string, max = 48): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Set footer status while the fetch runs; clear after. */
async function withStatus(
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

export default function jinaExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "jina_search_web",
		label: "Jina Web Search",
		description: "Search the web with Jina and return source-backed results.",
		promptSnippet: "Search current web information with Jina",
		promptGuidelines: [
			"Use for current or source-backed web research. Search several focused angles, then read only promising primary sources with jina_read_url.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Focused web search query." }),
			site: Type.Optional(
				Type.String({
					description:
						"Optional domain restriction, such as developer.android.com.",
				}),
			),
			maxResults: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 20,
					description: "Maximum results to return.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.query.trim()) return result("query is required", true);
			const apiKey = resolveApiKey();
			if (!apiKey) return result("Jina search requires JINA_API_KEY.", true);

			const body: JsonObject = { q: params.query };
			if (params.site) body.site = params.site;
			if (params.maxResults) body.max_num_results = params.maxResults;

			try {
				const response = await withStatus(
					ctx,
					`searching ${short(params.query, 40)}…`,
					onUpdate,
					() =>
						request(
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
						),
				);
				return result(truncateWeb(formatResponse(response)));
			} catch (error) {
				return result(
					error instanceof Error ? error.message : String(error),
					true,
				);
			}
		},
		renderCall(args, theme) {
			let head = rowHead(theme, "jina_search_web", short(args.query));
			if (args.site) head += ` ${theme.fg("dim", args.site)}`;
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return partialRow(theme, `searching ${short(context.args.query, 40)}…`);
			}
			return resultRow(
				theme,
				!context.isError,
				`search ${short(context.args.query, 32)}`,
				resultText(result),
				{ expanded, hint: true },
			);
		},
	});

	pi.registerTool({
		name: "jina_search_web_deep",
		label: "Jina Deep Search",
		description:
			"Run Jina DeepSearch for passage-level web research and synthesis.",
		promptSnippet: "Run deeper passage-ranked web research with Jina",
		promptGuidelines: [
			"Use when ordinary search needs broader passage-level ranking or synthesis.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Research question or focused deep-search query.",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.query.trim()) return result("query is required", true);
			const apiKey = resolveApiKey();
			if (!apiKey)
				return result("Jina deep search requires JINA_API_KEY.", true);

			try {
				const response = await withStatus(
					ctx,
					`deep search ${short(params.query, 40)}…`,
					onUpdate,
					() =>
						request(
							DEEP_SEARCH_URL,
							{
								method: "POST",
								headers: {
									...headers(apiKey),
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									model: "jina-deepsearch-v1",
									messages: [{ role: "user", content: params.query }],
									stream: false,
								}),
							},
							signal,
						),
				);
				return result(truncateWeb(formatResponse(response)));
			} catch (error) {
				return result(
					error instanceof Error ? error.message : String(error),
					true,
				);
			}
		},
		renderCall(args, theme) {
			return new Text(
				rowHead(theme, "jina_search_web_deep", short(args.query)),
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return partialRow(
					theme,
					`deep search ${short(context.args.query, 40)}…`,
				);
			}
			return resultRow(
				theme,
				!context.isError,
				"deep search done",
				resultText(result),
				{ expanded, hint: true },
			);
		},
	});

	pi.registerTool({
		name: "jina_read_url",
		label: "Jina Read URL",
		description:
			"Read and convert a web page to clean Markdown with Jina Reader.",
		promptSnippet: "Read a promising web page with Jina",
		promptGuidelines: [
			"Use only after search identifies a promising URL. Prefer official docs, specifications, and primary sources.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "HTTP or HTTPS URL to read." }),
			maxCharacters: Type.Optional(
				Type.Number({
					minimum: 1_000,
					maximum: 100_000,
					description: "Maximum characters to return.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let target: URL;
			try {
				target = new URL(params.url);
				if (!["http:", "https:"].includes(target.protocol))
					throw new Error("URL must use http or https.");
			} catch (error) {
				return result(
					error instanceof Error ? error.message : "Invalid URL.",
					true,
				);
			}

			try {
				const response = await withStatus(
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
				const text = params.maxCharacters
					? response.slice(0, params.maxCharacters)
					: truncateWeb(response);
				return result(text);
			} catch (error) {
				return result(
					error instanceof Error ? error.message : String(error),
					true,
				);
			}
		},
		renderCall(args, theme) {
			return new Text(rowHead(theme, "jina_read_url", short(args.url)), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return partialRow(theme, `reading ${short(context.args.url, 40)}…`);
			}
			const row = resultRow(
				theme,
				!context.isError,
				`read ${short(context.args.url, 32)}`,
				resultText(result),
				{ hint: true },
			);
			// Reader returns markdown — render it as markdown when expanded
			if (!expanded || context.isError) return row;
			const container = new Container();
			container.addChild(row);
			container.addChild(
				new Markdown(resultText(result), 0, 0, getMarkdownTheme()),
			);
			return container;
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const themed = ctx.ui.theme.fg.bind(ctx.ui.theme);
		ctx.ui.setStatus(
			"jina",
			resolveApiKey()
				? `${themed("success", "●")} jina`
				: `${themed("error", "●")} jina ${themed("dim", "key missing")}`,
		);
	});
}
