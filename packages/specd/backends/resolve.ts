import type { SpecdStore } from "../store/store.js";
import { clickupConfigFrom, createClickUpAdapter } from "./clickup.js";
import { readProjectPlan, readSinkConfig } from "./config.js";
import type { SinkAdapter } from "./contract.js";
import { createGithubAdapter } from "./github.js";
import { createJiraAdapter, jiraConfigFrom } from "./jira.js";
import { createLinearAdapter, linearConfigFrom } from "./linear.js";
import { createNotionAdapter, notionConfigFrom } from "./notion.js";
import { createNullSink } from "./null.js";
import { createTrelloAdapter, trelloConfigFrom } from "./trello.js";

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
				statusMap: readProjectPlan(store)?.statusMap,
			});
		}
		case "linear": {
			const config = linearConfigFrom(store);
			return config
				? createLinearAdapter({
						...config,
						statusMap: readProjectPlan(store)?.statusMap,
					})
				: undefined;
		}
		case "jira": {
			const config = jiraConfigFrom(store);
			return config
				? createJiraAdapter({
						...config,
						statusMap: readProjectPlan(store)?.statusMap,
					})
				: undefined;
		}
		case "notion": {
			const config = notionConfigFrom(store);
			return config
				? createNotionAdapter({
						...config,
						statusMap: readProjectPlan(store)?.statusMap,
					})
				: undefined;
		}
		case "trello": {
			const config = trelloConfigFrom(store);
			return config
				? createTrelloAdapter({
						...config,
						statusMap: readProjectPlan(store)?.statusMap,
					})
				: undefined;
		}
		case "clickup": {
			const config = clickupConfigFrom(store);
			return config
				? createClickUpAdapter({
						...config,
						statusMap: readProjectPlan(store)?.statusMap,
					})
				: undefined;
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
	const known = [
		"null",
		"github",
		"linear",
		"jira",
		"notion",
		"trello",
		"clickup",
	];
	if (!known.includes(sink)) {
		throw new Error(
			`Unknown sink: ${sink}. Ported sinks: ${known.join(", ")}. Guided setup: /spec connect <sink>.`,
		);
	}
	throw new Error(
		`Sink "${sink}" is not configured yet. Its workspace ids (team/board/database/list) live in the project plan — run /spec plan, or /spec connect ${sink} for guided setup.`,
	);
}
