import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import {
	androidExec,
	formatExecResult,
	toolResult,
	toolError,
} from '../utils.js';

export function registerDocsTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'android_docs',
		label: 'Android Docs',
		description:
			'Search and fetch Android documentation from the official Android Knowledge Base.',
		promptSnippet: 'Search or fetch official Android documentation',
		promptGuidelines: [
			'Use android_docs search before giving Android development advice to access the official Android Knowledge Base. Use fetch with kb:// URLs from search results.',
		],
		parameters: Type.Object({
			action: StringEnum(['search', 'fetch'] as const),
			query: Type.String({
				description: 'Search query or kb:// URL to fetch',
			}),
		}),
		async execute(_toolCallId, params, signal) {
			const { action, query } = params;

			if (!query.trim()) {
				return toolError('query is required');
			}

			switch (action) {
				case 'search': {
					const result = await androidExec(
						pi,
						['docs', 'search', `'${query}'`],
						{ signal },
					);
					return toolResult(formatExecResult(result));
				}

				case 'fetch': {
					const result = await androidExec(pi, ['docs', 'fetch', query], {
						signal,
					});
					return toolResult(formatExecResult(result));
				}
			}
		},
	});
}
