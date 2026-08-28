import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
	androidExec,
	formatExecResult,
	confirmGate,
	toolResult,
	toolError,
} from '../utils.js';

export function registerRunTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'android_run',
		label: 'Run Android App',
		description:
			'Deploy an Android application (APK) to a connected device or emulator.',
		promptSnippet: 'Deploy APK to device or emulator',
		promptGuidelines: [
			'Use android_run to deploy built APKs to connected devices or emulators. Requires APK paths.',
		],
		parameters: Type.Object({
			apks: Type.String({ description: 'Comma-separated APK file paths' }),
			device: Type.Optional(
				Type.String({ description: 'Device serial number' }),
			),
			activity: Type.Optional(
				Type.String({ description: 'Activity to launch' }),
			),
			debug: Type.Optional(
				Type.Boolean({ description: 'Deploy in debug mode' }),
			),
			type: Type.Optional(
				Type.String({
					description:
						'Component type: ACTIVITY, SERVICE, WATCH_FACE, TILE, COMPLICATION',
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const granted = await confirmGate(
				ctx,
				'Deploy APK',
				`Deploy ${params.apks} to ${params.device || 'default device'}?`,
			);
			if (!granted) return toolError('Cancelled by user');

			const args = ['run', `--apks=${params.apks}`];
			if (params.device) args.push(`--device=${params.device}`);
			if (params.activity) args.push(`--activity=${params.activity}`);
			if (params.debug) args.push('--debug');
			if (params.type) args.push(`--type=${params.type}`);

			const result = await androidExec(pi, args, { signal });
			return toolResult(formatExecResult(result));
		},
	});
}
