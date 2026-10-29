import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createItem, openStore } from "../src/store/store.js";
import { registerStoreTools } from "../src/tools/store-tools.js";

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

function fakeCtx(cwd: string, sessionId: string | undefined): ExtensionContext {
	return {
		cwd,
		sessionManager: sessionId
			? {
					getSessionId: () => sessionId,
				}
			: undefined,
	} as unknown as ExtensionContext;
}

async function seededStore(ownerSessionId: string) {
	const dir = mkdtempSync(join(tmpdir(), "specd-owner-"));
	const store = await openStore(dir, ownerSessionId);
	const task = createItem(store, {
		kind: "task",
		title: "Owned task",
		body: "Body.",
		actor: "test",
	});
	store.db.close();
	return { dir, taskId: task.id };
}

describe("specd store ownership", () => {
	it("persistently binds the owner session id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "specd-owner-bind-"));
		const cleanup = () => rmSync(dir, { recursive: true, force: true });
		try {
			const first = await openStore(dir, "parent-session");
			expect(first.ownerSessionId).toBe("parent-session");
			first.db.close();

			const second = await openStore(dir, "child-session");
			expect(second.ownerSessionId).toBe("parent-session");
			second.db.close();
		} finally {
			cleanup();
		}
	});

	it("refuses a write-tool call from a non-owner session", async () => {
		const { dir, taskId } = await seededStore("parent-session");
		const cleanup = () => rmSync(dir, { recursive: true, force: true });
		try {
			const tool = captureStoreTool("specd_append_event");

			await expect(
				tool.execute(
					"t1",
					{
						item: taskId,
						type: "work.started",
						payload: {},
					},
					undefined,
					undefined,
					fakeCtx(dir, "child-session"),
				),
			).rejects.toThrow(/no-specd-store-writes/);

			await expect(
				tool.execute(
					"t2",
					{
						item: taskId,
						type: "work.started",
						payload: {},
					},
					undefined,
					undefined,
					fakeCtx(dir, "parent-session"),
				),
			).resolves.toMatchObject({
				content: [{ type: "text", text: expect.stringContaining("Appended") }],
			});
		} finally {
			cleanup();
		}
	});

	it("explains the correct flow when refusing a child write", async () => {
		const { dir, taskId } = await seededStore("parent-session");
		const cleanup = () => rmSync(dir, { recursive: true, force: true });
		try {
			const tool = captureStoreTool("specd_append_event");
			await expect(
				tool.execute(
					"t1",
					{
						item: taskId,
						type: "work.started",
						payload: {},
					},
					undefined,
					undefined,
					fakeCtx(dir, "child-session"),
				),
			).rejects.toThrow(
				/Child sessions report results to the parent session; the parent records all specd events/,
			);
		} finally {
			cleanup();
		}
	});
});
