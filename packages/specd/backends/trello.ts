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

export interface TrelloSinkConfig {
	/** The board whose lists (lanes) and labels this sink uses. */
	boardId: string;
	/** Optional: the list new cards land in before lane placement. */
	listId?: string;
}

const BASE = "https://api.trello.com/1";

/** The Trello adapter — plain REST with key+token query auth. Lanes =
 * board lists (native kanban), tags = board labels, card state = archived
 * flag (a card's "state" is which list it sits in). */
export function createTrelloAdapter(
	config: TrelloSinkConfig | undefined,
	run: HttpRunner = realHttpRunner,
): SinkAdapter {
	const creds = sinkCredentials("trello");

	function url(path: string, params: Record<string, string> = {}): string {
		const q = new URLSearchParams({
			key: creds.present.key ?? "",
			token: creds.present.token ?? "",
			...params,
		});
		return `${BASE}${path}?${q.toString()}`;
	}

	async function call<T>(
		method: string,
		path: string,
		params: Record<string, string> = {},
	): Promise<T | undefined> {
		const res = await run({ method, url: url(path, params) });
		if (res.status >= 400) throw httpError(`Trello ${method} ${path}`, res);
		return parseBody<T>(res);
	}

	async function boardLists(): Promise<Array<{ id: string; name: string }>> {
		const lists = await call<Array<{ id: string; name: string }>>(
			"GET",
			`/boards/${config?.boardId}/lists`,
			{ fields: "id,name" },
		);
		return lists ?? [];
	}

	async function boardLabels(): Promise<Array<{ id: string; name: string }>> {
		const labels = await call<Array<{ id: string; name: string }>>(
			"GET",
			`/boards/${config?.boardId}/labels`,
			{ fields: "id,name" },
		);
		return (labels ?? []).filter((l) => l.name);
	}

	async function listIdFor(lane: string): Promise<string> {
		const lists = await boardLists();
		const list = lists.find((l) => l.name.toLowerCase() === lane.toLowerCase());
		if (!list) {
			throw new Error(
				`Trello list "${lane}" not found on board ${config?.boardId}. Apply the project plan (/spec plan) first.`,
			);
		}
		return list.id;
	}

	/** Trello: resolve label ids, creating any that don't exist yet — the
	 * github reference adapter ensures labels per export (spec:slug labels
	 * appear with the first export), so ports must too. */
	async function ensureLabelIds(tags: string[]): Promise<string[]> {
		if (tags.length === 0) return [];
		const labels = await boardLabels();
		const byName = new Map(
			labels.map((l) => [l.name.toLowerCase(), l.id] as const),
		);
		for (const tag of tags) {
			if (byName.has(tag.toLowerCase())) continue;
			const created = await call<{ id?: string }>(
				"POST",
				`/boards/${config?.boardId}/labels`,
				{ name: tag },
			);
			if (created?.id) byName.set(tag.toLowerCase(), created.id);
		}
		return tags
			.map((t) => byName.get(t.toLowerCase()))
			.filter((id): id is string => Boolean(id));
	}

	return {
		id: "trello",

		isConfigured(): Promise<boolean> {
			return Promise.resolve(
				Boolean(creds.present.key && creds.present.token && config?.boardId),
			);
		},

		async verify(): Promise<SinkVerify> {
			try {
				if (!creds.present.key || !creds.present.token) {
					return {
						ok: false,
						detail:
							"TRELLO_KEY / TRELLO_TOKEN not set (env or ~/.pi/agent/auth.json) — /spec connect trello.",
					};
				}
				const board = await call<{ name?: string }>(
					"GET",
					`/boards/${config?.boardId}`,
					{ fields: "name" },
				);
				return {
					ok: Boolean(board?.name),
					detail: board?.name
						? `Credentials work; board "${board.name}" reachable.`
						: `Board ${config?.boardId} not reachable with this token.`,
				};
			} catch (error) {
				return {
					ok: false,
					detail: `Trello is not reachable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async createTask(task: TaskExport): Promise<TaskCreated> {
			if (!config?.boardId) {
				throw new Error(
					"Trello sink needs a board id — set it in the project plan (/spec plan).",
				);
			}
			let idList = config.listId;
			if (!idList) {
				const lists = await boardLists();
				idList = lists[0]?.id;
				if (!idList) {
					throw new Error(
						`Board ${config.boardId} has no lists yet — apply the project plan (/spec plan) to create the lane lists.`,
					);
				}
			}
			const labelIds = await ensureLabelIds(task.labels);
			const params: Record<string, string> = {
				idList,
				name: task.title,
				desc: task.body,
			};
			if (labelIds.length > 0) params.idLabels = labelIds.join(",");
			const card = await call<{ id?: string; shortUrl?: string; url?: string }>(
				"POST",
				"/cards",
				params,
			);
			if (!card?.id) {
				throw new Error("Trello card create did not return a card id.");
			}
			return {
				externalRef: card.id,
				url: card.shortUrl ?? card.url ?? `https://trello.com/c/${card.id}`,
			};
		},

		async readBack(externalRef: string): Promise<{ state: string }> {
			const card = await call<{ closed?: boolean }>(
				"GET",
				`/cards/${externalRef}`,
				{ fields: "closed" },
			);
			return { state: card?.closed ? "closed" : "open" };
		},

		async placeInLane(externalRef: string, lane: string): Promise<void> {
			const idList = await listIdFor(lane);
			await call("PUT", `/cards/${externalRef}`, { idList });
		},

		async updateStatus(externalRef: string, state: string): Promise<void> {
			return this.placeInLane?.(externalRef, state);
		},

		async setTags(externalRef: string, tags: string[]): Promise<void> {
			const idLabels = await ensureLabelIds(tags);
			await call("PUT", `/cards/${externalRef}`, {
				idLabels: idLabels.join(","),
			});
		},

		async previewPlan(plan: ProjectPlan): Promise<string[]> {
			if (!config?.boardId) {
				throw new Error(
					"Trello sink needs a board id before planning — set it in the project plan interview.",
				);
			}
			const [lists, labels] = await Promise.all([boardLists(), boardLabels()]);
			const haveLists = new Set(lists.map((l) => l.name.toLowerCase()));
			const haveLabels = new Set(labels.map((l) => l.name.toLowerCase()));
			const changes: string[] = [];
			for (const lane of plan.lanes) {
				if (!haveLists.has(lane.toLowerCase()))
					changes.push(`create list "${lane}"`);
			}
			for (const label of plan.labels) {
				if (!haveLabels.has(label.toLowerCase()))
					changes.push(`create label "${label}"`);
			}
			return changes;
		},

		async ensurePlan(plan: ProjectPlan): Promise<string[]> {
			// Empty-kanban rule: a workspace without the structure is
			// bootstrapped, not refused.
			const changes: string[] = [];
			const before = await this.previewPlan?.(plan);
			for (const change of before ?? []) {
				const lane = /create list "(.+)"/.exec(change)?.[1];
				const label = /create label "(.+)"/.exec(change)?.[1];
				if (lane) {
					await call("POST", "/lists", {
						name: lane,
						idBoard: config?.boardId ?? "",
					});
					changes.push(`created list "${lane}"`);
				} else if (label) {
					await call("POST", `/boards/${config?.boardId}/labels`, {
						name: label,
					});
					changes.push(`created label "${label}"`);
				}
			}
			return changes;
		},
	};
}

/** Build the Trello sink config from the stored project plan / sink config. */
export function trelloConfigFrom(
	store: SpecdStore,
): TrelloSinkConfig | undefined {
	const raw = readSinkConfig(store, "sink.trello");
	if (!raw?.boardId) return undefined;
	return {
		boardId: String(raw.boardId),
		listId: typeof raw.listId === "string" ? raw.listId : undefined,
	};
}
