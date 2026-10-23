import { afterEach, describe, expect, it } from "vitest";
import {
	addLink,
	appendEvent,
	counts,
	createItem,
	getItem,
	history,
	listItems,
	openStore,
} from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

let t: TestStore;

afterEach(() => {
	t?.cleanup();
});

describe("specd store", () => {
	it("creates items with generated ids and draft status", async () => {
		t = await makeStore();
		const item = createItem(t.store, {
			kind: "spec",
			title: "User authentication",
			actor: "test",
		});
		expect(item.id).toBe("spec-0001");
		expect(item.kind).toBe("spec");
		expect(item.status).toBe("draft");
		expect(item.title).toBe("User authentication");
		const second = createItem(t.store, {
			kind: "spec",
			title: "Rate limiting",
			actor: "test",
		});
		expect(second.id).toBe("spec-0002");
	});

	it("ignores agent-supplied status in extras — only the importer seeds status", async () => {
		t = await makeStore();
		const item = createItem(t.store, {
			kind: "spec",
			title: "Gate bypass attempt",
			actor: "test",
			extra: { status: "approved", items: ["keep-me"] },
		});
		// The approval gate must not be bypassable via extra.status.
		expect(item.status).toBe("draft");
		const created = store_history_first_payload();
		expect(created.status).toBeUndefined();
		expect(created.items).toEqual(["keep-me"]);

		function store_history_first_payload(): Record<string, unknown> {
			const row = t.store.db
				.prepare(
					"SELECT payload FROM events WHERE item = ? AND type = 'created'",
				)
				.get(item.id) as { payload: string };
			return JSON.parse(row.payload) as Record<string, unknown>;
		}
	});

	it("rejects unknown kinds and empty titles", async () => {
		t = await makeStore();
		expect(() =>
			createItem(t.store, {
				kind: "github" as never,
				title: "x",
				actor: "test",
			}),
		).toThrow(/Unknown item kind/);
		expect(() =>
			createItem(t.store, { kind: "spec", title: "  ", actor: "test" }),
		).toThrow(/title/);
	});

	it("events move status through the projection rules", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		appendEvent(t.store, {
			item: spec.id,
			type: "spec.approved",
			actor: "test",
		});
		expect(getItem(t.store, spec.id)?.status).toBe("approved");

		const task = createItem(t.store, {
			kind: "task",
			title: "Add login route",
			actor: "test",
		});
		appendEvent(t.store, {
			item: task.id,
			type: "task.exported",
			payload: { sink: "null" },
			actor: "test",
		});
		expect(getItem(t.store, task.id)?.status).toBe("exported");
		appendEvent(t.store, {
			item: task.id,
			type: "work.completed",
			actor: "test",
		});
		expect(getItem(t.store, task.id)?.status).toBe("done");
	});

	it("informational events append without changing status", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		appendEvent(t.store, {
			item: spec.id,
			type: "decision.made",
			payload: { decision: "use sqlite" },
			actor: "test",
		});
		appendEvent(t.store, {
			item: spec.id,
			type: "evidence.added",
			payload: { url: "https://example.test" },
			actor: "test",
		});
		const item = getItem(t.store, spec.id);
		expect(item?.status).toBe("draft");
		expect(history(t.store, spec.id)).toHaveLength(3);
	});

	it("rejects unknown event types and unknown items", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		expect(() =>
			appendEvent(t.store, {
				item: spec.id,
				type: "github.pushed" as never,
				actor: "test",
			}),
		).toThrow(/Unknown event type/);
		expect(() =>
			appendEvent(t.store, {
				item: "spec-9999",
				type: "spec.approved",
				actor: "test",
			}),
		).toThrow(/Unknown item/);
	});

	it("lists and counts by kind and status", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		createItem(t.store, { kind: "task", title: "T1", actor: "test" });
		appendEvent(t.store, {
			item: spec.id,
			type: "spec.approved",
			actor: "test",
		});
		const specs = listItems(t.store, { kind: "spec" });
		expect(specs).toHaveLength(1);
		expect(specs[0]?.status).toBe("approved");
		const approved = listItems(t.store, { status: "approved" });
		expect(approved).toHaveLength(1);
		const all = listItems(t.store);
		expect(all).toHaveLength(2);
		const c = counts(t.store);
		expect(c).toContainEqual({ kind: "spec", status: "approved", n: 1 });
		expect(c).toContainEqual({ kind: "task", status: "draft", n: 1 });
	});

	it("links items with typed relations and deduplicates", async () => {
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
		addLink(t.store, task.id, spec.id, "part-of"); // duplicate ignored
		// SAFETY: three-column link rows matching the destructure.
		const links = t.store.db
			.prepare("SELECT from_item, to_item, kind FROM links")
			.all() as unknown as Array<{
			from_item: string;
			to_item: string;
			kind: string;
		}>;
		expect(links).toHaveLength(1);
		expect(links[0]).toEqual({
			from_item: task.id,
			to_item: spec.id,
			kind: "part-of",
		});
	});

	it("reopens the same store without losing data", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		appendEvent(t.store, {
			item: spec.id,
			type: "spec.approved",
			actor: "test",
		});
		const base = t.store.cwd;
		t.store.db.close();
		const again = await openStore(base);
		const item = getItem(again, spec.id);
		expect(item?.status).toBe("approved");
		expect(item?.title).toBe("Auth");
		again.db.close();
	});
});
