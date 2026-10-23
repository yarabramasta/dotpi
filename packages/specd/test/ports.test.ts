import { afterEach, describe, expect, it } from "vitest";
import { createClickUpAdapter } from "../backends/clickup.js";
import type {
	HttpRequest,
	HttpResponse,
	HttpRunner,
} from "../backends/http.js";
import { realHttpRunner } from "../backends/http.js";
import { createJiraAdapter, markdownToAdf } from "../backends/jira.js";
import { createLinearAdapter } from "../backends/linear.js";
import { createNotionAdapter } from "../backends/notion.js";
import { createTrelloAdapter } from "../backends/trello.js";

/** The contract test suite for the five M2c ports — the same behaviors
 * GitHub passed in backends.test.ts, run offline against canned HTTP
 * responses. A port is done when it passes these (plan-0001 doctrine). */

const TASK = {
	ref: "task-0001",
	title: "Add login route",
	body: "## Acceptance criteria\n- POST /login returns a session",
	labels: ["specd", "spec:auth"],
};

const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
	if (!(name in savedEnv)) savedEnv[name] = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
		delete savedEnv[k];
	}
});

/** json body of a request — fakes receive the raw object the adapter
 * passed (realHttpRunner only stringifies at the network boundary). */
function body<T = Record<string, unknown>>(req: HttpRequest): T {
	const raw = req.body;
	if (typeof raw === "string") return JSON.parse(raw) as T;
	return (raw ?? {}) as T;
}

function ok(body_: unknown, status = 200): HttpResponse {
	return { status, body: JSON.stringify(body_) };
}

/** Linear fake: dispatches on the GraphQL query text. */
function linearRunner(state: {
	labels: Array<{ id: string; name: string }>;
	states: Array<{ id: string; name: string }>;
	issues: Map<string, { stateType: string; stateName: string }>;
}): HttpRunner {
	let n = 0;
	return async (req) => {
		const q = body<{ query: string; variables?: Record<string, unknown> }>(req);
		if (q.query.includes("team(id:")) {
			return ok({ data: { team: { id: "TEAM1", name: "Eng" } } });
		}
		if (q.query.includes("issueLabels")) {
			return ok({ data: { issueLabels: { nodes: state.labels } } });
		}
		if (q.query.includes("workflowStates")) {
			return ok({ data: { workflowStates: { nodes: state.states } } });
		}
		if (q.query.includes("issueCreate")) {
			const input = q.variables?.input as {
				title: string;
				labelIds?: string[];
			};
			n += 1;
			const identifier = `ENG-${n}`;
			state.issues.set(identifier, {
				stateType: "unstarted",
				stateName: "Backlog",
			});
			void input;
			return ok({
				data: {
					issueCreate: {
						success: true,
						issue: {
							identifier,
							url: `https://linear.app/acme/issue/${identifier}`,
						},
					},
				},
			});
		}
		if (q.query.includes("issueUpdate")) {
			const id = q.variables?.id as string;
			const input = q.variables?.input as {
				stateId?: string;
				labelIds?: string[];
			};
			const issue = state.issues.get(id);
			if (!issue) return ok({ data: { issueUpdate: { success: false } } });
			if (input.stateId) {
				const s = state.states.find((x) => x.id === input.stateId);
				if (s) {
					issue.stateName = s.name;
					issue.stateType = s.id === "S_DONE" ? "completed" : "started";
				}
			}
			return ok({ data: { issueUpdate: { success: true } } });
		}
		if (q.query.includes("issueLabelCreate")) {
			const input = q.variables?.input as { name: string; teamId: string };
			const id = `LBL_${state.labels.length + 1}`;
			state.labels.push({ id, name: input.name });
			return ok({ data: { issueLabelCreate: { success: true } } });
		}
		if (q.query.includes("workflowStateCreate")) {
			const input = q.variables?.input as { name: string };
			const id = `ST_${state.states.length + 1}`;
			state.states.push({ id, name: input.name });
			return ok({ data: { workflowStateCreate: { success: true } } });
		}
		if (q.query.includes("issue(id:")) {
			const id = q.variables?.id as string;
			const issue = state.issues.get(id);
			return ok({
				data: {
					issue: { state: { type: issue?.stateType, name: issue?.stateName } },
				},
			});
		}
		return ok({
			errors: [{ message: `unmatched query: ${q.query.slice(0, 60)}` }],
		});
	};
}

