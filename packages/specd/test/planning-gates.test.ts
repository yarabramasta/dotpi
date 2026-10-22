import { afterEach, describe, expect, it } from "vitest";
import {
	checkChecklistsClear,
	checklistState,
	checkChecklistsClear as checklistsClear,
	checkSpecCreation,
} from "../pipeline/gates.js";
import { addLink, appendEvent, createItem } from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

let t: TestStore;

afterEach(() => {
	t?.cleanup();
});

async function makeCycle(decision?: string): Promise<string> {
	const cycle = createItem(t.store, {
		kind: "cycle",
		title: "OTA contract",
		actor: "test",
	});
	if (decision) {
		appendEvent(t.store, {
			item: cycle.id,
			type: "explore.decided",
			payload: {
				decision,
				reason: decision === "stop" ? "not worth it" : undefined,
			},
			actor: "test",
		});
	}
	return cycle.id;
}

describe("explore decision gate (spec creation)", () => {
	it("refuses when no cycle is given", async () => {
		t = await makeStore();
		const check = checkSpecCreation(t.store, undefined);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("Specs live inside cycles");
	});

	it("refuses an unknown or non-cycle item", async () => {
		t = await makeStore();
		const spec = createItem(t.store, { kind: "spec", title: "x", actor: "t" });
		expect(checkSpecCreation(t.store, spec.id).ok).toBe(false);
		expect(checkSpecCreation(t.store, "cycle-9999").ok).toBe(false);
	});

	it("refuses a cycle with no explore decision yet", async () => {
		t = await makeStore();
		const cycleId = await makeCycle();
		const check = checkSpecCreation(t.store, cycleId);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("No explore decision recorded");
	});

	it("refuses needs-clarification with guidance to research more", async () => {
		t = await makeStore();
		const cycleId = await makeCycle("needs-clarification");
		const check = checkSpecCreation(t.store, cycleId);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("needs clarification");
	});

	it("refuses stop — a documented stop is a valid outcome", async () => {
		t = await makeStore();
		const cycleId = await makeCycle("stop");
		const check = checkSpecCreation(t.store, cycleId);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("valid outcome");
	});

	it("passes go and cycles project to stopped on stop", async () => {
		t = await makeStore();
		const goId = await makeCycle("go");
		expect(checkSpecCreation(t.store, goId).ok).toBe(true);
		const stopId = await makeCycle("stop");
		const stopped = t.store.db
			.prepare("SELECT status FROM items WHERE id = ?")
			.get(stopId) as { status: string };
		expect(stopped.status).toBe("stopped");
	});
});

describe("reviewer-owned checklists", () => {
	async function makeChecklist(items: string[]): Promise<string> {
		const checklist = createItem(t.store, {
			kind: "checklist",
			title: "Requirements quality",
			extra: { items },
			actor: "test",
		});
		return checklist.id;
	}

	it("reads state from the created payload plus checked events", async () => {
		t = await makeStore();
		const id = await makeChecklist(["testable?", "unambiguous?", "complete?"]);
		const fresh = checklistState(t.store, id);
		expect(fresh?.total).toBe(3);
		expect(fresh?.allChecked).toBe(false);
		appendEvent(t.store, {
			item: id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: id,
			type: "checklist.item.checked",
			payload: { index: 2 },
			actor: "reviewer",
		});
		const state = checklistState(t.store, id);
		expect(state?.checkedIndexes).toEqual([0, 2]);
		expect(state?.allChecked).toBe(false);
		appendEvent(t.store, {
			item: id,
			type: "checklist.item.checked",
			payload: { index: 1 },
			actor: "reviewer",
		});
		expect(checklistState(t.store, id)?.allChecked).toBe(true);
	});

	it("ignores out-of-range and duplicate checked events", async () => {
		t = await makeStore();
		const id = await makeChecklist(["only one"]);
		appendEvent(t.store, {
			item: id,
			type: "checklist.item.checked",
			payload: { index: 5 },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		const state = checklistState(t.store, id);
		expect(state?.checkedIndexes).toEqual([0]);
	});

	it("implement gate blocks on unchecked checklists, clears when reviewed", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "S",
			actor: "test",
		});
		const task = createItem(t.store, {
			kind: "task",
			title: "T",
			actor: "test",
		});
		addLink(t.store, task.id, spec.id, "part-of");
		const checklist = createItem(t.store, {
			kind: "checklist",
			title: "C",
			extra: { items: ["a", "b"] },
			actor: "test",
		});
		addLink(t.store, checklist.id, spec.id, "part-of");

		const blocked = checkChecklistsClear(t.store, task.id);
		expect(blocked.ok).toBe(false);
		expect(blocked.reason).toContain("2 unchecked item(s) out of 2");

		appendEvent(t.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 1 },
			actor: "reviewer",
		});
		expect(checklistsClear(t.store, task.id).ok).toBe(true);
	});

	it("passes when the task's spec has no checklists at all", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "S",
			actor: "test",
		});
		const task = createItem(t.store, {
			kind: "task",
			title: "T",
			actor: "test",
		});
		addLink(t.store, task.id, spec.id, "part-of");
		expect(checkChecklistsClear(t.store, task.id).ok).toBe(true);
	});
});

describe("store v3 task metadata", () => {
	it("projects phase and parallel from the created payload", async () => {
		t = await makeStore();
		const task = createItem(t.store, {
			kind: "task",
			title: "Parallelizable task",
			phase: "story",
			parallel: true,
			actor: "test",
		});
		expect(task.phase).toBe("story");
		expect(task.parallel).toBe(1);
		const plain = createItem(t.store, {
			kind: "task",
			title: "Sequential task",
			actor: "test",
		});
		expect(plain.phase).toBeNull();
		expect(plain.parallel).toBe(0);
	});

	it("spec.reopened returns an approved spec to draft", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "S",
			actor: "test",
		});
		appendEvent(t.store, { item: spec.id, type: "spec.approved", actor: "t" });
		expect(
			(
				t.store.db
					.prepare("SELECT status FROM items WHERE id = ?")
					.get(spec.id) as { status: string }
			).status,
		).toBe("approved");
		appendEvent(t.store, { item: spec.id, type: "spec.reopened", actor: "t" });
		expect(
			(
				t.store.db
					.prepare("SELECT status FROM items WHERE id = ?")
					.get(spec.id) as { status: string }
			).status,
		).toBe("draft");
	});
});
