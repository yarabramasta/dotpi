import { readFile } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { saveSinkSetup } from "../src/sinks/config.js";
import type { SinkAdapter } from "../src/sinks/contract.js";
import { openPr, watchChecks } from "../src/sinks/github/pr.js";
import { type GhRunner, realGhRunner } from "../src/sinks/github/runner.js";
import { tryResolveAdapter } from "../src/sinks/resolve.js";
import * as sync from "../src/sinks/sync.js";
import { appendEvent, createItem, history } from "../src/store/store.js";
import { registerPrTools } from "../src/tools/pr-tools.js";
import { makeStore, type TestStore } from "./helpers.js";

vi.mock("../src/sinks/github/runner.js", () => ({
	realGhRunner: vi.fn(),
}));

vi.mock("../src/sinks/resolve.js", () => ({
	tryResolveAdapter: vi.fn(),
}));

const mockRunner = vi.mocked(realGhRunner);
const mockTryResolveAdapter = vi.mocked(tryResolveAdapter);

/** Offline contract tests for the PR seam (plan-0006 slice 2): review-gate
 * reuse (D4/F2), octocat argv shape (--body-file), idempotent re-open,
 * and the exit-code → check-state mapping (D3: 0 pass / 1 fail / 8 pending). */

interface CapturedToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	}>;
}

function capturePrTool(name: string): CapturedToolDef {
	const defs: CapturedToolDef[] = [];
	const fakePi = {
		registerTool(def: CapturedToolDef) {
			defs.push(def);
		},
	} as unknown as ExtensionAPI;
	registerPrTools(fakePi);
	const found = defs.find((d) => d.name === name);
	if (!found) throw new Error(`tool ${name} not registered`);
	return found;
}

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

interface PrState {
	defaultBranch?: string;
	existing?: { number: number; url: string };
	log: string[][];
	/** Captured content of the --body-file handed to gh pr create. */
	bodyViaFile?: string;
}

