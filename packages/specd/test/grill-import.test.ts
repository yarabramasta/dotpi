import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAtom, addEdge as grillAddEdge } from "../../grill/atom/atoms.js";
import type { AtomStore } from "../../grill/atom/store.js";
import { applySchema, atomPaths } from "../../grill/atom/store.js";
import { snapshotGrill } from "../import/grill-source.js";
import { mapAtom, mapEdge, mapSnapshot } from "../import/map.js";
import {
	applyImport,
	listImportBatches,
	planImport,
	revertImport,
} from "../import/run.js";
import { runDoctor } from "../src/store/doctor.js";
import { addLink, appendEvent, createItem } from "../src/store/store.js";
import { makeStore } from "./helpers.js";

function makeGrillFixture(): {
	store: AtomStore;
	dir: string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "grill-fixture-"));
	const paths = atomPaths(dir);
	mkdirSync(paths.dir, { recursive: true });
	const db = new DatabaseSync(paths.dbPath);
	applySchema(db);
	const store: AtomStore = { db, paths, cwd: dir };
	return {
		store,
		dir,
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("grill→specd import", () => {
	let fixture: ReturnType<typeof makeGrillFixture>;
	let store: Awaited<ReturnType<typeof makeStore>>;

	beforeEach(async () => {
		fixture = makeGrillFixture();
		store = await makeStore();
	});

	afterEach(() => {
		fixture.cleanup();
		store.cleanup();
	});

	it("maps each grill type to the correct specd kind", () => {
		const cases = [
			{ type: "plan", expected: "plan" },
			{ type: "decision", expected: "application" },
			{ type: "research", expected: "application" },
			{ type: "spike", expected: "application" },
			{ type: "validation", expected: "application" },
			{ type: "concept", expected: "domain" },
			{ type: "content", expected: "product" },
			{ type: "requirement", expected: "domain" },
		];
		for (const c of cases) {
			const mapped = mapAtom({
				id: `${c.type}-9999`,
				type: c.type,
				title: `T`,
				status: "draft",
				body: "",
				scope: null,
				created_at: 0,
				promoted_to: null,
				sources: null,
			});
			expect(mapped.kind, `${c.type} → ${c.expected}`).toBe(c.expected);
			expect(mapped.originalType).toBe(c.type);
			expect(mapped.body).toContain(`type=${c.type}`);
		}
	});

	it("preserves grill statuses via the original_status body marker", () => {
		const accepted = mapAtom({
			id: "dec-0001",
			type: "decision",
			title: "t",
			status: "accepted",
			body: "",
			scope: null,
			created_at: 0,
			promoted_to: null,
			sources: null,
		});
		expect(accepted.status).toBe("approved");
		expect(accepted.originalStatus).toBe("accepted");

		const superseded = mapAtom({
			id: "con-0001",
			type: "concept",
			title: "t",
			status: "superseded",
			body: "",
			scope: null,
			created_at: 0,
			promoted_to: null,
			sources: null,
		});
		expect(superseded.status).toBe("stopped");
	});

	it("drops promoted-to edges and keeps the pointer as provenance", () => {
		createAtom(fixture.store, {
			type: "decision",
			title: "A",
			body: "",
		});
		createAtom(fixture.store, {
			type: "decision",
			title: "B",
			body: "",
		});
		grillAddEdge(fixture.store, "dec-0001", "dec-0002", "depends-on");
		grillAddEdge(fixture.store, "dec-0001", "dec-0002", "promoted-to");
		const snap = snapshotGrill(fixture.dir);
		const mapped = mapSnapshot(snap);
		expect(mapped.links).toHaveLength(1);
		expect(mapped.links[0]?.kind).toBe("depends-on");
		expect(mapped.skippedEdges).toHaveLength(1);
	});

	it("drops edges with unknown kinds", () => {
		const mapped = mapEdge({
			from_id: "a",
			to_id: "b",
			kind: "not-a-kind",
			created_at: 0,
		});
		expect(mapped).toBeUndefined();
	});

	it("imports a snapshot in one transaction, then re-runs are no-ops", () => {
		createAtom(fixture.store, {
			type: "concept",
			title: "Auth model",
			body: "OAuth + session",
		});
		createAtom(fixture.store, {
			type: "decision",
			title: "Pick JWT",
			body: "",
		});
		grillAddEdge(fixture.store, "dec-0001", "con-0001", "cited");

		const snap = snapshotGrill(fixture.dir);
		const mapped = mapSnapshot(snap);
		const plan = planImport(store.store, mapped, "test-batch");
		expect(plan.steps).toHaveLength(2);
		const idMap = new Map<string, string>();
		for (const c of plan.created) idMap.set(c.originId, c.itemId);
		const report = applyImport(
			store.store,
			plan.steps,
			plan.links,
			idMap,
			"test-batch",
			"test",
		);
		expect(report.created).toHaveLength(2);
		expect(report.linksAdded).toBe(1);

		// Event history: created first (with the mapped status seed), then
		// imported provenance; replay reproduces the stored rows, so doctor
		// is clean and FTS is populated.
		const histories = store.store.db
			.prepare("SELECT item, type FROM events ORDER BY item, id")
			.all() as unknown as Array<{ item: string; type: string }>;
		const grouped = new Map<string, string[]>();
		for (const { item, type } of histories) {
			const list = grouped.get(item) ?? [];
			list.push(type);
			grouped.set(item, list);
		}
		for (const [item, types] of grouped) {
			expect(types, item).toEqual(["created", "imported"]);
		}
		const ftsRows = store.store.db
			.prepare("SELECT COUNT(*) AS n FROM item_fts")
			.get() as { n: number };
		expect(ftsRows.n).toBe(2);
		expect(runDoctor(store.store)).toEqual([]);

		const beforeCounts = store.store.db
			.prepare("SELECT COUNT(*) as c FROM items")
			.get() as { c: number };

		// Re-run: nothing new should be imported.
		const plan2 = planImport(store.store, mapped, "test-batch-2");
		const idMap2 = new Map<string, string>();
		for (const c of plan2.created) idMap2.set(c.originId, c.itemId);
		const report2 = applyImport(
			store.store,
			plan2.steps,
			plan2.links,
			idMap2,
			"test-batch-2",
			"test",
		);
		expect(report2.created).toHaveLength(0);
		expect(report2.linksAdded).toBe(0);

		const afterCounts = store.store.db
			.prepare("SELECT COUNT(*) as c FROM items")
			.get() as { c: number };
		expect(afterCounts.c).toBe(beforeCounts.c);
	});

	it("rolls back atomically when the transaction throws mid-import", () => {
		createAtom(fixture.store, {
			type: "concept",
			title: "First",
			body: "",
		});
		createAtom(fixture.store, {
			type: "concept",
			title: "Second",
			body: "",
		});
		const snap = snapshotGrill(fixture.dir);
		const mapped = mapSnapshot(snap);
		const plan = planImport(store.store, mapped, "test-rollback");
		const idMap = new Map<string, string>();
		for (const c of plan.created) idMap.set(c.originId, c.itemId);

		const before = store.store.db
			.prepare("SELECT COUNT(*) as c FROM items")
			.get() as { c: number };

		// Replace the items-insert prepared statement with one that
		// throws on the first execution. The transaction must roll back
		// entirely — no items, no events.
		const originalPrepare = store.store.db.prepare.bind(store.store.db);
		store.store.db.prepare = (sql: string) => {
			if (sql.startsWith("INSERT INTO items")) {
				return {
					run: () => {
						throw new Error("synthetic mid-import failure");
					},
				} as unknown as ReturnType<typeof originalPrepare>;
			}
			return originalPrepare(sql);
		};

		expect(() =>
			applyImport(store.store, plan.steps, [], idMap, "rollback", "test"),
		).toThrow(/synthetic/);

		const after = store.store.db
			.prepare("SELECT COUNT(*) as c FROM items")
			.get() as { c: number };
		expect(after.c).toBe(before.c);
	});
});

describe("import batch revert", () => {
	let fixture: ReturnType<typeof makeGrillFixture>;
	let store: Awaited<ReturnType<typeof makeStore>>;

	beforeEach(async () => {
		fixture = makeGrillFixture();
		store = await makeStore();
	});

	afterEach(() => {
		fixture.cleanup();
		store.cleanup();
	});

	function importTwoAtoms(): void {
		createAtom(fixture.store, {
			type: "concept",
			title: "Auth model",
			body: "OAuth + session",
		});
		createAtom(fixture.store, {
			type: "decision",
			title: "Pick JWT",
			body: "",
		});
		grillAddEdge(fixture.store, "dec-0001", "con-0001", "cited");
		const snap = snapshotGrill(fixture.dir);
		const mapped = mapSnapshot(snap);
		const plan = planImport(store.store, mapped, "revert-batch");
		const idMap = new Map<string, string>();
		for (const c of plan.created) idMap.set(c.originId, c.itemId);
		applyImport(
			store.store,
			plan.steps,
			plan.links,
			idMap,
			"revert-batch",
			"test",
		);
	}

	it("restores the exact pre-import projection (items, links, FTS, doctor)", () => {
		const pre = store.store.db
			.prepare("SELECT COUNT(*) as c FROM items")
			.get() as { c: number };
		importTwoAtoms();
		expect(
			(
				store.store.db.prepare("SELECT COUNT(*) as c FROM items").get() as {
					c: number;
				}
			).c,
		).toBe(pre.c + 2);
		expect(listImportBatches(store.store)).toEqual([
			{ batch: "revert-batch", items: 2, at: expect.any(String) },
		]);

		const report = revertImport(store.store, "revert-batch");
		expect(report.itemsRemoved).toHaveLength(2);
		expect(report.linksRemoved).toBe(1);
		const post = store.store.db
			.prepare("SELECT COUNT(*) as c FROM items")
			.get() as { c: number };
		expect(post.c).toBe(pre.c);
		expect(
			(
				store.store.db.prepare("SELECT COUNT(*) as c FROM item_fts").get() as {
					c: number;
				}
			).c,
		).toBe(pre.c);
		expect(runDoctor(store.store)).toEqual([]);
		expect(listImportBatches(store.store)).toEqual([]);
	});

	it("refuses when a batch item carries post-import work", () => {
		importTwoAtoms();
		appendEvent(store.store, {
			item: "domain-0001",
			type: "body.updated",
			payload: { body: "edited after import" },
			actor: "test",
		});
		expect(() => revertImport(store.store, "revert-batch")).toThrow(
			/post-import events/,
		);
	});

	it("refuses when a batch item is linked to a native item", () => {
		importTwoAtoms();
		const native = createItem(store.store, {
			kind: "spec",
			title: "Native spec",
			body: "",
			actor: "test",
		});
		addLink(store.store, "domain-0001", native.id, "cited");
		expect(() => revertImport(store.store, "revert-batch")).toThrow(
			/native items/,
		);
	});

	it("names known batches when the batch is unknown", () => {
		expect(() => revertImport(store.store, "nope")).toThrow(
			/Known batches: none/,
		);
		importTwoAtoms();
		expect(() => revertImport(store.store, "nope")).toThrow(/revert-batch/);
	});
});
