import { describe, expect, it } from "vitest";
import { addLink, createItem } from "../store/store.js";
import { buildTaskExport } from "../tools.js";
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

		expect(exported.labels).toContain("specd");
		expect(exported.labels).toContain("spec:auth-service");
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

		expect(exported.labels).toEqual(["specd"]);
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