describe("linear adapter", () => {
	it("probes, creates, places, tags, reads back, and bootstraps idempotently", async () => {
		setEnv("LINEAR_API_KEY", "lin_api_test");
		const state = {
			labels: [] as Array<{ id: string; name: string }>,
			states: [
				{ id: "S_BACKLOG", name: "Backlog" },
				{ id: "S_DONE", name: "Done" },
			],
			issues: new Map<string, { stateType: string; stateName: string }>(),
		};
		const adapter = createLinearAdapter(
			{ teamId: "TEAM1" },
			linearRunner(state),
		);

		expect(await adapter.isConfigured()).toBe(true);
		const verify = await adapter.verify();
		expect(verify.ok).toBe(true);
		expect(verify.detail).toContain("Eng");

		// Empty-kanban bootstrap: plan lanes/labels created, then converge.
		const plan = {
			workspace: { teamId: "TEAM1" },
			lanes: ["MVP", "Done"],
			labels: ["specd"],
			naming: "specd/{ref} {title}",
		};
		const preview = await adapter.previewPlan?.(plan);
		expect(preview).toContain('create label "specd"');
		expect(preview).toContain('create workflow state "MVP"');
		const changes = (await adapter.ensurePlan?.(plan)) ?? [];
		expect(changes).toContain('created label "specd"');
		expect(changes).toContain('created workflow state "MVP"');
		expect(await adapter.ensurePlan?.(plan)).toEqual([]); // idempotent

		const created = await adapter.createTask(TASK);
		expect(created.externalRef).toBe("ENG-1");
		expect(created.url).toContain("linear.app");

		await adapter.placeInLane?.(created.externalRef, "MVP");
		expect((await adapter.readBack(created.externalRef)).state).toBe("open");
		await adapter.placeInLane?.(created.externalRef, "Done");
		expect((await adapter.readBack(created.externalRef)).state).toBe("closed");
		await adapter.setTags?.(created.externalRef, ["specd"]);
	});

	it("refuses unknown lanes with plain guidance", async () => {
		setEnv("LINEAR_API_KEY", "lin_api_test");
		const state = {
			labels: [],
			states: [{ id: "S_BACKLOG", name: "Backlog" }],
			issues: new Map<string, { stateType: string; stateName: string }>(),
		};
		const adapter = createLinearAdapter(
			{ teamId: "TEAM1" },
			linearRunner(state),
		);
		await expect(adapter.placeInLane?.("ENG-1", "Nope")).rejects.toThrow(
			/workflow state "Nope" not found/,
		);
	});
});

/** Trello fake: dispatches on method + path. */
function trelloRunner(state: {
	lists: Array<{ id: string; name: string }>;
	labels: Array<{ id: string; name: string }>;
	cards: Map<string, { listId: string; closed: boolean; labels: string[] }>;
}): HttpRunner {
	let n = 0;
	return async (req) => {
		const u = new URL(req.url);
		const path = u.pathname;
		const params = Object.fromEntries(u.searchParams.entries());
		if (req.method === "GET" && /^\/1\/boards\/[^/]+$/.test(path)) {
			return ok({ name: "Lair Board" });
		}
		if (req.method === "GET" && path.endsWith("/lists")) {
			return ok(state.lists);
		}
		if (req.method === "GET" && path.endsWith("/labels")) {
			return ok(state.labels);
		}
		if (req.method === "POST" && path === "/1/cards") {
			n += 1;
			const id = `card${n}`;
			state.cards.set(id, {
				listId: params.idList,
				closed: false,
				labels: (params.idLabels ?? "").split(",").filter(Boolean),
			});
			return ok({ id, shortUrl: `https://trello.com/c/${id}` });
		}
		if (req.method === "PUT" && path.startsWith("/1/cards/")) {
			const id = path.split("/")[3];
			const card = state.cards.get(id);
			if (!card) return { status: 404, body: "{}" };
			if (params.idList) card.listId = params.idList;
			if (params.idLabels !== undefined)
				card.labels = params.idLabels.split(",").filter(Boolean);
			return ok({ id });
		}
		if (
			req.method === "GET" &&
			path.startsWith("/1/cards/") &&
			path.endsWith("/list")
		) {
			const id = path.split("/")[3];
			const card = state.cards.get(id);
			const list = state.lists.find((l) => l.id === card?.listId);
			return ok({ id: card?.listId, name: list?.name });
		}
		if (req.method === "GET" && path.startsWith("/1/cards/")) {
			const id = path.split("/")[3];
			const card = state.cards.get(id);
			return ok({ closed: card?.closed ?? false });
		}
		if (req.method === "POST" && path === "/1/lists") {
			const id = `list${state.lists.length + 1}`;
			state.lists.push({ id, name: params.name });
			return ok({ id, name: params.name });
		}
		if (req.method === "POST" && /^\/1\/boards\/[^/]+\/labels$/.test(path)) {
			const id = `label${state.labels.length + 1}`;
			state.labels.push({ id, name: params.name });
			return ok({ id, name: params.name });
		}
		return { status: 404, body: `unmatched ${req.method} ${path}` };
	};
}

