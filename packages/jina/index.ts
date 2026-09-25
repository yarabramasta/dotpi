import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	aliasTools,
	DEEP_SEARCH_URL,
	formatResponse,
	headers,
	READER_URL,
	request,
	resolveApiKey,
	result,
	resultRow,
	resultText,
	rowHead,
	SEARCH_URL,
	short,
	truncateWeb,
	withStatus,
} from "./aliases.js";

type JsonObject = Record<string, unknown>;

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
		renderResult(resultObj, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(
					theme.fg("warning", `→ searching ${short(context.args.query, 40)}…`),
					0,
					0,
				);
			}
			return resultRow(
				theme,
				!context.isError,
				`search ${short(context.args.query, 32)}`,
				resultText(resultObj),
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
		renderResult(resultObj, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(
					theme.fg(
						"warning",
						`→ deep search ${short(context.args.query, 40)}…`,
					),
					0,
					0,
				);
			}
			return resultRow(
				theme,
				!context.isError,
				"deep search done",
				resultText(resultObj),
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
		renderResult(resultObj, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return new Text(
					theme.fg("warning", `→ reading ${short(context.args.url, 40)}…`),
					0,
					0,
				);
			}
			const row = resultRow(
				theme,
				!context.isError,
				`read ${short(context.args.url, 32)}`,
				resultText(resultObj),
				{ hint: true },
			);
			if (!expanded || context.isError) return row;
			const container = new Container();
			container.addChild(row);
			container.addChild(
				new Markdown(resultText(resultObj), 0, 0, getMarkdownTheme()),
			);
			return container;
		},
	});

	for (const tool of aliasTools) {
		pi.registerTool(tool);
	}

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
