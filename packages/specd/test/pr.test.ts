import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openPr, watchChecks } from "../src/sinks/github/pr.js";
import type { GhRunner } from "../src/sinks/github/runner.js";
import { appendEvent, createItem, history } from "../src/store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

/** Offline contract tests for the PR seam (plan-0006 slice 2): review-gate
 * reuse (D4/F2), octocat argv shape (--body-file), idempotent re-open,
 * and the exit-code → check-state mapping (D3: 0 pass / 1 fail / 8 pending). */

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
			expect(events.some((e) => e.type === "pr.created")).toBe(true);
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
			expect(events.some((e) => e.type === "pr.created")).toBe(true);
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
});
