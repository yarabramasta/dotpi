import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MappedSnapshot } from "../import/map.js";
import { applyImport, planImport } from "../import/run.js";
import {
	appendEvent,
	createItem,
	getItem,
	history,
	openStore,
	openStoreReadOnly,
} from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

let t: TestStore;

afterEach(() => {
	t?.cleanup();
});

describe("events.jsonl WAL", () => {
	it("appendEvent appends a round-trippable jsonl line", async () => {
		t = await makeStore();
		const item = createItem(t.store, {
			kind: "spec",
			title: "WAL spec",
			actor: "test",
		});
		const event = appendEvent(t.store, {
			item: item.id,
			type: "spec.approved",
			payload: { note: "approved" },
			actor: "reviewer",
			batch: "batch-1",
		});

		const jsonlPath = join(t.store.dir, "events.jsonl");
		expect(existsSync(jsonlPath)).toBe(true);
		const lines = readFileSync(jsonlPath, "utf-8")
			.split("\n")
			.filter((l) => l.trim() !== "");
		expect(lines.length).toBe(2);

		const approved = JSON.parse(lines[1]) as Record<string, unknown>;
		expect(approved.id).toBe(event.id);
		expect(approved.item).toBe(item.id);
		expect(approved.type).toBe("spec.approved");
		expect(approved.payload).toBe('{"note":"approved"}');
		expect(approved.actor).toBe("reviewer");
		expect(approved.batch).toBe("batch-1");
		expect(approved.at).toBe(event.at);
	});

	it("replaying events.jsonl restores items, history and id sequence", async () => {
		t = await makeStore();
		const id = createItem(t.store, {
			kind: "task",
			title: "Replay me",
			body: "body text",
			actor: "test",
		}).id;
		appendEvent(t.store, {
			item: id,
			type: "work.started",
			actor: "test",
		});

		const jsonlPath = join(t.store.dir, "events.jsonl");
		expect(existsSync(jsonlPath)).toBe(true);

		t.store.db.close();
		unlinkSync(t.store.path);
		expect(existsSync(t.store.path)).toBe(false);

		const replayed = await openStore(t.dir);
		expect(replayed.dir).toBe(t.store.dir);
		expect(getItem(replayed, id)?.status).toBe("in-progress");
		expect(getItem(replayed, id)?.body).toBe("body text");
		expect(history(replayed, id).map((e) => e.type)).toEqual([
			"created",
			"work.started",
		]);

		// id sequence continues from replayed state.
		const next = createItem(replayed, {
			kind: "task",
			title: "After replay",
			actor: "test",
		});
		expect(next.id).toBe("task-0002");

		replayed.db.close();
	});

	it("openStoreReadOnly replays events.jsonl in memory without writing store.db", async () => {
		t = await makeStore();
		const id = createItem(t.store, {
			kind: "constitution",
			title: "Shared values",
			actor: "test",
		}).id;
		appendEvent(t.store, {
			item: id,
			type: "body.updated",
			payload: { body: "Updated body" },
			actor: "test",
		});

		const dbPath = t.store.path;
		const jsonlPath = join(t.store.dir, "events.jsonl");
		t.store.db.close();
		unlinkSync(dbPath);
		expect(existsSync(dbPath)).toBe(false);
		expect(existsSync(jsonlPath)).toBe(true);

		const snapshotSize = readFileSync(jsonlPath, "utf-8").length;

		const readOnly = openStoreReadOnly(t.store.dir);
		expect(readOnly).toBeDefined();
		if (!readOnly) throw new Error("expected readOnly store");
		expect(existsSync(dbPath)).toBe(false);
		expect(getItem(readOnly, id)?.title).toBe("Shared values");
		expect(getItem(readOnly, id)?.body).toBe("Updated body");
		expect(readFileSync(jsonlPath, "utf-8").length).toBe(snapshotSize);

		readOnly.db.close();
	});

	it("malformed events.jsonl fails loudly", async () => {
		t = await makeStore();
		createItem(t.store, { kind: "spec", title: "x", actor: "test" });
		t.store.db.close();
		unlinkSync(t.store.path);

		const jsonlPath = join(t.store.dir, "events.jsonl");
		const original = readFileSync(jsonlPath, "utf-8");
		writeFileSync(jsonlPath, `${original}\n{not-json}\n`);

		await expect(openStore(t.dir)).rejects.toThrow(/events.jsonl/);

		// restore for cleanup
		writeFileSync(jsonlPath, original);
	});

	it("applyImport persists events to jsonl so imports survive replay", async () => {
		t = await makeStore();
		const mapped: MappedSnapshot = {
			items: [
				{
					originId: "atom-1",
					kind: "task",
					title: "Imported task",
					body: "body from grill",
					status: "approved",
					scope: null,
					originalStatus: "accepted",
					originalType: "decision",
					promotedTo: null,
					sources: null,
					createdAt: Date.now(),
				},
			],
			links: [],
			skippedEdges: [],
		};
		const plan = planImport(t.store, mapped, "batch-1");
		const idMap = new Map<string, string>();
		for (const c of plan.created) idMap.set(c.originId, c.itemId);
		applyImport(t.store, plan.steps, plan.links, idMap, "batch-1", "grill");

		const jsonlPath = join(t.store.dir, "events.jsonl");
		expect(existsSync(jsonlPath)).toBe(true);

		const id = idMap.get("atom-1") ?? "";
		expect(getItem(t.store, id)?.title).toBe("Imported task");

		t.store.db.close();
		unlinkSync(t.store.path);

		const replayed = await openStore(t.dir);
		expect(getItem(replayed, id)?.title).toBe("Imported task");
		expect(getItem(replayed, id)?.status).toBe("approved");
		expect(history(replayed, id).map((e) => e.type)).toEqual([
			"created",
			"imported",
		]);
		replayed.db.close();
	});
});
