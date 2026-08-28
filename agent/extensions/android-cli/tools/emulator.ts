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

export function registerEmulatorTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'android_emulator',
		label: 'Android Emulator',
		description:
			'Manage Android virtual devices (AVDs) — create, start, stop, list, and remove emulators.',
		promptSnippet:
			'Create, start, stop, list, or remove Android virtual devices',
		promptGuidelines: [
			'Use android_emulator to manage Android virtual devices for testing.',
		],
		parameters: Type.Object({
			action: StringEnum(
				['create', 'start', 'stop', 'list', 'remove'] as const,
				{ description: 'Action to perform on the emulator.' },
			),
			device: Type.Optional(
				Type.String({ description: 'Device name or serial number.' }),
			),
			profile: Type.Optional(
				Type.String({
					description:
						'Device profile for create action (default: medium_phone).',
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { action, device, profile } = params;

			if (action === 'list') {
				const result = await androidExec(pi, ['emulator', 'list'], { signal });
				return toolResult(formatExecResult(result));
			}

			if (action === 'create') {
				const confirmed = await confirmGate(
					ctx,
					'Create AVD',
					`Create new AVD${device ? ` "${device}"` : ''}${profile ? ` with profile "${profile}"` : ''}?`,
				);
				if (!confirmed) return toolError('Cancelled by user');

				const args = ['emulator', 'create'];
				if (device) args.push(device);
				if (profile) args.push(`--profile=${profile}`);
				const result = await androidExec(pi, args, { signal });
				return toolResult(formatExecResult(result));
			}

			if (!device) {
				return toolError(
					`Device name or serial number required for "${action}" action.`,
				);
			}

			if (action === 'remove') {
				const confirmed = await confirmGate(
					ctx,
					'Remove AVD',
					`Remove AVD "${device}"?`,
				);
				if (!confirmed) return toolError('Cancelled by user');

				const result = await androidExec(pi, ['emulator', 'remove', device], {
					signal,
				});
				return toolResult(formatExecResult(result));
			}

			if (action === 'start') {
				const result = await androidExec(pi, ['emulator', 'start', device], {
					signal,
				});
				return toolResult(formatExecResult(result));
			}

			if (action === 'stop') {
				const result = await androidExec(pi, ['emulator', 'stop', device], {
					signal,
				});
				return toolResult(formatExecResult(result));
			}

			return toolError(`Unknown action: ${action}`);
		},
	});
}
