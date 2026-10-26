import { describe, expect, it } from "vitest";
import { insightLine, queryItems, renderInsight } from "../query.js";
import { addLink, appendEvent, createItem } from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

describe("item query + insight", () => {
	it("filters by kind, status, and text", async () => {
		const t = await makeStore();
		try {
			const spec = createItem(t.store, {
				kind: "spec",
				title: "Login spec",
				body: "Users can log in",
				actor: "t",
			});
			appendEvent(t.store, {
				item: spec.id,
				type: "spec.approved",
				actor: "t",
			});
			createItem(t.store, {
				kind: "task",
				title: "Login route task",
				body: "POST /login",
				actor: "t",
			});
			createItem(t.store, {
				kind: "task",
				title: "Unrelated task",
				body: "misc",
				actor: "t",
			});

			const byKind = queryItems(t.store, { kind: "task" });
			expect(byKind).toHaveLength(2);

			const approved = queryItems(t.store, { status: "approved" });
			expect(approved.map((r) => r.id)).toEqual([spec.id]);

			const byText = queryItems(t.store, { q: "login" });
			expect(byText.map((r) => r.title).sort()).toEqual([
				"Login route task",
				"Login spec",
			]);

			const narrow = queryItems(t.store, { kind: "task", q: "login" });
			expect(narrow.map((r) => r.title)).toEqual(["Login route task"]);
		} finally {
			t.cleanup();
		}
	});

	it("scopes to items linked to an item, excluding the item itself", async () => {
		const t = await makeStore();
		try {
			const spec = createItem(t.store, {
				kind: "spec",
				title: "Spec",
				body: "",
				actor: "t",
			});
			const plan = createItem(t.store, {
				kind: "plan",
				title: "Plan",
				body: "",
				actor: "t",
			});
			const task = createItem(t.store, {
				kind: "task",
				title: "Task",
				body: "",
				actor: "t",
			});
			addLink(t.store, plan.id, spec.id, "part-of");
			addLink(t.store, task.id, spec.id, "part-of");

			const related = queryItems(t.store, { of: spec.id });
			expect(related.map((r) => r.id).sort()).toEqual(
				[plan.id, task.id].sort(),
			);
			// the spec itself is never in its own related set
			expect(related.some((r) => r.id === spec.id)).toBe(false);
		} finally {
			t.cleanup();
		}
	});

	it("insight line summarizes state, last event, links", async () => {
		const t = await makeStore();
		try {
			const spec = createItem(t.store, {
				kind: "spec",
				title: "Login spec",
				body: "",
				actor: "t",
			});
			appendEvent(t.store, {
				item: spec.id,
				type: "spec.approved",
				actor: "user",
			});
			const task = createItem(t.store, {
				kind: "task",
				title: "Route",
				body: "",
				pathScope: "src/auth/**",
				actor: "t",
			});
			addLink(t.store, task.id, spec.id, "part-of");

			const specLine = insightLine(t.store, spec.id);
			expect(specLine).toContain("spec · approved");
			expect(specLine).toContain("last: spec.approved");

			const taskLine = insightLine(t.store, task.id);
			expect(taskLine).toContain("scope: src/auth/**");
			expect(taskLine).toContain("links: 1");
		} finally {
			t.cleanup();
		}
	});

	it("renderInsight gives key events and links for one item", async () => {
		const t = await makeStore();
		try {
			const spec = createItem(t.store, {
				kind: "spec",
				title: "Login spec",
				body: "",
				actor: "t",
			});
			appendEvent(t.store, {
				item: spec.id,
				type: "spec.approved",
				actor: "user",
			});
			const insight = renderInsight(t.store, spec.id);
			expect(insight).toContain("spec-0001");
			expect(insight).toContain("spec.approved");
			expect(insight).toContain("links: none");
			expect(insight).not.toContain("created"); // noise filtered out
		} finally {
			t.cleanup();
		}
	});

	it("unknown item insight degrades plainly", async () => {
		const t = await makeStore();
		try {
			expect(renderInsight(t.store, "spec-9999")).toBe(
				"Unknown item: spec-9999.",
			);
		} finally {
			t.cleanup();
		}
	});
});
