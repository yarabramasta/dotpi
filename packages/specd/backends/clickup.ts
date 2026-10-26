import type { SpecdStore } from "../store/store.js";
import { readSinkConfig } from "./config.js";
import type {
	ProjectPlan,
	SinkAdapter,
	SinkVerify,
	TaskCreated,
	TaskExport,
} from "./contract.js";
import { sinkCredentials } from "./credentials.js";
import {
	type HttpRunner,
	httpError,
	parseBody,
	realHttpRunner,
} from "./http.js";

export interface ClickUpSinkConfig {
	/** Workspace (team) id — needed for tag creation and task URLs. */
	teamId: string;
	/** Space id — tags are space-scoped. */
	spaceId: string;
	/** The list new tasks land in. */
	listId: string;
	/** specd item status → the sink's workflow state name (D15);
	 * updateStatus maps through it; unmapped states pass through. */
	statusMap?: Record<string, string>;
}

const BASE = "https://api.clickup.com/api/v2";

/** The ClickUp adapter — raw personal-token header (`Authorization: pk_…`,
 * no Bearer). Lanes = the list's statuses; tags = space-level tags. The
 * API cannot create list statuses (UI-only) — ensurePlan bootstraps tags
 * and honestly reports missing lanes as UI-required (dec-0010). */
export function createClickUpAdapter(
	config: ClickUpSinkConfig | undefined,
	run: HttpRunner = realHttpRunner,
): SinkAdapter {
	const creds = sinkCredentials("clickup");
	const key = creds.present.key;

	async function call<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T | undefined> {
		const res = await run({
			method,
			url: `${BASE}${path}`,
			headers: { Authorization: key },
			...(body !== undefined ? { body } : {}),
		});
		if (res.status >= 400) throw httpError(`ClickUp ${method} ${path}`, res);
		return parseBody<T>(res);
	}

	return {
		id: "clickup",

		isConfigured(): Promise<boolean> {
			return Promise.resolve(
				Boolean(key && config?.teamId && config?.spaceId && config?.listId),
			);
		},

		async verify(): Promise<SinkVerify> {
			try {
				if (!key) {
					return {
						ok: false,
						detail:
							"CLICKUP_API_TOKEN not set (env or ~/.pi/agent/auth.json) — /spec connect clickup.",
					};
				}
				const list = await call<{ name?: string }>(
					"GET",
					`/list/${config?.listId}`,
				);
				return {
					ok: Boolean(list?.name),
					detail: list?.name
						? `Token works; list "${list.name}" reachable.`
						: `List ${config?.listId} not reachable with this token (revoked tokens fail silently — re-onboard if unsure).`,
				};
			} catch (error) {
				return {
					ok: false,
					detail: `ClickUp is not reachable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async createTask(task: TaskExport): Promise<TaskCreated> {
			if (!config?.listId || !config?.teamId) {
				throw new Error(
					"ClickUp sink needs workspace ids (team, space, list) — set them in the project plan (/spec plan).",
				);
			}
			const created = await call<{
				id?: string;
				url?: string;
			}>("POST", `/list/${config.listId}/task`, {
				name: task.title,
				markdown_content: task.body,
				...(task.labels.length > 0 ? { tags: task.labels } : {}),
			});
			if (!created?.id) {
				throw new Error("ClickUp task create did not return a task id.");
			}
			return {
				externalRef: created.id,
				url:
					created.url ??
					`https://app.clickup.com/t/${config.teamId}/${created.id}`,
			};
		},

		async readBack(externalRef: string): Promise<{ state: string }> {
			const task = await call<{
				date_closed?: string | null;
				status?: { status?: string };
			}>("GET", `/task/${externalRef}`);
			return { state: task?.date_closed ? "closed" : "open" };
		},

		async placeInLane(externalRef: string, lane: string): Promise<void> {
			await call("PUT", `/task/${externalRef}`, { status: lane });
		},

		async updateStatus(externalRef: string, state: string): Promise<void> {
			const mapped = config?.statusMap?.[state] ?? state;
			return this.placeInLane?.(externalRef, mapped);
		},

		async setTags(externalRef: string, tags: string[]): Promise<void> {
			for (const tag of tags) {
				await call(
					"POST",
					`/task/${externalRef}/tag/${encodeURIComponent(tag)}`,
				);
			}
		},

		async previewPlan(plan: ProjectPlan): Promise<string[]> {
			if (!config?.spaceId) {
				throw new Error(
					"ClickUp sink needs a space id before planning — set it in the project plan interview.",
				);
			}
			const tags = await call<Array<{ name?: string }>>(
				"GET",
				`/space/${config.spaceId}/tag`,
			);
			const haveTags = new Set(
				(tags ?? []).map((t) => (t.name ?? "").toLowerCase()),
			);
			const changes: string[] = [];
			for (const label of plan.labels) {
				if (!haveTags.has(label.toLowerCase()))
					changes.push(`create tag "${label}"`);
			}
			// ponytail: list statuses are UI-config in ClickUp (no v2 API);
			// lane parity is documented as a manual step instead of fake reads.
			changes.push(
				`verify list statuses exist for lanes (${plan.lanes.join(", ")}) — ClickUp has no statuses API; create them in the list's status settings`,
			);
			return changes;
		},

		async ensurePlan(plan: ProjectPlan): Promise<string[]> {
			// Empty-kanban rule, graded: tags bootstrap; statuses honestly
			// can't (no API) — they are reported, never silently skipped.
			const changes: string[] = [];
			const tags = await call<Array<{ name?: string }>>(
				"GET",
				`/space/${config?.spaceId}/tag`,
			);
			const haveTags = new Set(
				(tags ?? []).map((t) => (t.name ?? "").toLowerCase()),
			);
			for (const label of plan.labels) {
				if (!haveTags.has(label.toLowerCase())) {
					await call("POST", `/space/${config?.spaceId}/tag`, {
						name: label,
					});
					changes.push(`created tag "${label}"`);
				}
			}
			changes.push(
				`lanes (${plan.lanes.join(", ")}) need list statuses created in the ClickUp UI — the API cannot create them`,
			);
			return changes;
		},
	};
}

/** Build the ClickUp sink config from the stored project plan / sink config. */
export function clickupConfigFrom(
	store: SpecdStore,
): ClickUpSinkConfig | undefined {
	const raw = readSinkConfig(store, "sink.clickup");
	if (!raw?.teamId || !raw?.spaceId || !raw?.listId) return undefined;
	return {
		teamId: String(raw.teamId),
		spaceId: String(raw.spaceId),
		listId: String(raw.listId),
	};
}
