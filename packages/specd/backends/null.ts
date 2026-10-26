import type {
	SinkSetup,
	SinkAdapter,
	SinkVerify,
	TaskCreated,
	TaskExport,
} from "./contract.js";

/** The null sink: project management entirely inside the specd store. The
 * vendor-neutral floor of the tier model — no external platform at all. */
export function createNullSink(): SinkAdapter {
	const adapter: SinkAdapter = {
		id: "null",
		isConfigured: async () => true,
		verify: async (): Promise<SinkVerify> => ({
			ok: true,
			detail: "native store; nothing to configure.",
		}),
		createTask: async (task: TaskExport): Promise<TaskCreated> => ({
			externalRef: task.ref,
			url: "",
		}),
		readBack: async () => ({ state: "native" }),
		// The null sink has no external board: a plan is always converged.
		previewPlan: async (_plan: SinkSetup): Promise<string[]> => [],
		ensurePlan: async (_plan: SinkSetup): Promise<string[]> => [],
	};
	return adapter;
}
