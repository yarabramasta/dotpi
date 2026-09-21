import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const baseUrl = process.env.WANDB_API_BASE_URL;
	if (baseUrl) pi.registerProvider("wandb", { baseUrl });

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "wandb") return;

		// W&B uses automatic prefix caching; session salt isolates cache reuse.
		const payload = event.payload as Record<string, unknown>;
		return { ...payload, cache_salt: ctx.sessionManager.getSessionId() };
	});
}
