import type { execFileSync as nodeExecFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyRow,
	dedupDependencies,
	resolvePrimaryWorktree,
	rowInIgnoredDir,
} from "../src/worktree/apply.js";
import type { DepRow } from "../src/worktree/deps.js";

describe("worktree dependency dedup application", () => {
	const dirs: string[] = [];

	beforeEach(() => {
		dirs.length = 0;
	});

	afterEach(() => {
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeFixture() {
		const dir = mkdtempSync(join(tmpdir(), "specd-apply-"));
		dirs.push(dir);
		return dir;
	}

	function touch(dir: string, relpath: string, content = "") {
		const path = join(dir, relpath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	interface ExecCall {
		command: string;
		args: string[];
		cwd?: string;
		stdio?: string;
	}

	function fakeExec(handlers: Record<string, (args: string[]) => string>): {
		exec: typeof nodeExecFileSync;
		calls: ExecCall[];
	} {
		const calls: ExecCall[] = [];
		const exec = ((
			command: string,
			args: readonly string[],
			options?: { cwd?: string; stdio?: string },
		) => {
			const handler = handlers[command];
			calls.push({
				command,
				args: [...args],
				cwd: options?.cwd,
				stdio: options?.stdio,
			});
			if (handler) return handler([...args]);
			return "";
		}) as typeof nodeExecFileSync;
		return { exec, calls };
	}

	describe("resolvePrimaryWorktree", () => {
		it("parses the first worktree line from porcelain output", () => {
			const dir = makeFixture();
			const { exec } = fakeExec({
				git: () =>
					`worktree ${dir}\nHEAD abc123\nbranch refs/heads/main\n\nworktree /other\n`,
			});
			expect(resolvePrimaryWorktree("/some/cwd", exec)).toBe(dir);
		});

		it("throws when no worktree lines are present", () => {
			const { exec } = fakeExec({ git: () => "HEAD abc123\n" });
			expect(() => resolvePrimaryWorktree("/cwd", exec)).toThrow(
				/No worktree entries found/,
			);
		});
	});

	describe("ignored directory guard", () => {
		it("flags a row dir inside an ignored directory", () => {
			const worktree = makeFixture();
			expect(rowInIgnoredDir(join(worktree, ".gradle", "foo"), worktree)).toBe(
				true,
			);
			expect(
				rowInIgnoredDir(join(worktree, "build", "node_modules"), worktree),
			).toBe(true);
			expect(rowInIgnoredDir(join(worktree, "src", "app"), worktree)).toBe(
				false,
			);
		});

		it("refuses to apply a row whose dir is inside an ignored directory", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			const { exec, calls } = fakeExec({});
			const row: DepRow = {
				manager: "npm/yarn/bun",
				dir: join(worktree, ".gradle", "foo"),
				action: "link",
				reason: "lockfiles match",
			};

			const result = applyRow(row, primary, worktree, {
				execFileSync: exec,
			});

			expect(result.line).toBe(
				"npm/yarn/bun: skipped — refused: row dir is inside an ignored directory",
			);
			expect(result.error).toBeUndefined();
			expect(calls).toHaveLength(0);
		});
	});

	describe("dedupDependencies", () => {
		it("creates a relative symlink when lockfiles match", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			mkdirSync(join(primary, "node_modules"));
			writeFileSync(join(primary, "node_modules", "marker"), "ok");

			const { exec } = fakeExec({});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: linked");
			expect(realpathSync(join(worktree, "node_modules"))).toBe(
				realpathSync(join(primary, "node_modules")),
			);
			const target = readlinkSync(join(worktree, "node_modules"));
			expect(target).toBe(relative(worktree, join(primary, "node_modules")));
			expect(existsSync(join(worktree, "node_modules", "marker"))).toBe(true);
		});

		it("converts an existing real directory to a symlink on resume", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			mkdirSync(join(primary, "node_modules"), { recursive: true });
			writeFileSync(join(primary, "node_modules", "marker"), "primary");
			mkdirSync(join(worktree, "node_modules"), { recursive: true });
			writeFileSync(join(worktree, "node_modules", "marker"), "worktree");

			const { exec } = fakeExec({});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: linked");
			expect(realpathSync(join(worktree, "node_modules"))).toBe(
				realpathSync(join(primary, "node_modules")),
			);
			expect(existsSync(join(worktree, "node_modules", "marker"))).toBe(true);
			expect(
				readFileSync(join(worktree, "node_modules", "marker"), "utf8"),
			).toBe("primary");
		});

		it("falls back to install when lockfiles mismatch", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "a");
			touch(worktree, "package-lock.json", "b");

			const { exec, calls } = fakeExec({
				npm: () => "",
			});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: installed");
			expect(summary).toContain("lockfiles mismatch");
			expect(calls).toEqual([
				{ command: "npm", args: ["ci"], cwd: worktree, stdio: "pipe" },
			]);
		});

		it("runs pnpm install with frozen-lockfile", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(worktree, "pnpm-lock.yaml", "");

			const { exec, calls } = fakeExec({
				pnpm: () => "",
			});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("pnpm: installed");
			expect(summary).toContain("always install");
			expect(calls).toEqual([
				{
					command: "pnpm",
					args: ["install", "--frozen-lockfile"],
					cwd: worktree,
					stdio: "pipe",
				},
			]);
		});

		it("skips linking and reports CI=true", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			mkdirSync(join(primary, "node_modules"));

			const { exec, calls } = fakeExec({
				npm: () => "",
			});

			const { summary } = dedupDependencies(primary, worktree, {
				ci: true,
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: installed");
			expect(summary).toContain("guard passed but CI");
			expect(existsSync(join(worktree, "node_modules"))).toBe(false);
			expect(calls.length).toBeGreaterThan(0);
		});

		it("replaces a broken symlink with a real install", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			mkdirSync(join(primary, "node_modules"));
			symlinkSync("/nonexistent/path", join(worktree, "node_modules"));

			const { exec, calls } = fakeExec({
				npm: () => "",
			});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: installed");
			expect(summary).toContain("broken symlink");
			expect(calls).toEqual([
				{ command: "npm", args: ["ci"], cwd: worktree, stdio: "pipe" },
			]);
			const stat = lstatSync(join(worktree, "node_modules"), {
				throwIfNoEntry: false,
			});
			expect(stat?.isSymbolicLink() ?? false).toBe(false);
		});

		it("does nothing for Gradle-only repos", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "settings.gradle", "");

			const { exec, calls } = fakeExec({});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("gradle: skipped");
			expect(summary).not.toContain("linked");
			expect(calls).toHaveLength(0);
		});

		it("reports when no ecosystems are detected", () => {
			const primary = makeFixture();
			const worktree = makeFixture();

			const { exec, calls } = fakeExec({});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toBe("no dependency ecosystems detected");
			expect(calls).toHaveLength(0);
		});

		it("uses yarn --immutable when yarn.lock is present", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(worktree, "yarn.lock", "");

			const { exec, calls } = fakeExec({
				yarn: () => "",
			});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: installed");
			expect(summary).toContain("lockfile absent on one or both sides");
			expect(calls).toEqual([
				{
					command: "yarn",
					args: ["--immutable"],
					cwd: worktree,
					stdio: "pipe",
				},
			]);
		});

		it("uses bun install when bun.lockb is present", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(worktree, "bun.lockb", "");

			const { exec, calls } = fakeExec({
				bun: () => "",
			});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: installed");
			expect(calls).toEqual([
				{ command: "bun", args: ["install"], cwd: worktree, stdio: "pipe" },
			]);
		});

		it("uses npm install as fallback with no lockfile", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");

			const { exec, calls } = fakeExec({
				npm: () => "",
			});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("npm/yarn/bun: installed");
			expect(calls).toEqual([
				{ command: "npm", args: ["install"], cwd: worktree, stdio: "pipe" },
			]);
		});

		it("constructs composer and cocoapods install commands without executing them", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "composer.json", "{}");
			touch(worktree, "Podfile", "");

			const { exec, calls } = fakeExec({});

			const { summary } = dedupDependencies(primary, worktree, {
				execFileSync: exec,
			});

			expect(summary).toContain("composer: installed");
			expect(summary).toContain("cocoapods: installed");
			expect(calls).toContainEqual({
				command: "composer",
				args: ["install", "--no-interaction"],
				cwd: worktree,
				stdio: "pipe",
			});
			expect(calls).toContainEqual({
				command: "pod",
				args: ["install"],
				cwd: worktree,
				stdio: "pipe",
			});
		});
	});
});