describe("trello adapter", () => {
	it("bootstraps lists/labels, creates cards, moves them across lists", async () => {
		setEnv("TRELLO_KEY", "key1");
		setEnv("TRELLO_TOKEN", "token1");
		const state = {
			lists: [] as Array<{ id: string; name: string }>,
			labels: [] as Array<{ id: string; name: string }>,
			cards: new Map<
				string,
				{ listId: string; closed: boolean; labels: string[] }
			>(),
		};
		const adapter = createTrelloAdapter({ boardId: "B1" }, trelloRunner(state));

		const changes =
			(await adapter.ensurePlan?.({
				workspace: { boardId: "B1" },
				lanes: ["MVP", "V1"],
				labels: ["specd"],
				naming: "x",
			})) ?? [];
		expect(changes).toContain('created list "MVP"');
		expect(changes).toContain('created label "specd"');
		expect(
			await adapter.ensurePlan?.({
				workspace: { boardId: "B1" },
				lanes: ["MVP", "V1"],
				labels: ["specd"],
				naming: "x",
			}),
		).toEqual([]);

		const created = await adapter.createTask(TASK);
		expect(created.externalRef).toBe("card1");
		expect(created.url).toContain("trello.com");
		const card = state.cards.get("card1");
		expect(state.lists.find((l) => l.id === card?.listId)?.name).toBe("MVP");

		await adapter.placeInLane?.("card1", "V1");
		expect(state.cards.get("card1")?.listId).toBe(
			state.lists.find((l) => l.name === "V1")?.id,
		);
		expect((await adapter.readBack("card1")).state).toBe("open");
		await adapter.setTags?.("card1", ["specd"]);
		expect(state.cards.get("card1")?.labels).toEqual([
			state.labels.find((l) => l.name === "specd")?.id,
		]);
	});
});

/** Notion fake: schema-driven database + page store. */
function notionRunner(state: {
	statusOptions: Array<{ name: string; group?: string }>;
	tagOptions: Array<{ name: string }>;
	pages: Map<string, { status: string | null; tags: string[] }>;
}): HttpRunner {
	let n = 0;
	const schema = () => ({
		title: [{ plain_text: "Specd DB" }],
		properties: {
			Name: { type: "title", title: {} },
			Status: {
				type: "status",
				status: { options: state.statusOptions },
			},
			Tags: {
				type: "multi_select",
				multi_select: { options: state.tagOptions },
			},
		},
	});
	return async (req) => {
		const path = new URL(req.url).pathname;
		if (req.method === "GET" && path.startsWith("/v1/databases/")) {
			return ok(schema());
		}
		if (req.method === "POST" && path === "/v1/pages") {
			n += 1;
			const id = `page-${String(n).padStart(3, "0")}`;
			const b = body<{
				properties: Record<string, unknown>;
			}>(req);
			const status =
				(b.properties.Status as { status?: { name?: string } } | undefined)
					?.status?.name ?? null;
			const tags = (
				(
					b.properties.Tags as
						| { multi_select?: Array<{ name: string }> }
						| undefined
				)?.multi_select ?? []
			).map((t) => t.name);
			state.pages.set(id, { status, tags });
			return ok({ id, url: `https://notion.so/${id}` });
		}
		if (req.method === "PATCH" && path.startsWith("/v1/pages/")) {
			const id = path.split("/")[3];
			const page = state.pages.get(id);
			if (!page) return { status: 404, body: "{}" };
			const b = body<{ properties: Record<string, unknown> }>(req);
			const status = (
				b.properties.Status as { status?: { name?: string } } | undefined
			)?.status?.name;
			if (status !== undefined) page.status = status;
			const tags = (
				b.properties.Tags as
					| { multi_select?: Array<{ name: string }> }
					| undefined
			)?.multi_select?.map((t) => t.name);
			if (tags) page.tags = tags;
			return ok({ id });
		}
		if (req.method === "GET" && path.startsWith("/v1/pages/")) {
			const id = path.split("/")[3];
			const page = state.pages.get(id);
			if (!page) return { status: 404, body: "{}" };
			return ok({
				properties: {
					Status: { type: "status", status: { name: page.status } },
				},
			});
		}
		if (req.method === "PATCH" && path.startsWith("/v1/databases/")) {
			const b = body<{
				properties: Record<string, unknown>;
			}>(req);
			const status = b.properties.Status as
				| { status?: { options?: Array<{ name: string; group?: string }> } }
				| undefined;
			if (status?.status?.options) {
				state.statusOptions = status.status.options.map((o) => ({
					name: o.name,
					group: o.group,
				}));
			}
			const tags = b.properties.Tags as
				| { multi_select?: { options?: Array<{ name: string }> } }
				| undefined;
			if (tags?.multi_select?.options) {
				state.tagOptions = tags.multi_select.options;
			}
			return ok({ id: "db1" });
		}
		return { status: 404, body: `unmatched ${req.method} ${path}` };
	};
}

