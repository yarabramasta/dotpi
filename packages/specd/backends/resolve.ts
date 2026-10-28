import type { SpecdStore } from "../src/store/store.js";
import { readSinkConfig, readSinkSetup } from "./config.js";
import type { SinkAdapter } from "./contract.js";
import { createGithubAdapter } from "./github.js";
import { createNullSink } from "./null.js";

/** Adapter resolution: the single place that maps a vendor-neutral sink id
 * to its adapter, using the stored per-sink config (meta `sink.<id>`) and
 * the developer's credentials. */

/** undefined when the sink is unknown or its config is not stored yet. */
export function tryResolveAdapter(
	store: SpecdStore,
	sink: string,
): SinkAdapter | undefined {
	switch (sink) {
		case "null":
			return createNullSink();
		case "github": {
			const config = readSinkConfig(store, "sink.github");
			if (!config?.owner || !config.projectNumber) return undefined;
			return createGithubAdapter(store.cwd, {
				owner: String(config.owner),
				projectNumber: Number(config.projectNumber),
				statusMap: readSinkSetup(store)?.statusMap,
			});
		}
		default:
			return undefined;
	}
}

/** Throwing variant with plain-language guidance for the agent. */
export function resolveAdapter(store: SpecdStore, sink: string): SinkAdapter {
	const adapter = tryResolveAdapter(store, sink);
	if (adapter) return adapter;
	if (sink === "github") {
		throw new Error(
			"GitHub sink is not configured yet. Tell me the project owner and project number (and optionally a lane) so I can store them — e.g. pass github_owner + github_project_number to specd_export once, and they persist for every later export. For guided setup run /spec connect github.",
		);
	}
	const known = ["null", "github"];
	if (!known.includes(sink)) {
		throw new Error(
			`Unknown sink: ${sink}. Ported sinks: ${known.join(", ")}. Guided setup: /spec connect <sink>.`,
		);
	}
	throw new Error(
		`Sink "${sink}" is not configured yet. Its workspace ids (team/board/database/list) live in the sink setup — run /spec sink, or /spec connect ${sink} for guided setup.`,
	);
}
