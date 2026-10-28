import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	androidExec,
	confirmGate,
	formatExecResult,
	partialRow,
	resultRow,
	rowHead,
	runAndroid,
	toolCancelled,
	toolError,
	toolResult,
} from "../utils.js";

export function registerEmulatorTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_emulator",
		label: "Android Emulator",
		description:
			"Manage Android virtual devices (AVDs) — create, start, stop, list, and remove emulators.",
		promptSnippet:
			"Create, start, stop, list, or remove Android virtual devices",
		promptGuidelines: [
			"Use android_emulator to manage Android virtual devices for testing.",
		],
		parameters: Type.Object({
			action: StringEnum(
				["create", "start", "stop", "list", "remove"] as const,
				{ description: "Action to perform on the emulator." },
			),
			device: Type.Optional(
				Type.String({ description: "Device name or serial number." }),
			),
			profile: Type.Optional(
				Type.String({
					description:
						"Device profile for create action (default: medium_phone).",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { action, device, profile } = params;

			if (action === "list") {
				const result = await androidExec(pi, ["emulator", "list"], { signal });
				return toolResult(formatExecResult(result));
			}

			if (action === "create") {
				const confirmed = await confirmGate(
					ctx,
					"Create AVD",
					`Create new AVD${device ? ` "${device}"` : ""}${profile ? ` with profile "${profile}"` : ""}?`,
				);
				if (!confirmed) return toolCancelled();

				const args = ["emulator", "create"];
				if (device) args.push(device);
				if (profile) args.push(`--profile=${profile}`);
				const result = await runAndroid(pi, args, {
					signal,
					status: `creating AVD ${device ?? ""}…`,
					ctx,
					onUpdate,
				});
				return toolResult(formatExecResult(result));
			}

			if (!device) {
				return toolError(
					`Device name or serial number required for "${action}" action.`,
				);
			}

			if (action === "remove") {
				const confirmed = await confirmGate(
					ctx,
					"Remove AVD",
					`Remove AVD "${device}"?`,
				);
				if (!confirmed) return toolCancelled();

				const result = await runAndroid(pi, ["emulator", "remove", device], {
					signal,
					status: `removing AVD ${device}…`,
					ctx,
					onUpdate,
				});
				return toolResult(formatExecResult(result));
			}

			if (action === "start") {
				const result = await runAndroid(pi, ["emulator", "start", device], {
					signal,
					status: `starting emulator ${device}…`,
					ctx,
					onUpdate,
				});
				return toolResult(formatExecResult(result));
			}

			if (action === "stop") {
				const result = await runAndroid(pi, ["emulator", "stop", device], {
					signal,
					status: `stopping emulator ${device}…`,
					ctx,
					onUpdate,
				});
				return toolResult(formatExecResult(result));
			}

			return toolError(`Unknown action: ${action}`);
		},
		renderCall(args, theme) {
			let head = rowHead(theme, "android_emulator", args.action);
			if (args.device) head += ` ${theme.fg("dim", args.device)}`;
			if (args.profile) head += ` ${theme.fg("dim", args.profile)}`;
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return partialRow(theme, `${context.args.action}…`);
			return resultRow(
				theme,
				!context.isError,
				`emulator ${context.args.action}${context.args.device ? ` ${context.args.device}` : ""}`,
				result,
				{ expanded, hint: true },
			);
		},
	});
}