describe("notion adapter", () => {
	it("bootstraps status/multi-select options and writes pages by property type", async () => {
		setEnv("NOTION_API_TOKEN", "ntn_test");
		const state = {
			statusOptions: [] as Array<{ name: string; group?: string }>,
			tagOptions: [] as Array<{ name: string }>,
			pages: new Map<string, { status: string | null; tags: string[] }>(),
		};
		const adapter = createNotionAdapter(
			{ databaseId: "db1" },
			notionRunner(state),
		);

		const plan = {
			workspace: { databaseId: "db1" },
			lanes: ["MVP", "Done"],
			labels: ["specd"],
			naming: "x",
		};
		const changes = (await adapter.ensurePlan?.(plan)) ?? [];
		expect(changes).toContain('add status option "MVP"');
		expect(changes).toContain('add multi-select option "specd"');
		expect(state.statusOptions.map((o) => o.name)).toEqual(["MVP", "Done"]);
		expect(state.tagOptions).toEqual([{ name: "specd" }]);
		expect(await adapter.ensurePlan?.(plan)).toEqual([]); // idempotent

		const created = await adapter.createTask(TASK);
		expect(created.externalRef).toBe("page-001");
		const page = state.pages.get("page-001");
		expect(page?.status).toBe("specd"); // first label becomes the status
		expect(page?.tags).toEqual(["specd", "spec:auth"]);

		await adapter.placeInLane?.("page-001", "Done");
		expect((await adapter.readBack("page-001")).state).toBe("open");
		// Group Complete is what makes a lane read back as closed.
		state.statusOptions = state.statusOptions.map((o) =>
			o.name === "Done" ? { name: o.name, group: "Complete" } : o,
		);
		expect((await adapter.readBack("page-001")).state).toBe("closed");
		await adapter.setTags?.("page-001", ["specd"]);
		expect(state.pages.get("page-001")?.tags).toEqual(["specd"]);
	});
});

/** ClickUp fake: list/task/tag store. */
function clickupRunner(state: {
	tags: Array<{ name: string }>;
	tasks: Map<string, { status: string; dateClosed: string | null }>;
}): HttpRunner {
	let n = 0;
	return async (req) => {
		const path = new URL(req.url).pathname.replace(/^\/api/, "");
		if (req.method === "GET" && path === "/v2/list/1") {
			return ok({ name: "Specd List" });
		}
		if (req.method === "POST" && path === "/v2/list/1/task") {
			n += 1;
			const id = `task${n}`;
			const b = body<{ status?: string }>(req);
			state.tasks.set(id, { status: b.status ?? "to do", dateClosed: null });
			return ok({ id, url: `https://app.clickup.com/t/9/${id}` });
		}
		if (req.method === "GET" && path.startsWith("/v2/task/")) {
			const id = path.split("/")[3];
			const t = state.tasks.get(id);
			if (!t) return { status: 404, body: "{}" };
			return ok({
				date_closed: t.dateClosed,
				status: { status: t.status },
			});
		}
		if (req.method === "PUT" && path.startsWith("/v2/task/")) {
			const id = path.split("/")[3];
			const t = state.tasks.get(id);
			if (!t) return { status: 404, body: "{}" };
			const b = body<{ status?: string }>(req);
			if (b.status !== undefined) t.status = b.status;
			return ok({ id });
		}
		if (
			req.method === "GET" &&
			path.startsWith("/v2/space/") &&
			path.endsWith("/tag")
		) {
			return ok(state.tags);
		}
		if (
			req.method === "POST" &&
			path.startsWith("/v2/space/") &&
			path.endsWith("/tag")
		) {
			const b = body<{ name: string }>(req);
			state.tags.push({ name: b.name });
			return ok({ name: b.name });
		}
		if (req.method === "POST" && /\/v2\/task\/[^/]+\/tag\//.test(path)) {
			return ok({});
		}
		return { status: 404, body: `unmatched ${req.method} ${path}` };
	};
}

