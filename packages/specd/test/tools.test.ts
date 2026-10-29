import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { saveSinkSetup } from "../src/sinks/config.js";
import {
	addLink,
	appendEvent,
	createItem,
	history,
	openStore,
} from "../src/store/store.js";
import { buildTaskExport, registerExecTools } from "../src/tools/exec-tools.js";
import { makeStore } from "./helpers.js";

describe("buildTaskExport labels", () => {
	it("includes the spec label when the task is linked part-of a spec", async () => {
		const { store } = await makeStore();
		const spec = createItem(store, {
			kind: "spec",
			title: "Auth Service",
			actor: "test",
		});
		const task = createItem(store, {
			kind: "task",
			title: "Add login",
			actor: "test",
		});
		addLink(store, task.id, spec.id, "part-of");

		const exported = buildTaskExport(store, task);

		expect(exported.labels).toEqual([
			"specd",
			"specd:task",
			"spec:auth-service",
		]);
		expect(exported.body).toContain(spec.id);
	});

	it("only includes the specd label when the task is not linked to a spec", async () => {
		const { store } = await makeStore();
		const task = createItem(store, {
			kind: "task",
			title: "Add login",
			actor: "test",
		});

		const exported = buildTaskExport(store, task);

		expect(exported.labels).toEqual(["specd", "specd:task"]);
	});

	it("does not leak the sink setup's label taxonomy into per-task labels", async () => {
		const { store } = await makeStore();
		saveSinkSetup(
			store,
			{
				workspace: { owner: "o", projectNumber: 1 },
				lanes: ["Backlog"],
				labels: ["specd", "specd:task", "specd:spec", "bug", "area:web"],
				naming: "{ref}: {title}",
			},
			"github",
		);
		const spec = createItem(store, {
			kind: "spec",
			title: "Auth Service",
			actor: "test",
		});
		const task = createItem(store, {
			kind: "task",
			title: "Add login",
			actor: "test",
		});
		addLink(store, task.id, spec.id, "part-of");

		// The taxonomy is repo-wide vocabulary (seeded at configure time);
		// exports assign only contextual labels.
		const exported = buildTaskExport(store, task);

		expect(exported.labels).toEqual([
			"specd",
			"specd:task",
			"spec:auth-service",
		]);
	});

	it("picks a spec deterministically when a task is linked to multiple specs", async () => {
		const { store } = await makeStore();
		const specA = createItem(store, {
			kind: "spec",
			title: "Auth Service",
			actor: "test",
		});
		const specB = createItem(store, {
			kind: "spec",
			title: "Billing Service",
			actor: "test",
		});
		const task = createItem(store, {
			kind: "task",
			title: "Add login",
			actor: "test",
		});
		addLink(store, task.id, specB.id, "part-of");
		addLink(store, task.id, specA.id, "part-of");

		const exported = buildTaskExport(store, task);

		// ids sort alphabetically; the earlier id is chosen deterministically.
		const specLabel = exported.labels.find((l) => l.startsWith("spec:"));
		expect(specLabel).toBe(
			[specA.id, specB.id].sort()[0] === specA.id
				? "spec:auth-service"
				: "spec:billing-service",
		);
	});
});

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

function captureExecTool(name: string): CapturedToolDef {
	const defs: CapturedToolDef[] = [];
	const fakePi = {
		registerTool(def: CapturedToolDef) {
			defs.push(def);
		},
	} as unknown as ExtensionAPI;
	registerExecTools(fakePi);
	const found = defs.find((d) => d.name === name);
	if (!found) throw new Error(`tool ${name} not registered`);
	return found;
}

function initFixtureRepo(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "specd-start-work-"));
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
	execFileSync("git", ["-C", dir, "config", "user.email", "test@fixture"]);
	writeFileSync(join(dir, "README.md"), "# fixture\n");
	execFileSync("git", ["-C", dir, "add", "README.md"]);
	execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

function worktreePath(dir: string, taskId: string): string {
	return join(dirname(dir), `${basename(dir)}-specd-${taskId}`);
}

