import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	androidExec,
	formatExecResult,
	resultRow,
	rowHead,
	toolResult,
} from "../utils.js";

export function registerInfoTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_info",
		label: "Android Info",
		description:
			"Print Android environment information including SDK location, CLI version, and launcher version.",
		promptSnippet: "Show Android SDK path and CLI version info",
		promptGuidelines: [
			"Use android_info to check the Android SDK path and CLI version before performing SDK operations.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal) {
			const result = await androidExec(pi, ["info"], { signal });
			if (result.code !== 0) {
				return toolResult(formatExecResult(result));
			}

			// Parse key=value pairs
			const info: Record<string, string> = {};
			for (const line of result.stdout.split("\n")) {
				const match = line.match(/^(\w+):\s*(.+)$/);
				if (match) info[match[1]] = match[2];
			}

			return toolResult(formatExecResult(result), info);
		},
		renderCall(_args, theme) {
			return new Text(rowHead(theme, "android_info"), 0, 0);
		},
		renderResult(result, { expanded }, theme, context) {
			const sdk = result.details?.sdk as string | undefined;
			const version = result.details?.version as string | undefined;
			const line = sdk
				? `${version ?? "android"} · SDK: ${sdk}`
				: "environment info";
			return resultRow(theme, !context.isError, line, result, {
				expanded,
				hint: true,
			});
		},
	});
}
