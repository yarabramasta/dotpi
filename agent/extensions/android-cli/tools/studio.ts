import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import {
	androidExec,
	formatExecResult,
	tryParseJson,
	toolResult,
	toolError,
} from '../utils.js';

export function registerStudioTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'android_studio',
		label: 'Android Studio',
		description:
			'Interact with running Android Studio instances — analyze files, find declarations/usages, render Compose previews, look up dependency versions.',
		promptSnippet:
			'Bridge to Android Studio for analysis, navigation, previews, and version lookups',
		promptGuidelines: [
			"Use android_studio only when Android Studio is running. Run action 'check' first to verify connection. Use find-declaration and find-usages for code navigation.",
		],
		parameters: Type.Object({
			action: StringEnum([
				'check',
				'analyze-file',
				'find-declaration',
				'find-usages',
				'open-file',
				'render-compose-preview',
				'version-lookup',
			] as const),
			path: Type.Optional(Type.String()),
			symbol: Type.Optional(Type.String()),
			composable: Type.Optional(Type.String()),
			artifacts: Type.Optional(Type.Array(Type.String())),
			pid: Type.Optional(Type.String()),
			project: Type.Optional(Type.String()),
			short: Type.Optional(Type.Boolean()),
			contextFile: Type.Optional(Type.String()),
			outputImageFile: Type.Optional(Type.String()),
			printSemantics: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal) {
			const {
				action,
				path,
				symbol,
				composable,
				artifacts,
				pid,
				project,
				short,
				contextFile,
				outputImageFile,
				printSemantics,
			} = params;

			let args: string[];

			switch (action) {
				case 'check': {
					args = ['studio', 'check'];
					break;
				}

				case 'analyze-file': {
					if (!path) return toolError('path required for analyze-file');
					args = ['studio', 'analyze-file', path];
					break;
				}

				case 'find-declaration': {
					if (!symbol) return toolError('symbol required for find-declaration');
					args = ['studio', 'find-declaration', symbol];
					if (short) args.push('--short');
					if (contextFile) args.push('--context-file', contextFile);
					break;
				}

				case 'find-usages': {
					if (!symbol) return toolError('symbol required for find-usages');
					args = ['studio', 'find-usages', symbol];
					if (short) args.push('--short');
					break;
				}

				case 'open-file': {
					if (!path) return toolError('path required for open-file');
					args = ['studio', 'open-file', path];
					break;
				}

				case 'render-compose-preview': {
					if (!path)
						return toolError('path required for render-compose-preview');
					if (!composable)
						return toolError('composable required for render-compose-preview');
					args = ['studio', 'render-compose-preview', path, composable];
					if (outputImageFile)
						args.push('--output-image-file', outputImageFile);
					if (printSemantics) args.push('--print-semantics');
					break;
				}

				case 'version-lookup': {
					if (!artifacts?.length)
						return toolError('artifacts required for version-lookup');
					args = ['studio', 'version-lookup', ...artifacts];
					break;
				}
			}

			if (pid) args.push('--pid', pid);
			if (project) args.push('--project', project);

			const result = await androidExec(pi, args, { signal });
			const formatted = formatExecResult(result);
			const parsed = tryParseJson(result.stdout);

			if (parsed && typeof parsed === 'object') {
				return toolResult(formatted, parsed as Record<string, unknown>);
			}

			return toolResult(formatted);
		},
	});
}
