import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import {
	androidExec,
	formatExecResult,
	toolResult,
	toolError,
} from '../utils.js';

export function registerScreenTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'android_screen',
		label: 'Android Screen',
		description:
			'Capture device screenshots and resolve UI element coordinates from annotated screenshots.',
		promptSnippet: 'Capture screenshots or resolve UI element coordinates',
		promptGuidelines: [
			'Use android_screen capture to take device screenshots. Use annotate=true then resolve to map UI labels to coordinates for automation.',
		],
		parameters: Type.Object({
			action: StringEnum(['capture', 'resolve'] as const),
			output: Type.Optional(Type.String()),
			annotate: Type.Optional(Type.Boolean()),
			screenshot: Type.Optional(Type.String()),
			string: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal) {
			const { action, output, annotate, screenshot, string } = params;

			switch (action) {
				case 'capture': {
					const args = ['screen', 'capture'];
					if (output) args.push('--output', output);
					if (annotate) args.push('--annotate');
					const result = await androidExec(pi, args, { signal });
					return toolResult(formatExecResult(result));
				}

				case 'resolve': {
					if (!screenshot)
						return toolError('screenshot path required for resolve');
					if (!string)
						return toolError(
							'string with #N placeholders required for resolve',
						);
					const args = [
						'screen',
						'resolve',
						`--screenshot=${screenshot}`,
						`--string=${string}`,
					];
					const result = await androidExec(pi, args, { signal });
					return toolResult(formatExecResult(result));
				}
			}
		},
	});
}
