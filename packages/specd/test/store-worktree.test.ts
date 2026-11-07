import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	lookupStore,
	registerStore,
	resolveStoreDir,
} from "../src/store/registry.js";
import { createItem, openStore } from "../src/store/store.js";

describe("worktree-aware store resolution", () => {
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

	function makeRepo(name: string): string {
		const repo = mkdtempSync(join(tmpdir(), `specd-${name}-`));
		dirs.push(repo);
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "test@fixture"]);
		execFileSync("git", [
			"-C",
			repo,
			"commit",
			"--allow-empty",
			"-q",
			"-m",
			"init",
		]);
		return repo;
	}

	function addWorktree(repo: string, name: string): string {
		const wt = mkdtempSync(join(dirname(repo), `specd-${name}-wt-`));
		execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt]);
		dirs.push(wt);
		return wt;
	}

	it("maps a linked worktree to the main checkout's store dir", () => {
		const repo = makeRepo("repo");
		const wt = addWorktree(repo, "repo");
		expect(resolveStoreDir(wt)).toBe(resolveStoreDir(repo));
	});

	it("resolves a registered main-repo store from a worktree", () => {
		const repo = makeRepo("repo");
		const wt = addWorktree(repo, "repo");
		const externalStore = mkdtempSync(join(tmpdir(), "specd-external-"));
		dirs.push(externalStore);
		const canonicalExternal = realpathSync.native(externalStore);
		registerStore(repo, { type: "external", storePath: externalStore });
		expect(resolveStoreDir(wt)).toBe(canonicalExternal);
		expect(lookupStore(repo)).toBeDefined();
	});

	it("falls back to the main repo's in-repo default from a worktree", () => {
		const repo = makeRepo("repo");
		const wt = addWorktree(repo, "repo");
		expect(resolveStoreDir(wt)).toBe(resolveStoreDir(repo));
	});

	it("uses the same store when opened from a worktree", async () => {
		const repo = makeRepo("repo");
		const wt = addWorktree(repo, "repo");
		const mainStore = await openStore(repo);
		const wtStore = await openStore(wt);
		try {
			expect(wtStore.dir).toBe(mainStore.dir);
			createItem(mainStore, { kind: "spec", title: "Via main", actor: "test" });
			const count = mainStore.db
				.prepare("SELECT COUNT(*) AS n FROM items")
				.get() as { n: number };
			expect(
				wtStore.db
					.prepare("SELECT COUNT(*) AS n FROM items")
					.get() as typeof count,
			).toEqual(count);
			expect(count.n).toBe(1);
		} finally {
			mainStore.db.close();
			wtStore.db.close();
		}
	});

	it("does not change non-worktree resolution", () => {
		const repo = makeRepo("repo");
		expect(resolveStoreDir(repo)).toBe(
			join(realpathSync.native(repo), ".spec"),
		);
		const externalStore = mkdtempSync(join(tmpdir(), "specd-external-"));
		dirs.push(externalStore);
		const canonicalExternal = realpathSync.native(externalStore);
		registerStore(repo, { type: "external", storePath: externalStore });
		expect(resolveStoreDir(repo)).toBe(canonicalExternal);
	});
});
