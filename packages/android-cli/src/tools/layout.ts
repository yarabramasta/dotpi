import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatExecResult,
	partialRow,
	resultRow,
	rowHead,
	runAndroid,
	short,
	toolResult,
	tryParseJson,
} from "../utils.js";

export function registerLayoutTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_layout",
		label: "Android Layout",
		description:
			"Get the UI layout tree of the active Android app on a connected device or emulator as JSON.",
		promptSnippet: "Inspect UI layout hierarchy of running Android app",
		promptGuidelines: [
			"Use android_layout to inspect the current UI hierarchy on a connected device. Use --diff to see only changed elements.",
		],
		parameters: Type.Object({
			pretty: Type.Optional(Type.Boolean()),
			diff: Type.Optional(Type.Boolean()),
			output: Type.Optional(Type.String()),
			device: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { pretty, diff, output, device } = params;
			const args: string[] = ["layout"];
			if (pretty) args.push("-p");
			if (diff) args.push("-d");
			if (output) args.push("-o", output);
			if (device) args.push("--device", device);

			const result = await runAndroid(pi, args, {
				signal,
				status: "reading UI layout…",
				ctx,
				onUpdate,
			});
			const parsed = tryParseJson(result.stdout);
			if (parsed) {
				return toolResult(formatExecResult(result), { layout: parsed });
			}
			return toolResult(formatExecResult(result));
		},
		renderCall(args, theme) {
			let head = rowHead(theme, "android_layout");
			if (args.diff) head += ` ${theme.fg("dim", "--diff")}`;
			if (args.device) head += ` ${theme.fg("dim", args.device)}`;
			if (args.output) head += ` ${theme.fg("dim", short(args.output))}`;
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return partialRow(theme, "reading UI layout…");
			return resultRow(
				theme,
				!context.isError,
				context.args.diff ? "layout diff" : "UI layout",
				result,
				{ expanded, hint: true },
			);
		},
	});
}
