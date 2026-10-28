import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	androidExec,
	formatExecResult,
	partialRow,
	resultRow,
	rowHead,
	runAndroid,
	short,
	toolResult,
	tryParseJson,
} from "../utils.js";

export function registerProjectCreateTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_project_create",
		label: "Create Android Project",
		description: "Create a new Android project from a template.",
		promptSnippet: "Scaffold a new Android project from a template",
		promptGuidelines: [
			"Use android_project_create to scaffold new Android projects. Run with listTemplates=true first to see available templates.",
		],
		parameters: Type.Object({
			name: Type.String(),
			template: Type.Optional(Type.String()),
			output: Type.Optional(Type.String()),
			minSdk: Type.Optional(Type.String()),
			listTemplates: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (params.listTemplates) {
				const result = await androidExec(pi, ["create", "--list"], { signal });
				return toolResult(formatExecResult(result));
			}

			const args = ["create", `--name=${params.name}`];
			if (params.output) args.push(`--output=${params.output}`);
			if (params.template) args.push(params.template);
			if (params.minSdk) args.push(`--minSdk=${params.minSdk}`);

			const result = await runAndroid(pi, args, {
				signal,
				status: `creating ${short(params.name, 32)}…`,
				ctx,
				onUpdate,
			});
			return toolResult(formatExecResult(result));
		},
		renderCall(args, theme) {
			const head = rowHead(
				theme,
				"android_project_create",
				args.listTemplates ? "list templates" : args.name,
			);
			if (args.template && !args.listTemplates) {
				return new Text(`${head} ${theme.fg("dim", args.template)}`, 0, 0);
			}
			return new Text(head, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) {
				return partialRow(
					theme,
					`creating ${short(context.args.name ?? "", 32)}…`,
				);
			}
			return resultRow(
				theme,
				!context.isError,
				context.args.listTemplates
					? "templates"
					: `project ${context.args.name}`,
				result,
				{ expanded, hint: true },
			);
		},
	});
}

export function registerProjectDescribeTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "android_project_describe",
		label: "Describe Android Project",
		description:
			"Analyze an Android project to generate descriptive metadata including build targets and artifact locations.",
		promptSnippet: "Analyze Android project structure and build targets",
		promptGuidelines: [
			"Use android_project_describe to understand an Android project's structure before building or deploying.",
		],
		parameters: Type.Object({
			projectDir: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const args = ["describe"];
			if (params.projectDir) args.push(`--project_dir=${params.projectDir}`);

			const result = await runAndroid(pi, args, {
				signal,
				status: "analyzing project…",
				ctx,
				onUpdate,
			});
			const parsed = tryParseJson(result.stdout);

			if (parsed && typeof parsed === "object") {
				return toolResult(
					formatExecResult(result),
					parsed as Record<string, unknown>,
				);
			}

			return toolResult(formatExecResult(result));
		},
		renderCall(args, theme) {
			return new Text(
				rowHead(
					theme,
					"android_project_describe",
					args.projectDir ? short(args.projectDir) : undefined,
				),
				0,
				0,
			);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return partialRow(theme, "analyzing project…");
			return resultRow(theme, !context.isError, "project analyzed", result, {
				expanded,
				hint: true,
			});
		},
	});
}
