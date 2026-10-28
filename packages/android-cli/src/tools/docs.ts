import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatExecResult,
	partialRow,
	resultRow,
	resultText,
	rowHead,
	runAndroid,
	short,
	toolError,
	toolResult,
} from "../utils.js";

export function registerDocsTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_docs",
		label: "Android Docs",
		description:
			"Search and fetch Android documentation from the official Android Knowledge Base.",
		promptSnippet: "Search or fetch official Android documentation",
		promptGuidelines: [
			"Use android_docs search before giving Android development advice to access the official Android Knowledge Base. Use fetch with kb:// URLs from search results.",
		],
		parameters: Type.Object({
			action: StringEnum(["search", "fetch"] as const),
			query: Type.String({
				description: "Search query or kb:// URL to fetch",
			}),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { action, query } = params;

			if (!query.trim()) {
				return toolError("query is required");
			}

			switch (action) {
				case "search": {
					const result = await runAndroid(
						pi,
						["docs", "search", `'${query}'`],
						{
							signal,
							status: `searching docs: ${short(query, 40)}…`,
							ctx,
							onUpdate,
						},
					);
					return toolResult(formatExecResult(result));
				}

				case "fetch": {
					const result = await runAndroid(pi, ["docs", "fetch", query], {
						signal,
						status: `fetching docs: ${short(query, 40)}…`,
						ctx,
						onUpdate,
					});
					return toolResult(formatExecResult(result));
				}
			}
		},
		renderCall(args, theme) {
			const head = rowHead(
				theme,
				"android_docs",
				`${args.action}: ${short(args.query)}`,
			);
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return partialRow(
					theme,
					`${context.args.action}ing docs: ${short(context.args.query, 40)}…`,
				);
			}
			const row = resultRow(
				theme,
				!context.isError,
				`docs ${context.args.action}`,
				result,
				{ hint: true },
			);
			// Android KB content is markdown — render it as markdown when expanded
			if (!expanded || context.isError) return row;
			const container = new Container();
			container.addChild(row);
			container.addChild(
				new Markdown(resultText(result), 0, 0, getMarkdownTheme()),
			);
			return container;
		},
	});
}
