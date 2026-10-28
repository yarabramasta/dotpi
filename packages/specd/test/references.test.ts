import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryItems } from "../src/query.js";
import {
	addStoreReference,
	resolveReferenceStores,
} from "../src/store/registry.js";
import {
	appendEvent,
	createItem,
	getItem,
	openStoreReadOnly,
} from "../src/store/store.js";
import { parseReferenceTarget } from "../src/tools/sink-tools.js";
import { makeStore } from "./helpers.js";

describe("reference tools", () => {
	const dirs: string[] = [];
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "specd-references-"));
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

	it("parseReferenceTarget classifies git and path targets", () => {
		expect(parseReferenceTarget("https://example.com/repo.git")).toEqual({
			kind: "git",
			url: "https://example.com/repo.git",
			slug: "repo",
		});
		expect(parseReferenceTarget("http://example.com/repo.git")).toEqual({
			kind: "git",
			url: "http://example.com/repo.git",
			slug: "repo",
		});
		expect(parseReferenceTarget("ssh://git@example.com/repo.git")).toEqual({
			kind: "git",
			url: "ssh://git@example.com/repo.git",
			slug: "repo",
		});
		expect(parseReferenceTarget("/abs/path/to/store")).toEqual({
			kind: "path",
			target: "/abs/path/to/store",
		});
		expect(parseReferenceTarget("  /another/path  ")).toEqual({
			kind: "path",
			target: "/another/path",
		});
	});

	it("openStoreReadOnly rejects writes and missing stores", async () => {
		const local = await makeStore();
		dirs.push(local.dir);
		const item = createItem(local.store, {
			kind: "task",
			title: "existing",
			actor: "test",
		});

		const readOnly = openStoreReadOnly(local.store.dir);
		expect(readOnly).toBeDefined();
		if (!readOnly) throw new Error("expected readOnly store");
		expect(() =>
			createItem(readOnly, {
				kind: "spec",
				title: "write attempt",
				actor: "test",
			}),
		).toThrow();
		expect(() =>
			appendEvent(readOnly, {
				item: item.id,
				type: "body.updated",
				payload: { body: "x" },
				actor: "test",
			}),
		).toThrow();

		const emptyDir = mkdtempSync(join(tmpdir(), "specd-empty-"));
		dirs.push(emptyDir);
		expect(openStoreReadOnly(emptyDir)).toBeUndefined();

		local.cleanup();
	});

	it("openStoreReadOnly on events.jsonl-only store rejects writes without touching jsonl", async () => {
		const ref = await makeStore();
		dirs.push(ref.dir);
		const item = createItem(ref.store, {
			kind: "constitution",
			title: "Shared values",
			actor: "test",
		});
		appendEvent(ref.store, {
			item: item.id,
			type: "body.updated",
			payload: { body: "Updated body" },
			actor: "test",
		});

		ref.store.db.close();
		unlinkSync(ref.store.path);
		expect(existsSync(ref.store.path)).toBe(false);

		const jsonlPath = join(ref.store.dir, "events.jsonl");
		const snapshotSize = readFileSync(jsonlPath, "utf-8").length;

		const readOnly = openStoreReadOnly(ref.store.dir);
		expect(readOnly).toBeDefined();
		if (!readOnly) throw new Error("expected readOnly store");
		expect(existsSync(ref.store.path)).toBe(false);
		expect(getItem(readOnly, item.id)?.body).toBe("Updated body");

		expect(() =>
			createItem(readOnly, {
				kind: "spec",
				title: "write attempt",
				actor: "test",
			}),
		).toThrow(/read-only/i);
		expect(() =>
			appendEvent(readOnly, {
				item: item.id,
				type: "work.started",
				actor: "test",
			}),
		).toThrow(/read-only/i);

		expect(existsSync(ref.store.path)).toBe(false);
		expect(readFileSync(jsonlPath, "utf-8").length).toBe(snapshotSize);

		readOnly.db.close();
	});

	it("addStoreReference + queryItems spans referenced stores", async () => {
		const local = await makeStore();
		dirs.push(local.dir);
		const ref = await makeStore();
		dirs.push(ref.dir);

		const localItem = createItem(local.store, {
			kind: "spec",
			title: "Local spec",
			actor: "test",
		});
		const remoteItem = createItem(ref.store, {
			kind: "constitution",
			title: "Shared constitution",
			body: "values",
			actor: "test",
		});

		const result = addStoreReference(local.store.cwd, ref.store.dir);
		expect(result).toEqual({ ok: true, refs: [ref.store.dir] });
		expect(resolveReferenceStores(local.store.cwd)).toEqual([ref.store.dir]);

		const referenced = openStoreReadOnly(ref.store.dir);
		expect(referenced).toBeDefined();
		if (!referenced) throw new Error("expected referenced store");
		const rows = queryItems(local.store, {}, [referenced]);
		expect(rows.map((r) => r.id).sort()).toEqual(
			[localItem.id, remoteItem.id].sort(),
		);
		const remoteRow = rows.find((r) => r.id === remoteItem.id);
		expect(remoteRow?.source).toBe(ref.store.dir);

		local.cleanup();
		ref.cleanup();
	});
});
