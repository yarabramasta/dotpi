import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../store/doctor.js";
import { createItem } from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

let t: TestStore;

afterEach(() => {
	t?.cleanup();
});

describe("specd doctor", () => {
	it("reports clean on a fresh store", async () => {
		t = await makeStore();
		createItem(t.store, { kind: "spec", title: "Auth", actor: "test" });
		const findings = runDoctor(t.store);
		expect(findings).toEqual([]);
	});

	it("detects projection drift (stored row edited outside the event path)", async () => {
		t = await makeStore();
		const spec = createItem(t.store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		t.store.db
			.prepare("UPDATE items SET status = 'done' WHERE id = ?")
			.run(spec.id);
		const findings = runDoctor(t.store);
		const drift = findings.filter((f) => f.kind === "projection-drift");
		expect(drift).toHaveLength(1);
		expect(drift[0]?.detail).toContain(spec.id);
	});

	it("detects a search index drift", async () => {
		t = await makeStore();
		createItem(t.store, { kind: "spec", title: "Auth", actor: "test" });
		t.store.db.prepare("DELETE FROM item_fts").run();
		const findings = runDoctor(t.store);
		expect(findings.some((f) => f.kind === "search-index")).toBe(true);
	});

	it("detects orphan links when foreign keys are bypassed", async () => {
		t = await makeStore();
		// Same connection; FK pragma applies outside transactions.
		t.store.db.exec("PRAGMA foreign_keys = OFF");
		t.store.db
			.prepare(
				"INSERT INTO links (from_item, to_item, kind) VALUES ('task-9999', 'spec-9999', 'part-of')",
			)
			.run();
		const findings = runDoctor(t.store);
		expect(findings.some((f) => f.kind === "orphan-link")).toBe(true);
	});

	it("reports schema mismatch", async () => {
		t = await makeStore();
		t.store.db
			.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
			.run();
		const findings = runDoctor(t.store);
		expect(findings.some((f) => f.kind === "schema")).toBe(true);
	});
});
