import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkChecklistsClear, checklistState } from "../pipeline/gates.js";
import {
	addLink,
	appendEvent,
	createItem,
	getItem,
	history,
} from "../src/store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

function setupCycleAndSpec(test: TestStore): {
	cycleId: string;
	specId: string;
	taskId: string;
} {
	const cycle = createItem(test.store, {
		kind: "cycle",
		title: "Phase 1",
		body: "",
		actor: "agent",
	});
	appendEvent(test.store, {
		item: cycle.id,
		type: "explore.decided",
		payload: { decision: "go", rationale: "ready" },
		actor: "agent",
	});
	const spec = createItem(test.store, {
		kind: "spec",
		title: "OTA delivery contract v1",
		body: "",
		actor: "agent",
	});
	addLink(test.store, spec.id, cycle.id, "part-of");
	const task = createItem(test.store, {
		kind: "task",
		title: "Implement",
		body: "",
		pathScope: "src/**",
		actor: "agent",
	});
	addLink(test.store, task.id, spec.id, "part-of");
	return { cycleId: cycle.id, specId: spec.id, taskId: task.id };
}

describe("reviewer-owned checklist", () => {
	let test: TestStore;

	beforeEach(async () => {
		test = await makeStore();
	});

	afterEach(() => test.cleanup());

	it("renders checklist items from the created event payload", () => {
		const checklist = createItem(test.store, {
			kind: "checklist",
			title: "Requirements checklist",
			body: "",
			extra: { items: ["Acceptance criterion 1", "Acceptance criterion 2"] },
			actor: "reviewer",
		});
		const state = checklistState(test.store, checklist.id);
		expect(state?.items).toEqual([
			"Acceptance criterion 1",
			"Acceptance criterion 2",
		]);
		expect(state?.checkedIndexes).toEqual([]);
		expect(state?.allChecked).toBe(false);
	});

	it("tracks reviewer checkmarks via checklist.item.checked events", () => {
		const checklist = createItem(test.store, {
			kind: "checklist",
			title: "Requirements",
			body: "",
			extra: { items: ["First", "Second", "Third"] },
			actor: "reviewer",
		});
		appendEvent(test.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		appendEvent(test.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 2 },
			actor: "reviewer",
		});
		const state = checklistState(test.store, checklist.id);
		expect(state?.checkedIndexes).toEqual([0, 2]);
		expect(state?.allChecked).toBe(false);
	});

	it("blocks the implement gate while items remain unchecked", () => {
		const { specId, taskId } = setupCycleAndSpec(test);
		const checklist = createItem(test.store, {
			kind: "checklist",
			title: "Requirements",
			body: "",
			extra: { items: ["Item A", "Item B"] },
			actor: "reviewer",
		});
		addLink(test.store, checklist.id, specId, "part-of");
		appendEvent(test.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		const gate = checkChecklistsClear(test.store, taskId);
		expect(gate.ok).toBe(false);
		expect(gate.reason).toContain("1 unchecked item(s)");
	});

	it("passes the implement gate when every item is checked", () => {
		const { specId, taskId } = setupCycleAndSpec(test);
		const checklist = createItem(test.store, {
			kind: "checklist",
			title: "Requirements",
			body: "",
			extra: { items: ["Item A", "Item B"] },
			actor: "reviewer",
		});
		addLink(test.store, checklist.id, specId, "part-of");
		appendEvent(test.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		appendEvent(test.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 1 },
			actor: "reviewer",
		});
		const gate = checkChecklistsClear(test.store, taskId);
		expect(gate.ok).toBe(true);
	});

	it("ignores out-of-range checkmarks", () => {
		const checklist = createItem(test.store, {
			kind: "checklist",
			title: "Requirements",
			body: "",
			extra: { items: ["Only one"] },
			actor: "reviewer",
		});
		appendEvent(test.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 99 },
			actor: "reviewer",
		});
		const state = checklistState(test.store, checklist.id);
		expect(state?.checkedIndexes).toEqual([]);
	});

	it("preserves the item body and history alongside the checklist state", () => {
		const checklist = createItem(test.store, {
			kind: "checklist",
			title: "Pre-deploy checks",
			body: "Run before merging.",
			extra: { items: ["Lint clean", "Tests pass"] },
			actor: "reviewer",
		});
		appendEvent(test.store, {
			item: checklist.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "reviewer",
		});
		const item = getItem(test.store, checklist.id);
		expect(item?.body).toBe("Run before merging.");
		const events = history(test.store, checklist.id).map((e) => e.type);
		expect(events).toContain("created");
		expect(events).toContain("checklist.item.checked");
	});
});