describe("clickup adapter", () => {
	it("creates markdown tasks, attaches tags, reports statuses as UI-only", async () => {
		setEnv("CLICKUP_API_TOKEN", "pk_test");
		const state = {
			tags: [] as Array<{ name: string }>,
			tasks: new Map<string, { status: string; dateClosed: string | null }>(),
		};
		const adapter = createClickUpAdapter(
			{ teamId: "9", spaceId: "5", listId: "1" },
			clickupRunner(state),
		);

		const verify = await adapter.verify();
		expect(verify.ok).toBe(true);
		expect(verify.detail).toContain("Specd List");

		const changes =
			(await adapter.ensurePlan?.({
				workspace: { teamId: "9", spaceId: "5", listId: "1" },
				lanes: ["MVP"],
				labels: ["specd"],
				naming: "x",
			})) ?? [];
		expect(changes).toContain('created tag "specd"');
		// Honest gap: statuses cannot be created by the API.
		expect(changes.join("\n")).toContain("ClickUp UI");
		// Idempotent: tags converge; the UI note repeats by design.
		expect(
			(
				(await adapter.ensurePlan?.({
					workspace: { teamId: "9", spaceId: "5", listId: "1" },
					lanes: ["MVP"],
					labels: ["specd"],
					naming: "x",
				})) ?? []
			).join("\n"),
		).not.toContain('created tag "specd"');

		const created = await adapter.createTask(TASK);
		expect(created.externalRef).toBe("task1");
		expect((await adapter.readBack("task1")).state).toBe("open");
		await adapter.placeInLane?.("task1", "MVP");
		expect(state.tasks.get("task1")?.status).toBe("MVP");
		await adapter.setTags?.("task1", ["specd"]);
	});
});

/** Jira fake: issues with status category + transitions. */
function jiraRunner(state: {
	transitions: Array<{
		id: string;
		name: string;
		toName: string;
		toCategory: string;
	}>;
	issues: Map<string, { category: string; status: string; labels: string[] }>;
}): HttpRunner {
	let n = 0;
	return async (req) => {
		const u = new URL(req.url);
		const path = u.pathname.replace("/rest/api/3", "");
		if (req.method === "GET" && path === "/myself") {
			return ok({ displayName: "Dev User" });
		}
		if (
			req.method === "GET" &&
			path.startsWith("/project/") &&
			path.endsWith("/statuses")
		) {
			return ok([{ statuses: [{ name: "To Do" }, { name: "Done" }] }]);
		}
		if (req.method === "GET" && path.startsWith("/project/")) {
			return ok({ name: "Engineering" });
		}
		if (req.method === "POST" && path === "/issue") {
			n += 1;
			const key = `ENG-${n}`;
			state.issues.set(key, { category: "To Do", status: "To Do", labels: [] });
			return ok({ key });
		}
		if (
			req.method === "GET" &&
			path.startsWith("/issue/") &&
			path.endsWith("/transitions")
		) {
			return ok({ transitions: state.transitions });
		}
		if (
			req.method === "POST" &&
			path.startsWith("/issue/") &&
			path.endsWith("/transitions")
		) {
			const key = path.split("/")[2];
			const b = body<{ transition: { id: string } }>(req);
			const t = state.transitions.find((x) => x.id === b.transition.id);
			const issue = state.issues.get(key);
			if (!t || !issue) return { status: 400, body: "{}" };
			issue.status = t.toName;
			issue.category = t.toCategory;
			return { status: 204, body: "" };
		}
		if (
			req.method === "GET" &&
			path.startsWith("/issue/") &&
			u.search.includes("fields=labels")
		) {
			const key = path.split("/")[2];
			const issue = state.issues.get(key);
			return ok({ fields: { labels: issue?.labels ?? [] } });
		}
		if (
			req.method === "GET" &&
			path.startsWith("/issue/") &&
			u.search.includes("fields=status")
		) {
			const key = path.split("/")[2];
			const issue = state.issues.get(key);
			return ok({
				fields: { status: { statusCategory: { key: issue?.category } } },
			});
		}
		if (req.method === "PUT" && path.startsWith("/issue/")) {
			const key = path.split("/")[2];
			const issue = state.issues.get(key);
			const b = body<{ fields?: { labels?: string[] } }>(req);
			if (issue && b.fields?.labels) issue.labels = b.fields.labels;
			return { status: 204, body: "" };
		}
		return { status: 404, body: `unmatched ${req.method} ${path}` };
	};
}

