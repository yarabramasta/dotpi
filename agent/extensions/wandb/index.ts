type ProviderRequestEvent = {
	payload: Record<string, string | number | boolean | null>;
};
type ProviderRequestContext = {
	model?: { provider?: string };
	sessionManager: { getSessionId(): string };
};
interface ExtensionAPI {
	registerProvider(providerId: string, config: { baseUrl?: string }): void;
	on(
		event: "before_provider_request",
		handler: (
			event: ProviderRequestEvent,
			ctx: ProviderRequestContext,
		) => unknown,
	): void;
}

export default function (pi: ExtensionAPI) {
	const baseUrl = process.env.WANDB_API_BASE_URL;
	if (baseUrl) pi.registerProvider("wandb", { baseUrl });

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "wandb") return;

		// W&B uses automatic prefix caching; session salt isolates cache reuse.
		return { ...event.payload, cache_salt: ctx.sessionManager.getSessionId() };
	});
}
