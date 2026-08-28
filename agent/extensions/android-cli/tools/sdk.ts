import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import {
	androidExec,
	formatExecResult,
	confirmGate,
	toolResult,
	toolError,
} from '../utils.js';

export function registerSdkTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'android_sdk',
		label: 'Android SDK',
		description:
			'Manage Android SDK packages — install, update, remove, and list SDK components.',
		promptSnippet: 'Install, update, remove, or list Android SDK packages',
		promptGuidelines: [
			'Use android_sdk to manage Android SDK packages. Run list first to see available packages before install.',
		],
		parameters: Type.Object({
			action: StringEnum(['install', 'update', 'remove', 'list'] as const),
			packages: Type.Optional(Type.Array(Type.String())),
			channel: Type.Optional(StringEnum(['stable', 'beta', 'canary'] as const)),
			pattern: Type.Optional(Type.String()),
			allVersions: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { action, packages, channel, pattern, allVersions } = params;
			const channelArgs =
				channel === 'beta'
					? ['--beta']
					: channel === 'canary'
						? ['--canary']
						: [];

			switch (action) {
				case 'install': {
					if (!packages?.length) {
						return toolError('packages required for install');
					}
					const granted = await confirmGate(
						ctx,
						'Install SDK packages',
						`Install: ${packages.join(', ')}`,
					);
					if (!granted) return toolError('Cancelled by user');
					const result = await androidExec(
						pi,
						['sdk', 'install', ...packages, ...channelArgs],
						{ signal },
					);
					return toolResult(formatExecResult(result));
				}

				case 'update': {
					const target = packages?.length ? packages.join(', ') : 'all';
					const granted = await confirmGate(
						ctx,
						'Update SDK packages',
						`Update: ${target}`,
					);
					if (!granted) return toolError('Cancelled by user');
					const args = ['sdk', 'update', ...(packages ?? []), ...channelArgs];
					const result = await androidExec(pi, args, { signal });
					return toolResult(formatExecResult(result));
				}

				case 'remove': {
					if (!packages?.length) {
						return toolError('packages required for remove');
					}
					const granted = await confirmGate(
						ctx,
						'Remove SDK packages',
						`Remove: ${packages.join(', ')}`,
					);
					if (!granted) return toolError('Cancelled by user');
					const result = await androidExec(pi, ['sdk', 'remove', ...packages], {
						signal,
					});
					return toolResult(formatExecResult(result));
				}

				case 'list': {
					const args = ['sdk', 'list'];
					if (pattern) args.push(pattern);
					if (allVersions) args.push('--all-versions');
					args.push(...channelArgs);
					const result = await androidExec(pi, args, { signal });
					return toolResult(formatExecResult(result));
				}
			}
		},
	});
}
