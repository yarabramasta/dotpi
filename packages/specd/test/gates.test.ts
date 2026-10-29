import { afterEach, describe, expect, it } from "vitest";
import {
	assertCanExport,
	checkCanCompleteWork,
	checkCanStartWork,
	checkChecklistsClear,
	checkDiagnosisTarget,
	checkExport,
} from "../src/pipeline/gates.js";
import { addLink, appendEvent, createItem } from "../src/store/store.js";
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

	it("blocks on a failing review until a diagnosis and a passing one are recorded", async () => {
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
		// A passing review does not answer the failure by itself — the fix
		// loop requires a diagnosis.recorded after the failure.
		const loopCheck = checkCanCompleteWork(t.store, taskId);
		expect(loopCheck.ok).toBe(false);
		expect(loopCheck.reason).toContain("no diagnosis answers it");
		appendEvent(t.store, {
			item: taskId,
			type: "diagnosis.recorded",
			payload: {
				symptom: "route returns 500",
				rootCause: "missing await on session lookup",
				evidence: ["test output"],
				specGap: false,
			},
			actor: "agent",
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

	it("points a failed review at the diagnose loop", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: false, findings: ["broken"] },
			actor: "reviewer",
		});
		const check = checkCanCompleteWork(t.store, taskId);
		expect(check.reason).toContain("/spec diagnose");
	});
});

describe("diagnosis gate (diagnosis.recorded target)", () => {
	it("accepts an in-progress task", async () => {
		t = await makeStore();
		const task = createItem(t.store, {
			kind: "task",
			title: "Fix login",
			body: "fix",
			actor: "test",
		});
		appendEvent(t.store, {
			item: task.id,
			type: "work.started",
			actor: "test",
		});
		const check = checkDiagnosisTarget(t.store, task.id);
		expect(check.ok).toBe(true);
	});

	it("refuses drafts, done tasks, non-tasks, and unknown ids", async () => {
		t = await makeStore();
		const task = createItem(t.store, {
			kind: "task",
			title: "Fix login",
			body: "fix",
			actor: "test",
		});
		const draft = checkDiagnosisTarget(t.store, task.id);
		expect(draft.ok).toBe(false);
		expect(draft.reason).toContain("in draft");
		appendEvent(t.store, {
			item: task.id,
			type: "work.started",
			actor: "test",
		});
		appendEvent(t.store, {
			item: task.id,
			type: "work.completed",
			actor: "test",
		});
		const done = checkDiagnosisTarget(t.store, task.id);
		expect(done.ok).toBe(false);
		expect(done.reason).toContain("in done");
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			body: "intent",
			actor: "test",
		});
		expect(checkDiagnosisTarget(t.store, spec.id).ok).toBe(false);
		expect(checkDiagnosisTarget(t.store, "task-9999").reason).toContain(
			"Unknown item",
		);
	});
});

describe("fix loop (diagnosis + specGap gates)", () => {
	it("needs a fresh diagnosis after each new failure", async () => {
		t = await makeStore();
		const { taskId } = await makeApprovedCycle();
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: false },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: taskId,
			type: "diagnosis.recorded",
			payload: { symptom: "s", rootCause: "r", evidence: [], specGap: false },
			actor: "agent",
		});
		// Second failure: the earlier diagnosis predates it — refused.
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: false },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: true },
			actor: "reviewer",
		});
		expect(checkCanCompleteWork(t.store, taskId).ok).toBe(false);
		appendEvent(t.store, {
			item: taskId,
			type: "diagnosis.recorded",
			payload: { symptom: "s2", rootCause: "r2", evidence: [], specGap: false },
			actor: "agent",
		});
		expect(checkCanCompleteWork(t.store, taskId).ok).toBe(true);
	});

	it("holds completion while a specGap diagnosis awaits a spec revision", async () => {
		t = await makeStore();
		const { taskId, specId } = await makeApprovedCycle();
		appendEvent(t.store, {
			item: taskId,
			type: "review.completed",
			payload: { passed: true },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: taskId,
			type: "diagnosis.recorded",
			payload: {
				symptom: "spec says GET, endpoint is POST",
				rootCause: "acceptance criterion mismatched the API contract",
				evidence: [],
				specGap: true,
			},
			actor: "agent",
		});
		const check = checkCanCompleteWork(t.store, taskId);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain(specId);
		// A spec body.updated predating the diagnosis does not count.
		appendEvent(t.store, {
			item: specId,
			type: "body.updated",
			payload: { body: "stale" },
			actor: "test",
		});
		appendEvent(t.store, {
			item: taskId,
			type: "diagnosis.recorded",
			payload: { symptom: "s", rootCause: "r", evidence: [], specGap: true },
			actor: "agent",
		});
		expect(checkCanCompleteWork(t.store, taskId).ok).toBe(false);
		appendEvent(t.store, {
			item: specId,
			type: "body.updated",
			payload: { body: "## Intent\nLogin works over POST." },
			actor: "agent",
		});
		expect(checkCanCompleteWork(t.store, taskId).ok).toBe(true);
	});

	it("tells the agent how out when a specGap diagnosis has no linked spec", async () => {
		t = await makeStore();
		const task = createItem(t.store, {
			kind: "task",
			title: "Orphan fix",
			body: "fix it",
			actor: "test",
		});
		appendEvent(t.store, {
			item: task.id,
			type: "review.completed",
			payload: { passed: true },
			actor: "reviewer",
		});
		appendEvent(t.store, {
			item: task.id,
			type: "diagnosis.recorded",
			payload: { symptom: "s", rootCause: "r", evidence: [], specGap: true },
			actor: "agent",
		});
		const check = checkCanCompleteWork(t.store, task.id);
		expect(check.ok).toBe(false);
		expect(check.reason).toContain("specGap=false");
	});
});