function prRunner(state: PrState): GhRunner {
	return async (args, _cwd) => {
		state.log.push([...args]);
		const joined = args.join(" ");
		if (joined.startsWith("pr list")) {
			return {
				stdout: JSON.stringify(state.existing ? [state.existing] : []),
				stderr: "",
			};
		}
		if (joined.startsWith("repo view")) {
			return {
				stdout: JSON.stringify({
					defaultBranchRef: { name: state.defaultBranch ?? "main" },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("pr create")) {
			const i = args.indexOf("--body-file");
			if (i >= 0 && typeof args[i + 1] === "string") {
				state.bodyViaFile = await readFile(args[i + 1] as string, "utf8");
			}
			return { stdout: "https://github.com/acme/app/pull/7\n", stderr: "" };
		}
		return { stdout: "{}", stderr: "" };
	};
}

/** A task with a passing review — the minimum that satisfies the reused
 * completion gate. No extra.type: ccTypeOf defaults to feat, which also
 * exercises the naming defaults. */
async function reviewedTask(store: TestStore["store"]): Promise<string> {
	const item = createItem(store, {
		kind: "task",
		title: "Add login route",
		pathScope: "src/auth",
		actor: "test",
	});
	appendEvent(store, {
		item: item.id,
		type: "review.completed",
		payload: { passed: true, findings: [] },
		actor: "test",
	});
	return item.id;
}

describe("openPr (review-gated PR creation)", () => {
	it("creates the PR with derived base, conventional title, and body via --body-file", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			const state: PrState = { log: [] };
			const result = await openPr(ts.store, prRunner(state), "/repo", {
				taskId,
			});
			expect(result).toEqual({
				branch: "specd/feat/task-0001-add-login-route",
				created: true,
				number: "7",
				url: "https://github.com/acme/app/pull/7",
			});
			const events = history(ts.store, taskId);
			const prCreated = events.find((e) => e.type === "pr.created");
			expect(prCreated).toBeDefined();
			expect(JSON.parse(prCreated?.payload ?? "{}")).toEqual({
				url: "https://github.com/acme/app/pull/7",
				branch: "specd/feat/task-0001-add-login-route",
			});
			const completed = events.filter((e) => e.type === "work.completed");
			expect(completed.length).toBe(1);
			expect(JSON.parse(completed[0]?.payload ?? "{}")).toEqual({
				pr: "https://github.com/acme/app/pull/7",
			});
			const create = state.log.find((a) => a[0] === "pr" && a[1] === "create");
			expect(create).toContain("--base");
			expect(create).toContain("main");
			expect(create).toContain("--head");
			expect(create).toContain("specd/feat/task-0001-add-login-route");
			expect(create).toContain("--title");
			expect(create).toContain("feat(auth): add login route");
			// octocat practice: body travels via --body-file, never argv.
			expect(state.bodyViaFile).toBe("Add login route");
			expect(
				create?.some((a) => a.includes("Add login route") && a !== "--title"),
			).toBe(false);
		} finally {
			ts.cleanup();
		}
	});

	it("refuses without a passing review (the work.completed gate, reused)", async () => {
		const ts = await makeStore();
		try {
			const item = createItem(ts.store, {
				kind: "task",
				title: "No review yet",
				actor: "test",
			});
			await expect(
				openPr(ts.store, prRunner({ log: [] }), "/repo", { taskId: item.id }),
			).rejects.toThrow(/no review yet/);
		} finally {
			ts.cleanup();
		}
	});

	it("refuses when the latest review did not pass", async () => {
		const ts = await makeStore();
		try {
			const item = createItem(ts.store, {
				kind: "task",
				title: "Failed review",
				actor: "test",
			});
			appendEvent(ts.store, {
				item: item.id,
				type: "review.completed",
				payload: { passed: false, findings: ["boom"] },
				actor: "test",
			});
			await expect(
				openPr(ts.store, prRunner({ log: [] }), "/repo", { taskId: item.id }),
			).rejects.toThrow(/did not pass/);
		} finally {
			ts.cleanup();
		}
	});

	it("returns the existing PR instead of creating a duplicate and still records pr.created + work.completed", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			const state: PrState = {
				existing: {
					number: 5,
					url: "https://github.com/acme/app/pull/5",
				},
				log: [],
			};
			const result = await openPr(ts.store, prRunner(state), "/repo", {
				taskId,
			});
			expect(result).toEqual({
				branch: "specd/feat/task-0001-add-login-route",
				created: false,
				number: "5",
				url: "https://github.com/acme/app/pull/5",
			});
			expect(state.log.some((a) => a[0] === "pr" && a[1] === "create")).toBe(
				false,
			);
			const events = history(ts.store, taskId);
			const prCreated = events.find((e) => e.type === "pr.created");
			expect(prCreated).toBeDefined();
			expect(JSON.parse(prCreated?.payload ?? "{}")).toEqual({
				url: "https://github.com/acme/app/pull/5",
				branch: "specd/feat/task-0001-add-login-route",
			});
			const completed = events.filter((e) => e.type === "work.completed");
			expect(completed.length).toBe(1);
			expect(JSON.parse(completed[0]?.payload ?? "{}")).toEqual({
				pr: "https://github.com/acme/app/pull/5",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("honors a base override and skips default-branch resolution", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			const state: PrState = { log: [] };
			await openPr(ts.store, prRunner(state), "/repo", {
				taskId,
				base: "develop",
			});
			expect(state.log.some((a) => a[0] === "repo" && a[1] === "view")).toBe(
				false,
			);
			const create = state.log.find((a) => a[0] === "pr" && a[1] === "create");
			expect(create).toContain("develop");
		} finally {
			ts.cleanup();
		}
	});

	it("appends a Closes # trailer for a task exported to an issue number", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			appendEvent(ts.store, {
				item: taskId,
				type: "task.exported",
				payload: { sink: "github", externalRef: "42" },
				actor: "test",
			});
			const state: PrState = { log: [] };
			await openPr(ts.store, prRunner(state), "/repo", { taskId });
			expect(state.bodyViaFile).toBe("Add login route\n\nCloses #42");
			const prCreated = history(ts.store, taskId).find(
				(e) => e.type === "pr.created",
			);
			expect(JSON.parse(prCreated?.payload ?? "{}")).toEqual({
				url: "https://github.com/acme/app/pull/7",
				branch: "specd/feat/task-0001-add-login-route",
				issue: "42",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("omits the Closes trailer when the task was never exported", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			const state: PrState = { log: [] };
			await openPr(ts.store, prRunner(state), "/repo", { taskId });
			expect(state.bodyViaFile).toBe("Add login route");
			const prCreated = history(ts.store, taskId).find(
				(e) => e.type === "pr.created",
			);
			expect(JSON.parse(prCreated?.payload ?? "{}")).toEqual({
				url: "https://github.com/acme/app/pull/7",
				branch: "specd/feat/task-0001-add-login-route",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("omits the Closes trailer when exported to a non-issue sink", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			appendEvent(ts.store, {
				item: taskId,
				type: "task.exported",
				payload: { sink: "null", externalRef: taskId },
				actor: "test",
			});
			const state: PrState = { log: [] };
			await openPr(ts.store, prRunner(state), "/repo", { taskId });
			expect(state.bodyViaFile).toBe("Add login route");
			const prCreated = history(ts.store, taskId).find(
				(e) => e.type === "pr.created",
			);
			expect(JSON.parse(prCreated?.payload ?? "{}")).toEqual({
				url: "https://github.com/acme/app/pull/7",
				branch: "specd/feat/task-0001-add-login-route",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("appends the trailer to a custom summary body", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			appendEvent(ts.store, {
				item: taskId,
				type: "task.exported",
				payload: { sink: "github", externalRef: "7" },
				actor: "test",
			});
			const state: PrState = { log: [] };
			await openPr(ts.store, prRunner(state), "/repo", {
				taskId,
				summary: "Custom summary body",
			});
			expect(state.bodyViaFile).toBe("Custom summary body\n\nCloses #7");
			const prCreated = history(ts.store, taskId).find(
				(e) => e.type === "pr.created",
			);
			expect(JSON.parse(prCreated?.payload ?? "{}")).toEqual({
				url: "https://github.com/acme/app/pull/7",
				branch: "specd/feat/task-0001-add-login-route",
				issue: "7",
			});
		} finally {
			ts.cleanup();
		}
	});
});

describe("watchChecks (single non-blocking poll, D3)", () => {
	async function seededTask(): Promise<{
		store: TestStore["store"];
		id: string;
		cleanup: () => void;
	}> {
		const ts = await makeStore();
		const id = await reviewedTask(ts.store);
		return { store: ts.store, id, cleanup: ts.cleanup };
	}

	it("maps exit 0 to passed", async () => {
		const ts = await seededTask();
		try {
			const runner: GhRunner = async () => ({
				stdout: JSON.stringify([{ name: "build", bucket: "pass" }]),
				stderr: "",
			});
			expect(await watchChecks(ts.store, runner, "/repo", ts.id)).toEqual({
				failing: [],
				state: "passed",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("maps exit 1 to failed and names the failing checks", async () => {
		const ts = await seededTask();
		try {
			const runner: GhRunner = async () => {
				throw Object.assign(new Error("Command failed: gh pr checks"), {
					code: 1,
					stdout: JSON.stringify([
						{ name: "build", bucket: "pass" },
						{ name: "lint", bucket: "fail" },
						{ name: "test", bucket: "fail" },
					]),
				});
			};
			expect(await watchChecks(ts.store, runner, "/repo", ts.id)).toEqual({
				failing: ["lint", "test"],
				state: "failed",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("maps exit 8 to pending without throwing", async () => {
		const ts = await seededTask();
		try {
			const runner: GhRunner = async () => {
				throw Object.assign(new Error("Command failed: gh pr checks"), {
					code: 8,
					stdout: JSON.stringify([{ name: "build", bucket: "pending" }]),
				});
			};
			expect(await watchChecks(ts.store, runner, "/repo", ts.id)).toEqual({
				failing: [],
				state: "pending",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("surfaces gh's stderr for non-check exit codes (e.g. no PR yet)", async () => {
		const ts = await seededTask();
		try {
			const runner: GhRunner = async () => {
				throw Object.assign(new Error("Command failed: gh pr checks"), {
					code: 128,
					stderr: "no pull requests found for branch specd/feat/x",
				});
			};
			await expect(
				watchChecks(ts.store, runner, "/repo", ts.id),
			).rejects.toThrow(/no pull requests found/);
		} finally {
			ts.cleanup();
		}
	});

	it("maps exit 1 with 'no checks reported' to pending (no CI configured)", async () => {
		const ts = await seededTask();
		try {
			const runner: GhRunner = async () => {
				throw Object.assign(new Error("Command failed: gh pr checks"), {
					code: 1,
					stdout: "no checks reported",
				});
			};
			expect(await watchChecks(ts.store, runner, "/repo", ts.id)).toEqual({
				failing: [],
				state: "pending",
			});
		} finally {
			ts.cleanup();
		}
	});

	it("maps exit 1 with 'no checks reported' on stderr to pending (no CI configured)", async () => {
		const ts = await seededTask();
		try {
			const runner: GhRunner = async () => {
				throw Object.assign(new Error("Command failed: gh pr checks"), {
					code: 1,
					stdout: "",
					stderr:
						"no checks reported on the 'specd/feat/task-0001-add-login-route' branch",
				});
			};
			expect(await watchChecks(ts.store, runner, "/repo", ts.id)).toEqual({
				failing: [],
				state: "pending",
			});
		} finally {
			ts.cleanup();
		}
	});
});

describe("openPr Closes-trailer edge cases", () => {
	it("uses the latest export event when multiple exports exist", async () => {
		const ts = await makeStore();
		try {
			const taskId = await reviewedTask(ts.store);
			appendEvent(ts.store, {
				item: taskId,
				type: "task.exported",
				payload: { sink: "github", externalRef: "1" },
				actor: "test",
			});
			appendEvent(ts.store, {
				item: taskId,
				type: "task.exported",
				payload: { sink: "github", externalRef: "99" },
				actor: "test",
			});
			const state: PrState = { log: [] };
			await openPr(ts.store, prRunner(state), "/repo", { taskId });
			expect(state.bodyViaFile).toBe("Add login route\n\nCloses #99");
		} finally {
			ts.cleanup();
		}
	});
});

describe("syncExportedTasks merge reconcile", () => {
	it("records pr.merged and pushes the mapped Done lane when the PR merged", async () => {
		const ts = await makeStore();
		try {
			saveSinkSetup(
				ts.store,
				{
					workspace: { owner: "acme", projectNumber: 1 },
					lanes: ["Backlog", "Ready", "In progress", "In review", "Done"],
					labels: [],
					naming: "",
					statusMap: { done: "Completed", "in-review": "Review" },
				},
				"github",
			);
			const taskId = await reviewedTask(ts.store);
			appendEvent(ts.store, {
				item: taskId,
				type: "task.exported",
				payload: { sink: "github", externalRef: "42" },
				actor: "test",
			});
			appendEvent(ts.store, {
				item: taskId,
				type: "pr.created",
				payload: {
					url: "https://github.com/acme/app/pull/7",
					branch: "specd/feat/task-0001-add-login-route",
				},
				actor: "test",
			});
			appendEvent(ts.store, {
				item: taskId,
				type: "work.completed",
				payload: { pr: "https://github.com/acme/app/pull/7" },
				actor: "test",
			});
			const updateStatus = vi.fn().mockResolvedValue(undefined);
			mockTryResolveAdapter.mockReturnValue({
				readBack: vi.fn().mockResolvedValue({ state: "open" }),
				readPrState: vi.fn().mockResolvedValue("merged"),
				updateStatus,
			} as unknown as SinkAdapter);
			const synced = await sync.syncExportedTasks(ts.store);
			expect(synced).toBe(1);
			expect(
				history(ts.store, taskId).some((e) => e.type === "pr.merged"),
			).toBe(true);
			expect(updateStatus).toHaveBeenCalledTimes(1);
			expect(updateStatus).toHaveBeenCalledWith("42", "Completed");
		} finally {
			ts.cleanup();
		}
	});

	it("honors the in-review pseudo-state before the PR merges", async () => {
		const ts = await makeStore();
		try {
			saveSinkSetup(
				ts.store,
				{
					workspace: { owner: "acme", projectNumber: 1 },
					lanes: ["Backlog", "Ready", "In progress", "In review", "Done"],
					labels: [],
					naming: "",
					statusMap: { done: "Completed", "in-review": "Review" },
				},
				"github",
			);
			const taskId = await reviewedTask(ts.store);
			appendEvent(ts.store, {
				item: taskId,
				type: "task.exported",
				payload: { sink: "github", externalRef: "42" },
				actor: "test",
			});
			appendEvent(ts.store, {
				item: taskId,
				type: "pr.created",
				payload: {
					url: "https://github.com/acme/app/pull/7",
					branch: "specd/feat/task-0001-add-login-route",
				},
				actor: "test",
			});
			appendEvent(ts.store, {
				item: taskId,
				type: "work.completed",
				payload: { pr: "https://github.com/acme/app/pull/7" },
				actor: "test",
			});
			const updateStatus = vi.fn().mockResolvedValue(undefined);
			mockTryResolveAdapter.mockReturnValue({
				readBack: vi.fn().mockResolvedValue({ state: "open" }),
				readPrState: vi.fn().mockResolvedValue("open"),
				updateStatus,
			} as unknown as SinkAdapter);
			await sync.syncExportedTasks(ts.store);
			expect(updateStatus).not.toHaveBeenCalled();
		} finally {
			ts.cleanup();
		}
	});
});

describe("specd_watch_checks triggers best-effort reconcile", () => {
	async function seededExportedTask(
		store: TestStore["store"],
	): Promise<string> {
		const taskId = await reviewedTask(store);
		appendEvent(store, {
			item: taskId,
			type: "task.exported",
			payload: { sink: "github", externalRef: "42" },
			actor: "test",
		});
		return taskId;
	}

	it("runs syncExportedTasks after a successful check poll", async () => {
		const ts = await makeStore();
		try {
			const taskId = await seededExportedTask(ts.store);
			mockRunner.mockResolvedValue({
				stdout: JSON.stringify([{ name: "test", bucket: "pass" }]),
				stderr: "",
			});
			const spy = vi.spyOn(sync, "syncExportedTasks").mockResolvedValue(1);
			const tool = capturePrTool("specd_watch_checks");
			const result = await tool.execute(
				"t1",
				{ item: taskId },
				undefined,
				undefined,
				fakeCtx(ts.dir),
			);
			expect(result.content[0]?.text).toMatch(/CI checks passed/);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			ts.cleanup();
		}
	});

	it("isolates sync failures from the check poll result", async () => {
		const ts = await makeStore();
		try {
			const taskId = await seededExportedTask(ts.store);
			mockRunner.mockResolvedValue({
				stdout: JSON.stringify([{ name: "test", bucket: "pass" }]),
				stderr: "",
			});
			const spy = vi
				.spyOn(sync, "syncExportedTasks")
				.mockRejectedValue(new Error("sink unreachable"));
			const tool = capturePrTool("specd_watch_checks");
			await expect(
				tool.execute(
					"t1",
					{ item: taskId },
					undefined,
					undefined,
					fakeCtx(ts.dir),
				),
			).resolves.toMatchObject({
				content: [{ type: "text", text: expect.stringContaining("passed") }],
			});
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			ts.cleanup();
		}
	});
});
