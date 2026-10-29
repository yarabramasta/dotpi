import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createItem,
	isTaskWorktreeCwd,
	openStore,
} from "../src/store/store.js";
import { registerStoreTools } from "../src/tools/store-tools.js";

vi.mock("../src/sinks/sync.js", () => ({
	syncExportedTasks: vi.fn(async () => {}),
}));

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

function captureStoreTool(name: string): CapturedToolDef {
	const defs: CapturedToolDef[] = [];
	const fakePi = {
		registerTool(def: CapturedToolDef) {
			defs.push(def);
		},
	} as unknown as ExtensionAPI;
	registerStoreTools(fakePi);
	const found = defs.find((d) => d.name === name);
	if (!found) throw new Error(`tool ${name} not registered`);
	return found;
}

/** A plain repo dir (what a parent session runs in) and the worktree dir
 * specd_start_work itself would create for it. */
function parentDir(): string {
	return mkdtempSync(join(tmpdir(), "specd-own-parent-"));
}
function childWorktreeOf(parent: string): string {
	return `${parent}-specd-task-0042`;
}

function fakeCtx(cwd: string): ExtensionContext {
	return { cwd } as unknown as ExtensionContext;
}

async function seededStore(dir: string) {
	const store = await openStore(dir);
	const task = createItem(store, {
		kind: "task",
		title: "Guarded task",
		body: "Body.",
		actor: "test",
	});
	store.db.close();
	return { taskId: task.id };
}

function cleanupDir(dir: string) {
	rmSync(dir, { recursive: true, force: true });
}

describe("specd task-worktree write guard", () => {
	it("detects the worktree convention specd itself creates", () => {
		expect(isTaskWorktreeCwd("/repo/dotpi-specd-task-0009")).toBe(true);
		expect(isTaskWorktreeCwd("/repo/dotpi-specd-spec-0007")).toBe(true);
		expect(isTaskWorktreeCwd("/repo/dotpi")).toBe(false);
		expect(isTaskWorktreeCwd("/repo/dotpi-specd-task-42")).toBe(false);
		expect(isTaskWorktreeCwd("/repo/my-specd-notes")).toBe(false);
	});

	it("refuses a write-tool call from a spawned child in a task worktree", async () => {
		const parent = parentDir();
		const worktree = childWorktreeOf(parent);
		try {
			const { taskId } = await seededStore(parent);
			const tool = captureStoreTool("specd_append_event");

			await expect(
				tool.execute(
					"t1",
					{ item: taskId, type: "work.started", payload: {} },
					undefined,
					undefined,
					fakeCtx(worktree),
				),
			).rejects.toThrow(/no-specd-store-writes/);
		} finally {
			cleanupDir(parent);
			cleanupDir(worktree);
		}
	});

	it("explains the correct flow when refusing a child write", async () => {
		const parent = parentDir();
		const worktree = childWorktreeOf(parent);
		try {
			const { taskId } = await seededStore(parent);
			const tool = captureStoreTool("specd_append_event");
			await expect(
				tool.execute(
					"t1",
					{ item: taskId, type: "work.started", payload: {} },
					undefined,
					undefined,
					fakeCtx(worktree),
				),
			).rejects.toThrow(
				/Report results to the parent session; the parent records all specd events/,
			);
		} finally {
			cleanupDir(parent);
			cleanupDir(worktree);
		}
	});

	it("allows the identical write from a parent context (plain repo cwd)", async () => {
		const parent = parentDir();
		try {
			const { taskId } = await seededStore(parent);
			const tool = captureStoreTool("specd_append_event");
			await expect(
				tool.execute(
					"t1",
					{ item: taskId, type: "work.started", payload: {} },
					undefined,
					undefined,
					fakeCtx(parent),
				),
			).resolves.toMatchObject({
				content: [{ type: "text", text: expect.stringContaining("Appended") }],
			});
		} finally {
			cleanupDir(parent);
		}
	});

	it("does not run the dashboard read-back sync from a child context", async () => {
		const { syncExportedTasks } = await import("../src/sinks/sync.js");
		const syncMock = vi.mocked(syncExportedTasks);
		const parent = parentDir();
		const worktree = childWorktreeOf(parent);
		try {
			await seededStore(parent);
			const tool = captureStoreTool("specd_read");

			syncMock.mockClear();
			await tool.execute(
				"t1",
				{ view: "dashboard" },
				undefined,
				undefined,
				fakeCtx(worktree),
			);
			expect(syncMock).not.toHaveBeenCalled();

			await tool.execute(
				"t2",
				{ view: "dashboard" },
				undefined,
				undefined,
				fakeCtx(parent),
			);
			expect(syncMock).toHaveBeenCalledTimes(1);
		} finally {
			cleanupDir(parent);
			cleanupDir(worktree);
		}
	});

	it("keeps reads open from a child context", async () => {
		const parent = parentDir();
		const worktree = childWorktreeOf(parent);
		try {
			await seededStore(parent);
			const tool = captureStoreTool("specd_read");
			await expect(
				tool.execute(
					"t1",
					{ view: "query", kind: "task" },
					undefined,
					undefined,
					fakeCtx(worktree),
				),
			).resolves.toMatchObject({
				content: [{ type: "text", text: expect.any(String) }],
			});
		} finally {
			cleanupDir(parent);
			cleanupDir(worktree);
		}
	});
});