async function seededFixture(clearChecklist: boolean): Promise<{
	dir: string;
	taskId: string;
	cleanup: () => void;
}> {
	const { dir, cleanup: cleanupRepo } = initFixtureRepo();
	const store = await openStore(dir);
	const cycle = createItem(store, {
		kind: "cycle",
		title: "Cycle",
		actor: "test",
	});
	appendEvent(store, {
		item: cycle.id,
		type: "explore.decided",
		payload: { decision: "go", reason: "ok" },
		actor: "test",
	});
	const spec = createItem(store, {
		kind: "spec",
		title: "Spec",
		body: "Spec body.",
		actor: "test",
	});
	addLink(store, spec.id, cycle.id, "part-of");
	appendEvent(store, { item: spec.id, type: "spec.approved", actor: "test" });
	const plan = createItem(store, {
		kind: "plan",
		title: "Plan",
		body: "Plan body.",
		actor: "test",
	});
	addLink(store, plan.id, spec.id, "part-of");
	const task = createItem(store, {
		kind: "task",
		title: "Add login route",
		body: "Acceptance criteria.",
		pathScope: "src/auth/**",
		actor: "test",
	});
	addLink(store, task.id, spec.id, "part-of");
	const checklist = createItem(store, {
		kind: "checklist",
		title: "Checklist",
		actor: "test",
		extra: { items: ["rate limit is testable"] },
	});
	addLink(store, checklist.id, spec.id, "part-of");
	if (clearChecklist) {
		appendEvent(store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "test",
		});
	}
	store.db.close();
	const taskId = task.id;
	return {
		dir,
		taskId,
		cleanup: () => {
			cleanupRepo();
			const wt = worktreePath(dir, taskId);
			if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
		},
	};
}

async function taskHistory(dir: string, taskId: string) {
	const store = await openStore(dir);
	try {
		return history(store, taskId);
	} finally {
		store.db.close();
	}
}

describe("specd_start_work", () => {
	const tool = () => captureExecTool("specd_start_work");

	it("refuses when the start gate fails and leaves no worktree on disk", async () => {
		const { dir, taskId, cleanup } = await seededFixture(false);
		try {
			const res = await tool().execute(
				"t1",
				{ item: taskId },
				undefined,
				undefined,
				{ cwd: dir } as unknown as ExtensionContext,
			);
			expect(res.content[0]?.text).toMatch(/Start refused/);
			expect(res.content[0]?.text).toMatch(/unchecked item/);
			expect(existsSync(worktreePath(dir, taskId))).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("creates the worktree and records work.started after the gate passes", async () => {
		const { dir, taskId, cleanup } = await seededFixture(true);
		try {
			const res = await tool().execute(
				"t1",
				{ item: taskId },
				undefined,
				undefined,
				{ cwd: dir } as unknown as ExtensionContext,
			);
			const text = res.content[0]?.text ?? "";
			expect(text).toContain("Worktree ready");
			expect(text).toContain(
				'subagent({ agent: "specd-worker", async: true, timeoutMs: 5400000 })',
			);
			expect(text).toMatch(/child gets no specd store tools/i);
			expect(text).toMatch(/parent records all specd events/i);
			expect(res.details?.path).toBe(worktreePath(dir, taskId));
			expect(existsSync(worktreePath(dir, taskId))).toBe(true);
			const events = (await taskHistory(dir, taskId)).filter(
				(e) => e.type === "work.started",
			);
			expect(events.length).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("re-running reuses the existing worktree and does not duplicate work.started", async () => {
		const { dir, taskId, cleanup } = await seededFixture(true);
		try {
			const ctx = { cwd: dir } as unknown as ExtensionContext;
			const first = await tool().execute(
				"t1",
				{ item: taskId },
				undefined,
				undefined,
				ctx,
			);
			expect(first.content[0]?.text).toContain("Worktree ready");
			const wt = worktreePath(dir, taskId);
			expect(existsSync(wt)).toBe(true);

			const second = await tool().execute(
				"t2",
				{ item: taskId },
				undefined,
				undefined,
				ctx,
			);
			expect(second.content[0]?.text).toContain("Reusing");
			expect(second.details?.path).toBe(wt);

			const events = (await taskHistory(dir, taskId)).filter(
				(e) => e.type === "work.started",
			);
			expect(events.length).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("re-running a paused task reuses the existing worktree", async () => {
		const { dir, taskId, cleanup } = await seededFixture(true);
		try {
			const ctx = { cwd: dir } as unknown as ExtensionContext;
			await tool().execute("t1", { item: taskId }, undefined, undefined, ctx);
			const store = await openStore(dir);
			appendEvent(store, {
				item: taskId,
				type: "work.paused",
				payload: { nextStep: "test" },
				actor: "test",
			});
			store.db.close();

			const res = await tool().execute(
				"t2",
				{ item: taskId },
				undefined,
				undefined,
				ctx,
			);
			expect(res.content[0]?.text).toContain("Reusing");
			expect(existsSync(worktreePath(dir, taskId))).toBe(true);
			const events = (await taskHistory(dir, taskId)).filter(
				(e) => e.type === "work.started",
			);
			expect(events.length).toBe(1);
		} finally {
			cleanup();
		}
	});
});
