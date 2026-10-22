import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySchema, atomPaths } from "../../grill/atom/store.js";
import {
	createAtom,
	addEdge as grillAddEdge,
} from "../../grill/atom/atoms.js";
import type { AtomStore } from "../../grill/atom/store.js";
import { DatabaseSync } from "node:sqlite";
import { makeStore } from "./helpers.js";
import { snapshotGrill } from "../import/grill-source.js";
import { mapAtom, mapEdge, mapSnapshot } from "../import/map.js";
import { planImport, applyImport } from "../import/run.js";

function makeGrillFixture(): { store: AtomStore; dir: string; cleanup: () => void } {
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
			{ type: "decision", expected: "knowledge" },
			{ type: "research", expected: "knowledge" },
			{ type: "spike", expected: "knowledge" },
			{ type: "validation", expected: "knowledge" },
			{ type: "concept", expected: "knowledge" },
			{ type: "content", expected: "knowledge" },
			{ type: "requirement", expected: "knowledge" },
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
		// throws on the second execution. The first row succeeds; the
		// second throws inside BEGIN IMMEDIATE — ROLLBACK must zero it.
		const originalPrepare = store.store.db.prepare.bind(store.store.db);
		let itemCalls = 0;
		store.store.db.prepare = (sql: string) => {
			if (sql.startsWith("INSERT INTO items")) {
				return {
					run: () => {
						itemCalls += 1;
						if (itemCalls >= 2) throw new Error("synthetic mid-import failure");
						return { changes: 1, lastInsertRowid: 0 };
					},
				} as ReturnType<typeof originalPrepare>;
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
