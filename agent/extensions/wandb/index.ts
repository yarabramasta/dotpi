type ProviderRequestEvent = {
	payload: Record<string, string | number | boolean | null>;
};
type ProviderRequestContext = {
	model?: { provider?: string };
	sessionManager: { getSessionId(): string };
};
interface ExtensionAPI {
	on(
		event: "before_provider_request",
		handler: (
			event: ProviderRequestEvent,
			ctx: ProviderRequestContext,
		) => unknown,
	): void;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "wandb") return;

		// W&B uses automatic prefix caching; session salt isolates cache reuse.
		return { ...event.payload, cache_salt: ctx.sessionManager.getSessionId() };
	});
}
