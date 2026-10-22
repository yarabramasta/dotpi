import { afterEach, describe, expect, it } from "vitest";
import { checkConsistency, formatFindings } from "../pipeline/consistency.js";
import { addLink, appendEvent, createItem } from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

let t: TestStore;

afterEach(() => {
	t?.cleanup();
});

function approvedSpecWithPlan(): { spec: string; plan: string; task: string } {
	const spec = createItem(t.store, { kind: "spec", title: "S", actor: "t" });
	appendEvent(t.store, { item: spec.id, type: "spec.approved", actor: "t" });
	const plan = createItem(t.store, { kind: "plan", title: "P", actor: "t" });
	addLink(t.store, plan.id, spec.id, "part-of");
	const task = createItem(t.store, {
		kind: "task",
		title: "T",
		pathScope: "src/a/**",
		actor: "t",
	});
	addLink(t.store, task.id, spec.id, "part-of");
	return { spec: spec.id, plan: plan.id, task: task.id };
}

describe("consistency check", () => {
	it("finds nothing in a clean store", async () => {
		t = await makeStore();
		expect(checkConsistency(t.store)).toEqual([]);
		expect(formatFindings([])).toContain("No consistency findings");
	});

	it("flags a task that links to no spec", async () => {
		t = await makeStore();
		const task = createItem(t.store, { kind: "task", title: "T", actor: "t" });
		const findings = checkConsistency(t.store);
		expect(
			findings.some(
				(f) => f.rule === "task-without-spec" && f.item === task.id,
			),
		).toBe(true);
	});

	it("flags a task on an unapproved spec as critical", async () => {
		t = await makeStore();
		const spec = createItem(t.store, { kind: "spec", title: "S", actor: "t" });
		const task = createItem(t.store, { kind: "task", title: "T", actor: "t" });
		addLink(t.store, task.id, spec.id, "part-of");
		const findings = checkConsistency(t.store);
		expect(findings[0]?.severity).toBe("critical");
		expect(findings[0]?.rule).toBe("task-of-unapproved-spec");
	});

	it("flags an approved spec with tasks but no plan as critical", async () => {
		t = await makeStore();
		const spec = createItem(t.store, { kind: "spec", title: "S", actor: "t" });
		appendEvent(t.store, { item: spec.id, type: "spec.approved", actor: "t" });
		const task = createItem(t.store, { kind: "task", title: "T", actor: "t" });
		addLink(t.store, task.id, spec.id, "part-of");
		const findings = checkConsistency(t.store);
		expect(findings.filter((f) => f.rule === "spec-without-plan")).toHaveLength(
			1,
		);
	});

	it("notes an approved spec without tasks", async () => {
		t = await makeStore();
		const spec = createItem(t.store, { kind: "spec", title: "S", actor: "t" });
		appendEvent(t.store, { item: spec.id, type: "spec.approved", actor: "t" });
		expect(checkConsistency(t.store).map((f) => f.rule)).toEqual([
			"spec-without-tasks",
		]);
	});

	it("reports pending checklists and clears when reviewed", async () => {
		t = await makeStore();
		approvedSpecWithPlan();
		const cl = createItem(t.store, {
			kind: "checklist",
			title: "C",
			extra: { items: ["a", "b"] },
			actor: "t",
		});
		const specId = (
			t.store.db.prepare("SELECT id FROM items WHERE kind = 'spec'").get() as {
				id: string;
			}
		).id;
		addLink(t.store, cl.id, specId, "part-of");
		const before = checkConsistency(t.store);
		expect(before.some((f) => f.rule === "checklist-pending")).toBe(true);
		appendEvent(t.store, {
			item: cl.id,
			type: "checklist.item.checked",
			payload: { index: 0 },
			actor: "r",
		});
		appendEvent(t.store, {
			item: cl.id,
			type: "checklist.item.checked",
			payload: { index: 1 },
			actor: "r",
		});
		expect(
			checkConsistency(t.store).some((f) => f.rule === "checklist-pending"),
		).toBe(false);
	});

	it("flags orphan checklists", async () => {
		t = await makeStore();
		const cl = createItem(t.store, {
			kind: "checklist",
			title: "C",
			extra: { items: ["a"] },
			actor: "t",
		});
		expect(
			checkConsistency(t.store).some(
				(f) => f.rule === "orphan-checklist" && f.item === cl.id,
			),
		).toBe(true);
	});

	it("flags overlapping parallel path scopes, clears when one is done", async () => {
		t = await makeStore();
		const { spec } = approvedSpecWithPlan();
		const other = createItem(t.store, {
			kind: "spec",
			title: "S2",
			actor: "t",
		});
		appendEvent(t.store, { item: other.id, type: "spec.approved", actor: "t" });
		const plan = createItem(t.store, { kind: "plan", title: "P2", actor: "t" });
		addLink(t.store, plan.id, other.id, "part-of");
		const a = createItem(t.store, {
			kind: "task",
			title: "A",
			pathScope: "src/auth/**",
			parallel: true,
			actor: "t",
		});
		addLink(t.store, a.id, other.id, "part-of");
		const b = createItem(t.store, {
			kind: "task",
			title: "B",
			pathScope: "src/auth/login.ts",
			parallel: true,
			actor: "t",
		});
		addLink(t.store, b.id, spec, "part-of");

		const findings = checkConsistency(t.store);
		const overlap = findings.find((f) => f.rule === "parallel-scope-overlap");
		expect(overlap?.severity).toBe("warning");

		appendEvent(t.store, { item: a.id, type: "work.completed", actor: "t" });
		expect(
			checkConsistency(t.store).some(
				(f) => f.rule === "parallel-scope-overlap",
			),
		).toBe(false);
	});

	it("scopes to an item's part-of subgraph and rejects unknown scope", async () => {
		t = await makeStore();
		approvedSpecWithPlan();
		const outside = createItem(t.store, {
			kind: "task",
			title: "Far",
			actor: "t",
		});
		const specId = (
			t.store.db.prepare("SELECT id FROM items WHERE kind = 'spec'").get() as {
				id: string;
			}
		).id;

		const scoped = checkConsistency(t.store, specId);
		expect(scoped.some((f) => f.item === outside.id)).toBe(false);

		const unknown = checkConsistency(t.store, "cycle-9999");
		expect(unknown).toHaveLength(1);
		expect(unknown[0]?.rule).toBe("unknown-scope");
	});

	it("formats findings grouped by severity, critical first", async () => {
		t = await makeStore();
		const spec = createItem(t.store, { kind: "spec", title: "S", actor: "t" });
		const task = createItem(t.store, { kind: "task", title: "T", actor: "t" });
		addLink(t.store, task.id, spec.id, "part-of");
		// A second, unlinked task supplies the warning-severity finding.
		createItem(t.store, { kind: "task", title: "Lone", actor: "t" });
		const rendered = formatFindings(checkConsistency(t.store));
		expect(rendered.indexOf("🔴")).toBeLessThan(rendered.indexOf("🟡"));
		expect(rendered).toContain("task-of-unapproved-spec");
	});
});
