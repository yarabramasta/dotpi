import { afterEach, describe, expect, it } from "vitest";
import {
	assertCanExport,
	checkCanCompleteWork,
	checkCanStartWork,
	checkChecklistsClear,
	checkExport,
} from "../pipeline/gates.js";
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

describe("start gate (work.started)", () => {
	it("passes when no checklist blocks and no scope collision", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		expect(checkCanStartWork(t.store, taskId).ok).toBe(true);
	});

	it("blocks on unchecked reviewer checklists (checklist-gated runs)", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		const checklist = createItem(t.store, {
			kind: "checklist",
			title: "Requirements review",
			body: "",
			actor: "test",
			extra: { items: ["Requirement is testable", "Edge cases covered"] },
		});
		addLink(t.store, checklist.id, "spec-0001", "part-of");
		const check = checkCanStartWork(t.store, taskId);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("unchecked item(s)");
		// After the reviewer checks every item, the gate opens.
		appendEvent(t.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "test",
		});
		appendEvent(t.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 1 },
			actor: "test",
		});
		expect(checkChecklistsClear(t.store, taskId).ok).toBe(true);
	});

	it("blocks when another in-progress task claims an overlapping path scope", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		appendEvent(t.store, {
			item: taskId,
			type: "work.started",
			actor: "test",
		});
		const other = createItem(t.store, {
			kind: "task",
			title: "Second task",
			body: "",
			pathScope: "src/auth/login.ts",
			actor: "test",
		});
		const check = checkCanStartWork(t.store, other.id);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("overlaps");
		// A disjoint scope does not collide.
		const third = createItem(t.store, {
			kind: "task",
			title: "Third task",
			body: "",
			pathScope: "src/api/**",
			actor: "test",
		});
		expect(checkCanStartWork(t.store, third.id).ok).toBe(true);
		// Unscoped tasks collide with everything (cannot prove disjointness).
		const unscoped = createItem(t.store, {
			kind: "task",
			title: "Unscoped task",
			body: "",
			actor: "test",
		});
		expect(checkCanStartWork(t.store, unscoped.id).ok).toBe(false);
	});
});

describe("completion gate (work.completed)", () => {
	it("blocks without any review", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		const check = checkCanCompleteWork(t.store, taskId);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("no review yet");
	});

	it("blocks on a failing review until a passing one is recorded", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: false, findings: ["route returns 500"] },
			actor: "reviewer",
		});
		expect(checkCanCompleteWork(t.store, taskId).ok).toBe(false);
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: true, findings: [] },
			actor: "reviewer",
		});
		expect(checkCanCompleteWork(t.store, taskId).ok).toBe(true);
	});

	it("only the latest review verdict counts", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: true },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: false },
			actor: "reviewer",
		});
		expect(checkCanCompleteWork(t.store, taskId).ok).toBe(false);
	});
});
