import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
	pi.on('before_provider_request', (event, ctx) => {
		if (ctx.model?.provider !== 'wandb') return;

		// W&B uses automatic prefix caching; session salt isolates cache reuse.
		return { ...event.payload, cache_salt: ctx.sessionManager.getSessionId() };
	});
}
