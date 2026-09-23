import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { detectGitbutlerMode } from "./gitbutler-detect.js";

function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function buildGitSkeleton(root: string, configText: string): void {
	mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
	mkdirSync(join(root, ".git", "objects"), { recursive: true });
	writeFileSync(join(root, ".git", "config"), configText);
	writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
}

describe("detectGitbutlerMode", () => {
	let repoRoot: string;

	afterEach(() => {
		if (repoRoot) {
			try {
				rmSync(repoRoot, { recursive: true, force: true });
			} catch {
				// ignore cleanup failures
			}
		}
	});

	test("empty/missing repoRoot returns false with no reasons", () => {
		expect(detectGitbutlerMode("")).toEqual({
			isGitbutlerMode: false,
			reasons: [],
		});
		expect(detectGitbutlerMode("   ")).toEqual({
			isGitbutlerMode: false,
			reasons: [],
		});
	});

	test("non-git empty directory returns false", () => {
		repoRoot = makeTempDir("gb-plain-");
		expect(detectGitbutlerMode(repoRoot)).toEqual({
			isGitbutlerMode: false,
			reasons: [],
		});
	});

	test("plain git skeleton returns false", () => {
		repoRoot = makeTempDir("gb-plain-");
		buildGitSkeleton(repoRoot, "[core]\n\trepositoryformatversion = 0\n");
		expect(detectGitbutlerMode(repoRoot)).toEqual({
			isGitbutlerMode: false,
			reasons: [],
		});
	});

	test("gitbutler state directory returns true", () => {
		repoRoot = makeTempDir("gb-state-");
		buildGitSkeleton(repoRoot, "[core]\n\trepositoryformatversion = 0\n");
		mkdirSync(join(repoRoot, ".git", "gitbutler"), { recursive: true });
		writeFileSync(join(repoRoot, ".git", "gitbutler", "but.sqlite"), "");
		expect(detectGitbutlerMode(repoRoot)).toEqual({
			isGitbutlerMode: true,
			reasons: ["gitbutler state directory present"],
		});
	});

	test("gitbutler config section returns true", () => {
		repoRoot = makeTempDir("gb-config-");
		buildGitSkeleton(
			repoRoot,
			'[core]\n\trepositoryformatversion = 0\n[gitbutler "project"]\n\tid = abc\n',
		);
		expect(detectGitbutlerMode(repoRoot)).toEqual({
			isGitbutlerMode: true,
			reasons: ["gitbutler project config section present"],
		});
	});

	test("refs/heads/gitbutler/workspace file returns true", () => {
		repoRoot = makeTempDir("gb-ref-");
		buildGitSkeleton(repoRoot, "[core]\n\trepositoryformatversion = 0\n");
		mkdirSync(join(repoRoot, ".git", "refs", "heads", "gitbutler"), {
			recursive: true,
		});
		writeFileSync(
			join(repoRoot, ".git", "refs", "heads", "gitbutler", "workspace"),
			"0000000000000000000000000000000000000000\n",
		);
		expect(detectGitbutlerMode(repoRoot)).toEqual({
			isGitbutlerMode: true,
			reasons: ["gitbutler refs present"],
		});
	});

	test("packed-refs containing gitbutler target returns true", () => {
		repoRoot = makeTempDir("gb-packed-");
		buildGitSkeleton(repoRoot, "[core]\n\trepositoryformatversion = 0\n");
		writeFileSync(
			join(repoRoot, ".git", "packed-refs"),
			"# pack-refs with: peeled fully-peeled sorted\n0000000000000000000000000000000000000000 refs/heads/main\n0000000000000000000000000000000000000000 refs/heads/gitbutler/target\n",
		);
		expect(detectGitbutlerMode(repoRoot)).toEqual({
			isGitbutlerMode: true,
			reasons: ["gitbutler refs present"],
		});
	});

	test(".git file with gitdir pointer to gitbutler dir returns true", () => {
		repoRoot = makeTempDir("gb-worktree-");
		const gitDir = makeTempDir("gb-real-");
		try {
			mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
			mkdirSync(join(gitDir, "objects"), { recursive: true });
			mkdirSync(join(gitDir, "gitbutler"), { recursive: true });
			writeFileSync(join(gitDir, "gitbutler", "virtual_branches.toml"), "");
			writeFileSync(
				join(gitDir, "config"),
				"[core]\n\trepositoryformatversion = 0\n",
			);
			writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
			writeFileSync(join(repoRoot, ".git"), `gitdir: ${gitDir}\n`);

			expect(detectGitbutlerMode(repoRoot)).toEqual({
				isGitbutlerMode: true,
				reasons: ["gitbutler state directory present"],
			});
		} finally {
			rmSync(gitDir, { recursive: true, force: true });
		}
	});

	test("multiple signals list all reasons", () => {
		repoRoot = makeTempDir("gb-multi-");
		buildGitSkeleton(repoRoot, '[core]\n[gitbutler "project"]\n\tid = abc\n');
		mkdirSync(join(repoRoot, ".git", "gitbutler"), { recursive: true });
		writeFileSync(join(repoRoot, ".git", "gitbutler", "but.sqlite"), "");
		mkdirSync(join(repoRoot, ".git", "refs", "heads", "gitbutler"), {
			recursive: true,
		});
		writeFileSync(
			join(repoRoot, ".git", "refs", "heads", "gitbutler", "workspace"),
			"",
		);
		const result = detectGitbutlerMode(repoRoot);
		expect(result.isGitbutlerMode).toBe(true);
		expect(result.reasons).toEqual([
			"gitbutler refs present",
			"gitbutler state directory present",
			"gitbutler project config section present",
		]);
	});
});
