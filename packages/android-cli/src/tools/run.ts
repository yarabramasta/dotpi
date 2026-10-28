import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	confirmGate,
	formatExecResult,
	partialRow,
	resultRow,
	rowHead,
	runAndroid,
	short,
	toolCancelled,
	toolResult,
} from "../utils.js";

const apkList = (apks: string) =>
	apks
		.split(",")
		.map((apk) => basename(apk.trim()))
		.join(", ");

export function registerRunTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_run",
		label: "Run Android App",
		description:
			"Deploy an Android application (APK) to a connected device or emulator.",
		promptSnippet: "Deploy APK to device or emulator",
		promptGuidelines: [
			"Use android_run to deploy built APKs to connected devices or emulators. Requires APK paths.",
		],
		parameters: Type.Object({
			apks: Type.String({ description: "Comma-separated APK file paths" }),
			device: Type.Optional(
				Type.String({ description: "Device serial number" }),
			),
			activity: Type.Optional(
				Type.String({ description: "Activity to launch" }),
			),
			debug: Type.Optional(
				Type.Boolean({ description: "Deploy in debug mode" }),
			),
			type: Type.Optional(
				Type.String({
					description:
						"Component type: ACTIVITY, SERVICE, WATCH_FACE, TILE, COMPLICATION",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const granted = await confirmGate(
				ctx,
				"Deploy APK",
				`Deploy ${params.apks} to ${params.device || "default device"}?`,
			);
			if (!granted) return toolCancelled();

			const args = ["run", `--apks=${params.apks}`];
			if (params.device) args.push(`--device=${params.device}`);
			if (params.activity) args.push(`--activity=${params.activity}`);
			if (params.debug) args.push("--debug");
			if (params.type) args.push(`--type=${params.type}`);

			const result = await runAndroid(pi, args, {
				signal,
				status: `deploying ${short(apkList(params.apks))}…`,
				ctx,
				onUpdate,
			});
			return toolResult(formatExecResult(result));
		},
		renderCall(args, theme) {
			let head = rowHead(theme, "android_run", apkList(args.apks));
			if (args.device) head += ` ${theme.fg("dim", `→ ${args.device}`)}`;
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return partialRow(
					theme,
					`deploying ${short(apkList(context.args.apks))}…`,
				);
			}
			return resultRow(
				theme,
				!context.isError,
				context.isError ? "deploy failed" : "deployed",
				result,
				{ expanded, hint: true },
			);
		},
	});
}
