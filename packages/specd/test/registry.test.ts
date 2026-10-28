import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addStoreReference,
	registerStore,
	resolveReferenceStores,
	resolveStoreDir,
	storesRoot,
} from "../src/store/registry.js";

describe("store registry references", () => {
	const dirs: string[] = [];
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "specd-registry-"));
		dirs.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		dirs.length = 0;
	});

	it("storesRoot lives next to the registry", () => {
		const agentDir = process.env.PI_CODING_AGENT_DIR as string;
		expect(storesRoot()).toBe(join(agentDir, "stores"));
	});

	it("unregistered repo has empty references", () => {
		const repo = mkdtempSync(join(tmpdir(), "specd-repo-"));
		dirs.push(repo);
		expect(resolveReferenceStores(repo)).toEqual([]);
	});

	it("rejects referencing the repo's own registered storePath", () => {
		const repo = mkdtempSync(join(tmpdir(), "specd-repo-"));
		const ref = mkdtempSync(join(tmpdir(), "specd-ref-"));
		dirs.push(repo, ref);

		registerStore(repo, { type: "external", storePath: ref });
		const result = addStoreReference(repo, ref);

		expect(result).toEqual({
			ok: false,
			reason: "cannot reference the repo's own store",
		});
		expect(resolveReferenceStores(repo)).toEqual([]);
	});

	it("resolveReferenceStores returns absolute paths", () => {
		const repo = mkdtempSync(join(tmpdir(), "specd-repo-"));
		const ref = mkdtempSync(join(tmpdir(), "specd-ref-"));
		dirs.push(repo, ref);

		registerStore(repo, { type: "in-repo" });
		const relativeRef = relative(process.cwd(), ref);
		const result = addStoreReference(repo, relativeRef);

		expect(result).toEqual({ ok: true, refs: [ref] });
		expect(resolveReferenceStores(repo)).toEqual([ref]);
		expect(
			JSON.parse(
				readFileSync(
					join(process.env.PI_CODING_AGENT_DIR as string, "specd-stores.json"),
					"utf-8",
				),
			)[repo].references,
		).toEqual([ref]);
	});

	it("rejects duplicate references", () => {
		const repo = mkdtempSync(join(tmpdir(), "specd-repo-"));
		const ref = mkdtempSync(join(tmpdir(), "specd-ref-"));
		dirs.push(repo, ref);

		registerStore(repo, { type: "in-repo" });
		addStoreReference(repo, ref);
		const second = addStoreReference(repo, ref);

		expect(second).toEqual({ ok: false, reason: "reference already exists" });
		expect(resolveReferenceStores(repo)).toEqual([ref]);
	});

	it("rejects self-reference", () => {
		const repo = mkdtempSync(join(tmpdir(), "specd-repo-"));
		dirs.push(repo);

		const storeDir = resolveStoreDir(repo);
		registerStore(repo, { type: "external", storePath: storeDir });
		const result = addStoreReference(repo, storeDir);

		expect(result).toEqual({
			ok: false,
			reason: "cannot reference the repo's own store",
		});
		expect(resolveReferenceStores(repo)).toEqual([]);
	});

	it("rejects circular references", () => {
		const repoA = mkdtempSync(join(tmpdir(), "specd-repo-a-"));
		const repoB = mkdtempSync(join(tmpdir(), "specd-repo-b-"));
		const storeA = mkdtempSync(join(tmpdir(), "specd-store-a-"));
		const storeB = mkdtempSync(join(tmpdir(), "specd-store-b-"));
		dirs.push(repoA, repoB, storeA, storeB);

		registerStore(repoA, { type: "external", storePath: storeA });
		registerStore(repoB, { type: "external", storePath: storeB });

		// B references A's store.
		addStoreReference(repoB, storeA);

		// A may not reference B's store.
		const result = addStoreReference(repoA, storeB);

		expect(result).toEqual({ ok: false, reason: "circular reference" });
		expect(resolveReferenceStores(repoA)).toEqual([]);
	});

	it("rejects transitive circular references", () => {
		const repoA = mkdtempSync(join(tmpdir(), "specd-repo-a-"));
		const repoB = mkdtempSync(join(tmpdir(), "specd-repo-b-"));
		const repoC = mkdtempSync(join(tmpdir(), "specd-repo-c-"));
		const storeA = mkdtempSync(join(tmpdir(), "specd-store-a-"));
		const storeB = mkdtempSync(join(tmpdir(), "specd-store-b-"));
		const storeC = mkdtempSync(join(tmpdir(), "specd-store-c-"));
		dirs.push(repoA, repoB, repoC, storeA, storeB, storeC);

		registerStore(repoA, { type: "external", storePath: storeA });
		registerStore(repoB, { type: "external", storePath: storeB });
		registerStore(repoC, { type: "external", storePath: storeC });

		// A → B → C.
		addStoreReference(repoA, storeB);
		addStoreReference(repoB, storeC);

		// C → A would close the cycle.
		const result = addStoreReference(repoC, storeA);

		expect(result).toEqual({ ok: false, reason: "circular reference" });
		expect(resolveReferenceStores(repoC)).toEqual([]);
	});
});
