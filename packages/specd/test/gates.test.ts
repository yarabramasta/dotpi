import { afterEach, describe, expect, it } from "vitest";
import { assertCanExport, checkExport } from "../pipeline/gates.js";
import { addLink, appendEvent, createItem } from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

let t: TestStore;

afterEach(() => {
	t?.cleanup();
});

async function makeApprovedCycle(): Promise<{
	specId: string;
	taskId: string;
}> {
	const spec = createItem(t.store, {
		kind: "spec",
		title: "Auth",
		body: "## Intent\nLogin works.",
		actor: "test",
	});
	const plan = createItem(t.store, {
		kind: "plan",
		title: "Auth plan",
		body: "sqlite sessions.",
		actor: "test",
	});
	addLink(t.store, plan.id, spec.id, "part-of");
	const task = createItem(t.store, {
		kind: "task",
		title: "Add login route",
		body: "POST /login returns a session.",
		pathScope: "src/auth/**",
		actor: "test",
	});
	addLink(t.store, task.id, spec.id, "part-of");
	appendEvent(t.store, { item: spec.id, type: "spec.approved", actor: "test" });
	return { specId: spec.id, taskId: task.id };
}

describe("export gate", () => {
	it("passes for a task linked to an approved spec", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		const check = checkExport(t.store, taskId);
		expect(check.ok).toBe(true);
		expect(() => assertCanExport(t.store, taskId)).not.toThrow();
	});

	it("refuses when the spec is not approved", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		const task = createItem(t.store, {
			kind: "task",
			title: "T1",
			actor: "test",
		});
		addLink(t.store, task.id, spec.id, "part-of");
		const check = checkExport(t.store, task.id);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("not approved");
		expect(() => assertCanExport(t.store, task.id)).toThrow(/not approved/);
	});

	it("refuses when the task is not linked to a spec", async () => {
		t = await makeStore();
		const task = createItem(t.store, {
			kind: "task",
			title: "T1",
			actor: "test",
		});
		const check = checkExport(t.store, task.id);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("not linked to a spec");
	});

	it("refuses a second export of the same task", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		appendEvent(t.store, {
			item: taskId,
			type: "task.exported",
			payload: { sink: "null", externalRef: taskId },
			actor: "test",
		});
		const check = checkExport(t.store, taskId);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("already exported");
	});

	it("refuses non-task items and unknown items", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "S",
			actor: "test",
		});
		expect(checkExport(t.store, spec.id).ok).toBe(false);
		expect(checkExport(t.store, "task-9999").ok).toBe(false);
	});
});
