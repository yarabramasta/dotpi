import { describe, expect, it } from "vitest";
import { insightLine, queryItems, renderInsight } from "../src/query.js";
import { addLink, appendEvent, createItem } from "../src/store/store.js";
import { makeStore } from "./helpers.js";

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

	describe("cross-store references", () => {
		it("returns local rows first, then referenced rows with source annotation", async () => {
			const local = await makeStore();
			const ref = await makeStore();
			try {
				const localSpec = createItem(local.store, {
					kind: "spec",
					title: "Local spec",
					body: "",
					actor: "t",
				});
				const refSpec = createItem(ref.store, {
					kind: "spec",
					title: "Referenced spec",
					body: "",
					actor: "t",
				});
				const rows = queryItems(local.store, {}, [ref.store]);
				expect(rows).toHaveLength(2);
				expect(rows[0].id).toBe(localSpec.id);
				expect(rows[0].source).toBeUndefined();
				expect(rows[1].id).toBe(refSpec.id);
				expect(rows[1].source).toBe(ref.store.dir);
			} finally {
				local.cleanup();
				ref.cleanup();
			}
		});

		it("applies q filter across local and referenced stores", async () => {
			const local = await makeStore();
			const ref = await makeStore();
			try {
				createItem(local.store, {
					kind: "task",
					title: "Local banana task",
					body: "",
					actor: "t",
				});
				createItem(ref.store, {
					kind: "task",
					title: "Referenced banana task",
					body: "",
					actor: "t",
				});
				createItem(ref.store, {
					kind: "task",
					title: "Other task",
					body: "",
					actor: "t",
				});
				const rows = queryItems(local.store, { q: "banana" }, [ref.store]);
				expect(rows.map((r) => r.title).sort()).toEqual([
					"Local banana task",
					"Referenced banana task",
				]);
				expect(rows.every((r) => r.source === ref.store.dir || !r.source)).toBe(
					true,
				);
			} finally {
				local.cleanup();
				ref.cleanup();
			}
		});

		it("keeps of-scoping local-only", async () => {
			const local = await makeStore();
			const ref = await makeStore();
			try {
				const localSpec = createItem(local.store, {
					kind: "spec",
					title: "Local spec",
					body: "",
					actor: "t",
				});
				const localTask = createItem(local.store, {
					kind: "task",
					title: "Local task",
					body: "",
					actor: "t",
				});
				createItem(ref.store, {
					kind: "task",
					title: "Referenced task",
					body: "",
					actor: "t",
				});
				addLink(local.store, localTask.id, localSpec.id, "part-of");
				const rows = queryItems(local.store, { of: localSpec.id }, [ref.store]);
				expect(rows.map((r) => r.id).sort()).toEqual([localTask.id].sort());
			} finally {
				local.cleanup();
				ref.cleanup();
			}
		});

		it("insightLine annotates an item found in a referenced store", async () => {
			const local = await makeStore();
			const ref = await makeStore();
			try {
				const refSpec = createItem(ref.store, {
					kind: "spec",
					title: "Shared spec",
					body: "",
					actor: "t",
				});
				appendEvent(ref.store, {
					item: refSpec.id,
					type: "spec.approved",
					actor: "t",
				});
				const line = insightLine(local.store, refSpec.id, [ref.store]);
				expect(line).toContain("Shared spec");
				expect(line).toContain(`(from: ${ref.store.dir})`);
				expect(line).toContain("spec · approved");
			} finally {
				local.cleanup();
				ref.cleanup();
			}
		});

		it("renderInsight adds a from-line under the heading for referenced hits", async () => {
			const local = await makeStore();
			const ref = await makeStore();
			try {
				const refSpec = createItem(ref.store, {
					kind: "spec",
					title: "Shared spec",
					body: "",
					actor: "t",
				});
				appendEvent(ref.store, {
					item: refSpec.id,
					type: "spec.approved",
					actor: "t",
				});
				const text = renderInsight(local.store, refSpec.id, [ref.store]);
				expect(text).toContain("Shared spec");
				expect(text).toContain(`(from: ${ref.store.dir})`);
				expect(text).toContain("spec.approved");
			} finally {
				local.cleanup();
				ref.cleanup();
			}
		});

		it("still reports an unknown item when it exists nowhere", async () => {
			const local = await makeStore();
			const ref = await makeStore();
			try {
				expect(insightLine(local.store, "spec-9999", [ref.store])).toBe(
					"- **spec-9999** unknown item",
				);
				expect(renderInsight(local.store, "spec-9999", [ref.store])).toBe(
					"Unknown item: spec-9999.",
				);
			} finally {
				local.cleanup();
				ref.cleanup();
			}
		});
	});
});
