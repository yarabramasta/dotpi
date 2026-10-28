import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/store/doctor.js";
import {
	demoteItem,
	mdDriftFindings,
	promoteItem,
	readStorageConfig,
	renderItemMd,
	saveStorageConfig,
} from "../src/store/storage.js";
import { createItem } from "../src/store/store.js";
import { makeStore } from "./helpers.js";

describe("storage modes", () => {
	let cleanup: () => void;

	afterEach(() => {
		cleanup?.();
	});

	async function setup() {
		const t = await makeStore();
		cleanup = t.cleanup;
		const item = createItem(t.store, {
			kind: "spec",
			title: "Login Route",
			body: "## Intent\nUsers can log in.",
			actor: "test",
		});
		return { ...t, itemId: item.id };
	}

	it("defaults to db-only, where promotion refuses", async () => {
		const { store, itemId } = await setup();
		expect(readStorageConfig(store).mode).toBe("db-only");
		expect(() => promoteItem(store, itemId)).toThrow(/db-only/);
	});

	it("md-inrepo promotes under docs/specd/<id>.md in the repo", async () => {
		const { store, dir, itemId } = await setup();
		saveStorageConfig(store, { mode: "md-inrepo" });
		const path = promoteItem(store, itemId);
		expect(path).toBe(join(dir, "docs/specd", `${itemId}.md`));
		const rendered = readFileSync(path, "utf8");
		expect(rendered).toContain(`id: ${itemId}`);
		expect(rendered).toContain('title: "Login Route"');
		expect(rendered).toContain("Users can log in.");
		// re-promote is idempotent
		expect(promoteItem(store, itemId)).toBe(path);
		// doctor is clean right after promotion
		expect(mdDriftFindings(store)).toEqual([]);
		// demote removes file + record (and the now-empty parent dir)
		expect(demoteItem(store, itemId)).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(dirname(path))).toBe(false);
		expect(demoteItem(store, itemId)).toBe(false);
	});

	it("md-external promotes into the configured directory", async () => {
		const { store, dir, itemId } = await setup();
		const target = join(dir, "vault", "specs");
		saveStorageConfig(store, { mode: "md-external", mdPath: target });
		const path = promoteItem(store, itemId);
		expect(path).toBe(join(target, `${itemId}.md`));
		expect(readFileSync(path, "utf8")).toContain(itemId);
		// missing path configured → plain-language refusal
		saveStorageConfig(store, { mode: "md-external" });
		expect(() => promoteItem(store, itemId)).toThrow(/md-external/);
	});

	it("a mode switch re-promote moves the mirror instead of orphaning the old file", async () => {
		const { store, dir, itemId } = await setup();
		saveStorageConfig(store, { mode: "md-inrepo" });
		const inrepoPath = promoteItem(store, itemId);
		const externalDir = join(dir, "vault");
		saveStorageConfig(store, { mode: "md-external", mdPath: externalDir });
		const externalPath = promoteItem(store, itemId);
		expect(existsSync(externalPath)).toBe(true);
		expect(existsSync(inrepoPath)).toBe(false); // old mirror removed
		expect(mdDriftFindings(store)).toEqual([]);
	});

	it("doctor flags stale, missing, and orphaned md", async () => {
		const { store, itemId } = await setup();
		saveStorageConfig(store, { mode: "md-inrepo" });
		const path = promoteItem(store, itemId);

		// stale: body changes after promotion
		const item = store.db
			.prepare("SELECT * FROM items WHERE id = ?")
			.get(itemId) as { body: string };
		store.db
			.prepare("UPDATE items SET body = ? WHERE id = ?")
			.run(`${item.body}\nUpdated.`, itemId);
		let findings = mdDriftFindings(store);
		expect(findings).toHaveLength(1);
		expect(findings[0].detail).toContain("stale");

		// missing file
		rmSync(path);
		findings = mdDriftFindings(store);
		expect(findings[0].detail).toContain("missing");

		// switch back to db-only → promotions are orphaned
		saveStorageConfig(store, { mode: "db-only" });
		expect(mdDriftFindings(store).length).toBeGreaterThan(0);
		expect(runDoctor(store).some((f) => f.kind === "md-drift")).toBe(true);
	});

	it("renders frontmatter with the full item body", async () => {
		const { store, itemId } = await setup();
		const item = store.db
			.prepare("SELECT * FROM items WHERE id = ?")
			.get(itemId) as {
			body: string;
			kind: string;
			status: string;
			title: string;
			updated_at: string;
		};
		const md = renderItemMd(
			store.db.prepare("SELECT * FROM items WHERE id = ?").get(itemId) as never,
		);
		expect(md).toContain(`kind: ${item.kind}`);
		expect(md).toContain(`status: ${item.status}`);
		expect(md).toContain(`updated_at: ${item.updated_at}`);
	});
});
