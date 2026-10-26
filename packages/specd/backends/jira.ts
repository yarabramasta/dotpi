import type { SpecdStore } from "../store/store.js";
import { readSinkConfig } from "./config.js";
import type {
	SinkSetup,
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

export interface JiraSinkConfig {
	/** The Jira project (key like "ENG") tasks are created in. */
	projectKey: string;
	/** Issue type name for created tasks (default "Task"). */
	issueTypeName?: string;
	/** specd item status → the Jira status name to transition to (D15);
	 * updateStatus maps through it; unmapped states pass through. */
	statusMap?: Record<string, string>;
}

/** Minimal markdown → Atlassian Document Format. Line-based: `#` headings,
 * `- ` bullets, everything else a paragraph; inline markdown is stripped
 * to plain text (graded parity — upgrade only if bodies need fidelity). */
export function markdownToAdf(markdown: string): Record<string, unknown> {
	const paragraphs: Array<Record<string, unknown>> = [];
	const bulletItems: Array<Record<string, unknown>> = [];
	const flushBullets = () => {
		if (bulletItems.length > 0) {
			paragraphs.push({
				type: "bulletList",
				content: [...bulletItems],
			});
			bulletItems.length = 0;
		}
	};
	for (const rawLine of markdown.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line.trim()) {
			flushBullets();
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
		const text = (s: string) => s.replace(/[*_`]/g, "");
		if (heading) {
			flushBullets();
			paragraphs.push({
				type: "heading",
				attrs: { level: heading[1]?.length ?? 1 },
				content: [{ type: "text", text: text(heading[2] ?? "") }],
			});
		} else if (bullet) {
			bulletItems.push({
				type: "listItem",
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: text(bullet[1] ?? "") }],
					},
				],
			});
		} else {
			flushBullets();
			paragraphs.push({
				type: "paragraph",
				content: [{ type: "text", text: text(line) }],
			});
		}
	}
	flushBullets();
	return {
		type: "doc",
		version: 1,
		content: paragraphs.length > 0 ? paragraphs : [],
	};
}

/** The Jira adapter — REST v3, Basic auth (email + API token). Lanes =
 * workflow statuses moved via transitions, tags = free-form labels.
 * Company-managed workflow columns can't be created from the API, so
 * ensurePlan is a no-op and previewPlan reports what the Jira UI needs
 * (dec-0010, honest gap). */
export function createJiraAdapter(
	config: JiraSinkConfig | undefined,
	run: HttpRunner = realHttpRunner,
): SinkAdapter {
	const creds = sinkCredentials("jira");
	const host = (creds.present.host ?? "").replace(/\/+$/, "");
	const auth = `Basic ${Buffer.from(
		`${creds.present.email ?? ""}:${creds.present.key ?? ""}`,
	).toString("base64")}`;

	async function call<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T | undefined> {
		const res = await run({
			method,
			url: `${host}/rest/api/3${path}`,
			headers: { Authorization: auth },
			...(body !== undefined ? { body } : {}),
		});
		if (res.status >= 400) throw httpError(`Jira ${method} ${path}`, res);
		return parseBody<T>(res);
	}

	return {
		id: "jira",

		isConfigured(): Promise<boolean> {
			return Promise.resolve(
				Boolean(
					creds.present.host &&
						creds.present.email &&
						creds.present.key &&
						config?.projectKey,
				),
			);
		},

		async verify(): Promise<SinkVerify> {
			try {
				if (!creds.present.host || !creds.present.email || !creds.present.key) {
					return {
						ok: false,
						detail:
							"JIRA_HOST / JIRA_EMAIL / JIRA_API_TOKEN not set (env or ~/.pi/agent/auth.json) — /spec connect jira.",
					};
				}
				const me = await call<{ displayName?: string }>("GET", "/myself");
				const project = await call<{ name?: string }>(
					"GET",
					`/project/${config?.projectKey ?? ""}`,
				);
				return {
					ok: Boolean(me?.displayName && project?.name),
					detail:
						me?.displayName && project?.name
							? `Authenticated as ${me.displayName}; project "${project.name}" reachable.`
							: "Credentials or project not reachable — check the token (they expire after 1–365 days).",
				};
			} catch (error) {
				return {
					ok: false,
					detail: `Jira is not reachable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async createTask(task: TaskExport): Promise<TaskCreated> {
			if (!config?.projectKey) {
				throw new Error(
					"Jira sink needs a project key — set it in the sink setup (/spec sink).",
				);
			}
			const created = await call<{ key?: string }>("POST", "/issue", {
				fields: {
					project: { key: config.projectKey },
					issuetype: { name: config.issueTypeName ?? "Task" },
					summary: task.title,
					description: markdownToAdf(task.body),
					...(task.labels.length > 0 ? { labels: task.labels } : {}),
				},
			});
			if (!created?.key) {
				throw new Error("Jira issue create did not return an issue key.");
			}
			return {
				externalRef: created.key,
				url: `${host}/browse/${created.key}`,
			};
		},

		async readBack(externalRef: string): Promise<{ state: string }> {
			const issue = await call<{
				fields?: {
					status?: { statusCategory?: { key?: string } };
				};
			}>("GET", `/issue/${externalRef}?fields=status`);
			const category = issue?.fields?.status?.statusCategory?.key;
			return { state: category === "Done" ? "closed" : "open" };
		},

		async placeInLane(externalRef: string, lane: string): Promise<void> {
			const transitions = await call<{
				transitions?: Array<{
					id?: string;
					name?: string;
					to?: { name?: string };
				}>;
			}>("GET", `/issue/${externalRef}/transitions`);
			const options = transitions?.transitions ?? [];
			const match = options.find(
				(t) =>
					t.name?.toLowerCase() === lane.toLowerCase() ||
					t.to?.name?.toLowerCase() === lane.toLowerCase(),
			);
			if (!match?.id) {
				throw new Error(
					`Jira has no transition to "${lane}" for ${externalRef}. Available: ${
						options
							.map((t) => t.to?.name ?? t.name)
							.filter(Boolean)
							.join(", ") || "none"
					}. Board columns are workflow statuses — align the plan lanes with the project's workflow.`,
				);
			}
			await call("POST", `/issue/${externalRef}/transitions`, {
				transition: { id: match.id },
			});
		},

		async updateStatus(externalRef: string, state: string): Promise<void> {
			const mapped = config?.statusMap?.[state] ?? state;
			return this.placeInLane?.(externalRef, mapped);
		},

		async setTags(externalRef: string, tags: string[]): Promise<void> {
			await call("PUT", `/issue/${externalRef}`, {
				fields: { labels: tags },
			});
		},

		async previewPlan(plan: SinkSetup): Promise<string[]> {
			if (!config?.projectKey) {
				throw new Error(
					"Jira sink needs a project key before planning — set it in the sink setup interview.",
				);
			}
			const types = await call<Array<{ statuses?: Array<{ name?: string }> }>>(
				"GET",
				`/project/${config.projectKey}/statuses`,
			);
			const have = new Set<string>();
			for (const t of types ?? []) {
				for (const s of t.statuses ?? []) {
					if (s.name) have.add(s.name.toLowerCase());
				}
			}
			const changes: string[] = [];
			for (const lane of plan.lanes) {
				if (!have.has(lane.toLowerCase())) {
					changes.push(
						`create workflow status "${lane}" in the Jira project (workflow columns are admin work — the API cannot create them)`,
					);
				}
			}
			// Labels are free-form strings in Jira — nothing to bootstrap.
			return changes;
		},

		async ensurePlan(_plan: SinkSetup): Promise<string[]> {
			// Workflow columns are admin work in Jira (company-managed
			// projects); previewPlan reports exactly what the UI needs.
			return [];
		},
	};
}

/** Build the Jira sink config from the stored sink setup / sink config. */
export function jiraConfigFrom(store: SpecdStore): JiraSinkConfig | undefined {
	const raw = readSinkConfig(store, "sink.jira");
	if (!raw?.projectKey) return undefined;
	return {
		projectKey: String(raw.projectKey),
		issueTypeName:
			typeof raw.issueTypeName === "string" ? raw.issueTypeName : undefined,
	};
}
