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

export interface NotionSinkConfig {
	/** The database (data source) tasks are written into. */
	databaseId: string;
	/** specd item status → the sink's workflow state name (D15);
	 * updateStatus maps through it; unmapped states pass through. */
	statusMap?: Record<string, string>;
}

const BASE = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

interface NotionPropertySchema {
	id?: string;
	name?: string;
	type?: string;
	status?: {
		options?: Array<{
			id?: string;
			name?: string;
			group?: { name?: string } | string;
		}>;
	};
	multi_select?: { options?: Array<{ id?: string; name?: string }> };
}

interface NotionSchema {
	properties?: Record<string, NotionPropertySchema>;
}

/** The Notion adapter — database rows as tasks. Lanes = the database's
 * status property options, tags = the multi-select property, body =
 * paragraph blocks. Status/multi-select options ARE API-writable
 * (PATCH database with the complete retained list) — only the group
 * layout itself stays UI-managed. */
export function createNotionAdapter(
	config: NotionSinkConfig | undefined,
	run: HttpRunner = realHttpRunner,
): SinkAdapter {
	const creds = sinkCredentials("notion");
	const key = creds.present.key;

	async function call<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T | undefined> {
		const res = await run({
			method,
			url: `${BASE}${path}`,
			headers: {
				Authorization: `Bearer ${key}`,
				"Notion-Version": VERSION,
			},
			...(body !== undefined ? { body } : {}),
		});
		if (res.status >= 400) throw httpError(`Notion ${method} ${path}`, res);
		return parseBody<T>(res);
	}

	async function schema(): Promise<NotionSchema> {
		return (
			(await call<NotionSchema>("GET", `/databases/${config?.databaseId}`)) ??
			{}
		);
	}

	/** The status property is looked up by TYPE (any name), the tag
	 * property likewise — the plan never hardcodes Notion column names. */
	function findProps(s: NotionSchema): {
		status: string | undefined;
		statusOptions: Array<{ name: string; group?: string }>;
		tags: string | undefined;
		tagOptions: string[];
	} {
		let status: string | undefined;
		let statusOptions: Array<{ name: string; group?: string }> = [];
		let tags: string | undefined;
		let tagOptions: string[] = [];
		for (const [name, prop] of Object.entries(s.properties ?? {})) {
			if (prop.type === "status") {
				status ??= name;
				statusOptions = (prop.status?.options ?? []).map((o) => ({
					name: o.name ?? "",
					group:
						typeof o.group === "string"
							? o.group
							: (o.group?.name ?? undefined),
				}));
			}
			if (prop.type === "multi_select") {
				tags ??= name;
				tagOptions = (prop.multi_select?.options ?? []).map(
					(o) => o.name ?? "",
				);
			}
		}
		return { status, statusOptions, tags, tagOptions };
	}

	/** Body markdown degrades to plain paragraph blocks (graded parity). */
	function paragraphBlocks(body: string): Array<{
		object: string;
		type: string;
		paragraph: {
			rich_text: Array<{ type: string; text: { content: string } }>;
		};
	}> {
		return body
			.split(/\n{2,}/)
			.map((chunk) => chunk.trim())
			.filter(Boolean)
			.slice(0, 90)
			.map((chunk) => ({
				object: "block",
				type: "paragraph",
				paragraph: {
					rich_text: [{ type: "text", text: { content: chunk } }],
				},
			}));
	}

	return {
		id: "notion",

		isConfigured(): Promise<boolean> {
			return Promise.resolve(Boolean(key && config?.databaseId));
		},

		async verify(): Promise<SinkVerify> {
			try {
				if (!key) {
					return {
						ok: false,
						detail:
							"NOTION_API_TOKEN not set (env or ~/.pi/agent/auth.json) — /spec connect notion.",
					};
				}
				const db = await call<{
					title?: Array<{ plain_text?: string }>;
				}>("GET", `/databases/${config?.databaseId}`);
				const name = db?.title?.map((t) => t.plain_text ?? "").join("");
				return {
					ok: Boolean(db),
					detail: name
						? `Token works; database "${name}" reachable (make sure it is shared with the integration).`
						: `Database ${config?.databaseId} not reachable — is it shared with this integration?`,
				};
			} catch (error) {
				return {
					ok: false,
					detail: `Notion is not reachable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async createTask(task: TaskExport): Promise<TaskCreated> {
			if (!config?.databaseId) {
				throw new Error(
					"Notion sink needs a database id — set it in the project plan (/spec sink).",
				);
			}
			const s = await schema();
			const props = findProps(s);
			if (!props.status) {
				throw new Error(
					`Database ${config.databaseId} has no status property — add one (Notion UI or the project plan apply), then re-export.`,
				);
			}
			const properties: Record<string, unknown> = {
				title: { title: [{ text: { content: task.title } }] },
				[props.status]: { status: { name: task.labels[0] } },
			};
			if (props.tags && task.labels.length > 0) {
				properties[props.tags] = {
					multi_select: task.labels.map((name) => ({ name })),
				};
			}
			const page = await call<{ id?: string; url?: string }>("POST", "/pages", {
				parent: { database_id: config.databaseId },
				properties,
				children: paragraphBlocks(task.body),
			});
			if (!page?.id) {
				throw new Error("Notion page create did not return a page id.");
			}
			return {
				externalRef: page.id,
				url: page.url ?? `https://notion.so/${page.id.replace(/-/g, "")}`,
			};
		},

		async readBack(externalRef: string): Promise<{ state: string }> {
			const s = await schema();
			const props = findProps(s);
			if (!props.status) return { state: "open" };
			const page = await call<{
				properties?: Record<
					string,
					{ type?: string; status?: { name?: string } }
				>;
			}>("GET", `/pages/${externalRef}`);
			const statusProp = Object.entries(page?.properties ?? {}).find(
				([, v]) => v.type === "status",
			);
			const current = statusProp?.[1].status?.name;
			if (!current) return { state: "open" };
			const option = props.statusOptions.find(
				(o) => o.name.toLowerCase() === current.toLowerCase(),
			);
			return { state: option?.group === "Complete" ? "closed" : "open" };
		},

		async placeInLane(externalRef: string, lane: string): Promise<void> {
			const s = await schema();
			const props = findProps(s);
			if (!props.status) {
				throw new Error(
					`Database ${config?.databaseId} has no status property — apply the project plan (/spec sink) first.`,
				);
			}
			await call("PATCH", `/pages/${externalRef}`, {
				properties: { [props.status]: { status: { name: lane } } },
			});
		},

		async updateStatus(externalRef: string, state: string): Promise<void> {
			const mapped = config?.statusMap?.[state] ?? state;
			return this.placeInLane?.(externalRef, mapped);
		},

		async setTags(externalRef: string, tags: string[]): Promise<void> {
			const s = await schema();
			const props = findProps(s);
			if (!props.tags) {
				throw new Error(
					`Database ${config?.databaseId} has no multi-select property for tags — apply the project plan (/spec sink) first.`,
				);
			}
			await call("PATCH", `/pages/${externalRef}`, {
				properties: {
					[props.tags]: { multi_select: tags.map((name) => ({ name })) },
				},
			});
		},

		async previewPlan(plan: ProjectPlan): Promise<string[]> {
			if (!config?.databaseId) {
				throw new Error(
					"Notion sink needs a database id before planning — set it in the project plan interview.",
				);
			}
			const props = findProps(await schema());
			const changes: string[] = [];
			if (!props.status) {
				changes.push("create a status property (options become the lanes)");
			}
			for (const lane of plan.lanes) {
				if (
					!props.statusOptions.some(
						(o) => o.name.toLowerCase() === lane.toLowerCase(),
					)
				) {
					changes.push(`add status option "${lane}"`);
				}
			}
			if (!props.tags) {
				changes.push(
					"create a multi-select property (options become the tags)",
				);
			}
			for (const label of plan.labels) {
				if (
					!props.tagOptions.some((o) => o.toLowerCase() === label.toLowerCase())
				) {
					changes.push(`add multi-select option "${label}"`);
				}
			}
			return changes;
		},

		async ensurePlan(plan: ProjectPlan): Promise<string[]> {
			// Empty-kanban rule: a workspace without the structure is
			// bootstrapped, not refused. Status/multi-select updates take the
			// COMPLETE retained option list; new options land in the To-do
			// group (or the first existing group).
			const changes: string[] = [];
			const before = await this.previewPlan?.(plan);
			if (!before || before.length === 0) return [];
			const s = await schema();
			const props = findProps(s);
			const statusName = props.status;
			if (statusName) {
				const existing = props.statusOptions.map((o) => ({
					name: o.name,
					...(o.group ? { group: o.group } : {}),
				}));
				const names = new Set(existing.map((o) => o.name.toLowerCase()));
				const options = [
					...existing,
					...plan.lanes
						.filter((l) => !names.has(l.toLowerCase()))
						.map((name) => ({ name })),
				];
				await call("PATCH", `/databases/${config?.databaseId}`, {
					properties: {
						[statusName]: { name: statusName, status: { options } },
					},
				});
				changes.push(
					...before.filter((c) => c.startsWith("add status option")),
				);
			}
			const tagName = props.tags;
			if (tagName) {
				const existing = props.tagOptions.map((name) => ({ name }));
				const names = new Set(existing.map((o) => o.name.toLowerCase()));
				const options = [
					...existing,
					...plan.labels
						.filter((l) => !names.has(l.toLowerCase()))
						.map((name) => ({ name })),
				];
				await call("PATCH", `/databases/${config?.databaseId}`, {
					properties: {
						[tagName]: { name: tagName, multi_select: { options } },
					},
				});
				changes.push(
					...before.filter((c) => c.startsWith("add multi-select option")),
				);
			}
			for (const change of before) {
				if (change.startsWith("create a ")) {
					changes.push(
						`${change} — Notion API cannot create properties of this kind; add it once in the Notion UI`,
					);
				}
			}
			return changes;
		},
	};
}

/** Build the Notion sink config from the stored project plan / sink config. */
export function notionConfigFrom(
	store: SpecdStore,
): NotionSinkConfig | undefined {
	const raw = readSinkConfig(store, "sink.notion");
	if (!raw?.databaseId) return undefined;
	return { databaseId: String(raw.databaseId) };
}
