import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatExecResult,
	partialRow,
	resultRow,
	rowHead,
	runAndroid,
	short,
	toolError,
	toolResult,
} from "../utils.js";

export function registerScreenTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_screen",
		label: "Android Screen",
		description:
			"Capture device screenshots and resolve UI element coordinates from annotated screenshots.",
		promptSnippet: "Capture screenshots or resolve UI element coordinates",
		promptGuidelines: [
			"Use android_screen capture to take device screenshots. Use annotate=true then resolve to map UI labels to coordinates for automation.",
		],
		parameters: Type.Object({
			action: StringEnum(["capture", "resolve"] as const),
			output: Type.Optional(Type.String()),
			annotate: Type.Optional(Type.Boolean()),
			screenshot: Type.Optional(Type.String()),
			string: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { action, output, annotate, screenshot, string } = params;

			switch (action) {
				case "capture": {
					const args = ["screen", "capture"];
					if (output) args.push("--output", output);
					if (annotate) args.push("--annotate");
					const result = await runAndroid(pi, args, {
						signal,
						status: "capturing screen…",
						ctx,
						onUpdate,
					});
					const image =
						result.stdout.match(/([^\s'"]+\.(?:png|jpe?g))/)?.[1] ??
						params.output;
					return toolResult(formatExecResult(result), image ? { image } : {});
				}

				case "resolve": {
					if (!screenshot)
						return toolError("screenshot path required for resolve");
					if (!string)
						return toolError(
							"string with #N placeholders required for resolve",
						);
					const args = [
						"screen",
						"resolve",
						`--screenshot=${screenshot}`,
						`--string=${string}`,
					];
					const result = await runAndroid(pi, args, {
						signal,
						status: "resolving UI elements…",
						ctx,
						onUpdate,
					});
					return toolResult(formatExecResult(result));
				}
			}
		},
		renderCall(args, theme) {
			let head = rowHead(theme, "android_screen", args.action);
			const detail = args.output ?? args.screenshot;
			if (detail) head += ` ${theme.fg("dim", short(detail))}`;
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return partialRow(
					theme,
					context.args.action === "resolve"
						? "resolving UI elements…"
						: "capturing screen…",
				);
			}
			let done: string;
			if (context.args.action === "resolve") {
				done = "coordinates resolved";
			} else {
				done = `screenshot${context.args.output ? ` → ${short(context.args.output)}` : " saved"}`;
			}
			const row = resultRow(theme, !context.isError, done, result, {
				expanded,
				hint: true,
			});

			// Inline screenshot in terminals with image support (Kitty, iTerm2, Ghostty…)
			const image = (result.details as { image?: string } | undefined)?.image;
			if (context.isError || !image || !context.showImages) return row;

			// ponytail: cache decoded screenshot in row state; read file only on first render
			const state = context.state as { img?: { data: string; mime: string } };
			if (!state.img) {
				try {
					// relative paths are CLI-output-relative to session cwd, not process cwd
					const abs = isAbsolute(image) ? image : join(context.cwd, image);
					state.img = {
						data: readFileSync(abs).toString("base64"),
						mime: /\.jpe?g$/i.test(abs) ? "image/jpeg" : "image/png",
					};
				} catch {
					return row;
				}
			}
			const container = new Container();
			container.addChild(row);
			container.addChild(
				new Image(
					state.img.data,
					state.img.mime,
					{ fallbackColor: (s) => theme.fg("muted", s) },
					{ maxWidthCells: 60, maxHeightCells: 20 },
				),
			);
			return container;
		},
	});
}
