import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalStore, ensureExternalStore } from "../src/store/external.js";

describe("external store", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		dirs.length = 0;
	});

	it("createExternalStore creates the directory, marker, and git repo", () => {
		const repoDir = mkdtempSync(join(tmpdir(), "specd-ext-repo-"));
		dirs.push(repoDir);
		const storePath = join(repoDir, "store");

		createExternalStore(storePath, repoDir);

		expect(existsSync(storePath)).toBe(true);
		expect(existsSync(join(storePath, ".specd-store.yaml"))).toBe(true);
		expect(existsSync(join(storePath, ".git"))).toBe(true);
		expect(existsSync(join(storePath, ".gitignore"))).toBe(true);
	});

	it("ensureExternalStore is idempotent", () => {
		const repoDir = mkdtempSync(join(tmpdir(), "specd-ext-repo-"));
		dirs.push(repoDir);
		const storePath = join(repoDir, "store");

		ensureExternalStore(storePath, repoDir);
		const marker = readFileSync(join(storePath, ".specd-store.yaml"), "utf8");

		ensureExternalStore(storePath, repoDir);

		expect(existsSync(storePath)).toBe(true);
		expect(readFileSync(join(storePath, ".specd-store.yaml"), "utf8")).toBe(
			marker,
		);
	});

	it("marker file contains the correct content", () => {
		const repoDir = mkdtempSync(join(tmpdir(), "specd-ext-repo-"));
		dirs.push(repoDir);
		const repoName = "my-repo";
		const repoPath = join(repoDir, repoName);
		const storePath = join(repoDir, "specd-store");

		createExternalStore(storePath, repoPath);

		const marker = readFileSync(join(storePath, ".specd-store.yaml"), "utf8");
		expect(marker).toBe(`type: specd-store\nversion: 1\nrepo: ${repoName}\n`);
	});
});