describe("jira adapter", () => {
	it("creates issues with ADF descriptions, transitions lanes, and reports workflow gaps", async () => {
		setEnv("JIRA_HOST", "https://acme.atlassian.net");
		setEnv("JIRA_EMAIL", "dev@acme.test");
		setEnv("JIRA_API_TOKEN", "tok");
		const state = {
			transitions: [
				{ id: "31", name: "MVP", toName: "MVP", toCategory: "In Progress" },
				{ id: "41", name: "Done", toName: "Done", toCategory: "Done" },
			],
			issues: new Map<
				string,
				{ category: string; status: string; labels: string[] }
			>(),
		};
		const adapter = createJiraAdapter({ projectKey: "ENG" }, jiraRunner(state));

		const verify = await adapter.verify();
		expect(verify.ok).toBe(true);
		expect(verify.detail).toContain("Engineering");

		const plan = {
			workspace: { projectKey: "ENG" },
			lanes: ["MVP", "Done", "Blocked"],
			labels: ["specd"],
			naming: "x",
		};
		const preview = await adapter.previewPlan?.(plan);
		expect(preview?.join("\n")).toContain('create workflow status "Blocked"');
		// Labels are free-form — nothing to bootstrap; workflow columns are UI work.
		expect(await adapter.ensurePlan?.(plan)).toEqual([]);

		const created = await adapter.createTask(TASK);
		expect(created.externalRef).toBe("ENG-1");
		expect(created.url).toBe("https://acme.atlassian.net/browse/ENG-1");
		expect((await adapter.readBack("ENG-1")).state).toBe("open");

		await adapter.placeInLane?.("ENG-1", "Done");
		expect((await adapter.readBack("ENG-1")).state).toBe("closed");
		await adapter.setTags?.("ENG-1", ["specd"]);
		expect(state.issues.get("ENG-1")?.labels).toEqual(["specd"]);

		await expect(adapter.placeInLane?.("ENG-1", "Nope")).rejects.toThrow(
			/no transition to "Nope"/,
		);
	});

	it("converts markdown to ADF: headings, bullet groups, inline stripping", () => {
		const adf = markdownToAdf(
			"# Acceptance criteria\n- POST /login works\n- `code` stays\n\nPlain **bold** paragraph",
		) as {
			type: string;
			content: Array<{
				type: string;
				attrs?: { level?: number };
				content?: Array<{ type: string; text?: string }>;
			}>;
		};
		expect(adf.type).toBe("doc");
		const [heading, list, paragraph] = adf.content;
		expect(heading?.type).toBe("heading");
		expect(heading?.attrs?.level).toBe(1);
		expect(heading?.content?.[0]?.text).toBe("Acceptance criteria");
		expect(list?.type).toBe("bulletList");
		expect(JSON.stringify(list)).toContain("POST /login works");
		expect(JSON.stringify(list)).not.toContain("`");
		expect(paragraph?.type).toBe("paragraph");
		expect(paragraph?.content?.[0]?.text).toBe("Plain bold paragraph");
	});

	it("refuses non-https or unexpected hosts (allowlisted sink APIs only)", async () => {
		setEnv("JIRA_HOST", "http://internal-host.example");
		setEnv("JIRA_EMAIL", "dev@acme.test");
		setEnv("JIRA_API_TOKEN", "tok");
		const adapter = createJiraAdapter({ projectKey: "ENG" }, realHttpRunner);
		const verify = await adapter.verify();
		expect(verify.ok).toBe(false);
		expect(verify.detail).toContain("not reachable");
	});
});
