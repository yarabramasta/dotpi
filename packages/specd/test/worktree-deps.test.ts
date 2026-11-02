import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type DepManager,
	detectEcosystems,
	lockfileMatches,
	planDepActions,
	planResumeConversion,
} from "../src/worktree/deps.js";

describe("worktree dependency dedup", () => {
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
		const dir = mkdtempSync(join(tmpdir(), "specd-deps-"));
		dirs.push(dir);
		return dir;
	}

	function touch(dir: string, relpath: string, content = "") {
		const path = join(dir, relpath);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}

	describe("detectEcosystems", () => {
		it("detects npm/yarn/bun when package.json is present without pnpm-lock.yaml", () => {
			const dir = makeFixture();
			touch(dir, "package.json", "{}");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "npm/yarn/bun", dir }]);
		});

		it("detects pnpm when pnpm-lock.yaml is present", () => {
			const dir = makeFixture();
			touch(dir, "package.json", "{}");
			touch(dir, "pnpm-lock.yaml", "");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "pnpm", dir }]);
		});

		it("detects composer", () => {
			const dir = makeFixture();
			touch(dir, "composer.json", "{}");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "composer", dir }]);
		});

		it("detects CocoaPods", () => {
			const dir = makeFixture();
			touch(dir, "Podfile", "");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "cocoapods", dir }]);
		});

		it("detects Flutter and composes ios/android rules", () => {
			const dir = makeFixture();
			touch(dir, "pubspec.yaml", "");
			touch(dir, "ios/Podfile", "");
			touch(dir, "android/build.gradle", "");
			const hits = detectEcosystems(dir);
			expect(hits).toContainEqual({ manager: "flutter", dir });
			expect(hits).toContainEqual({
				manager: "cocoapods",
				dir: join(dir, "ios"),
			});
			expect(hits).toContainEqual({
				manager: "gradle",
				dir: join(dir, "android"),
			});
		});

		it("detects Gradle when settings.gradle exists", () => {
			const dir = makeFixture();
			touch(dir, "settings.gradle.kts", "");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "gradle", dir }]);
		});

		it("detects SwiftPM with Package.resolved and no Podfile", () => {
			const dir = makeFixture();
			touch(dir, "Package.resolved", "");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "swiftpm", dir }]);
		});

		it("detects SwiftPM with an xcodeproj and no Podfile", () => {
			const dir = makeFixture();
			mkdirSync(join(dir, "MyApp.xcodeproj"));
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "swiftpm", dir }]);
		});

		it("prefers CocoaPods over SwiftPM when both are present", () => {
			const dir = makeFixture();
			touch(dir, "Podfile", "");
			touch(dir, "Package.resolved", "");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "cocoapods", dir }]);
		});

		it("skips ignored directories", () => {
			const dir = makeFixture();
			touch(dir, "package.json", "{}");
			touch(dir, "node_modules/nested/package.json", "{}");
			const hits = detectEcosystems(dir);
			expect(hits).toEqual([{ manager: "npm/yarn/bun", dir }]);
		});
	});

	describe("lockfileMatches", () => {
		it("returns match when lockfiles are identical", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			expect(lockfileMatches("npm/yarn/bun", primary, worktree)).toBe("match");
		});

		it("returns mismatch when lockfiles differ", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "package-lock.json", "a");
			touch(worktree, "package-lock.json", "b");
			expect(lockfileMatches("npm/yarn/bun", primary, worktree)).toBe(
				"mismatch",
			);
		});

		it("returns absent when lockfile missing on either side", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "package-lock.json", "lock");
			expect(lockfileMatches("npm/yarn/bun", primary, worktree)).toBe("absent");
			expect(lockfileMatches("npm/yarn/bun", worktree, primary)).toBe("absent");
		});

		it("supports manager-specific lockfiles", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "pnpm-lock.yaml", "lock");
			touch(worktree, "pnpm-lock.yaml", "lock");
			expect(lockfileMatches("pnpm", primary, worktree)).toBe("match");
		});
	});

	describe("planDepActions", () => {
		it("links npm when lockfiles match", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			const rows = planDepActions(primary, worktree);
			expect(rows).toEqual([
				{
					manager: "npm/yarn/bun",
					dir: worktree,
					action: "link",
					reason: "lockfiles match; safe to link node_modules",
				},
			]);
		});

		it("installs npm when lockfiles mismatch", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "a");
			touch(worktree, "package-lock.json", "b");
			const [row] = planDepActions(primary, worktree);
			expect(row.action).toBe("install");
			expect(row.reason).toContain("mismatch");
		});

		it("installs pnpm always", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(worktree, "pnpm-lock.yaml", "");
			const [row] = planDepActions(primary, worktree);
			expect(row.action).toBe("install");
			expect(row.manager).toBe("pnpm");
		});

		it("skips Gradle and SwiftPM", () => {
			const dir = makeFixture();
			touch(dir, "settings.gradle", "");
			touch(dir, "Package.resolved", "");
			const rows = planDepActions(dir, dir);
			expect(rows).toContainEqual(
				expect.objectContaining({
					manager: "gradle",
					action: "skip",
					reason: expect.stringContaining("Gradle caches are shared"),
				}),
			);
			expect(rows).toContainEqual(
				expect.objectContaining({
					manager: "swiftpm",
					action: "skip",
					reason: expect.stringContaining("global package cache"),
				}),
			);
		});

		it("composes Flutter with pub skip, ios Pods, and android Gradle", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "pubspec.yaml", "");
			touch(worktree, "ios/Podfile", "");
			touch(worktree, "android/build.gradle", "");
			touch(primary, "ios/Podfile.lock", "lock");
			touch(worktree, "ios/Podfile.lock", "lock");
			const rows = planDepActions(primary, worktree);
			expect(rows).toContainEqual(
				expect.objectContaining({
					manager: "flutter",
					action: "skip",
					reason: expect.stringContaining("Flutter pub cache"),
				}),
			);
			expect(rows).toContainEqual(
				expect.objectContaining({
					manager: "cocoapods",
					dir: join(worktree, "ios"),
					action: "link",
				}),
			);
			expect(rows).toContainEqual(
				expect.objectContaining({
					manager: "gradle",
					dir: join(worktree, "android"),
					action: "skip",
				}),
			);
		});

		it("forces install and disables links in CI", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(worktree, "package.json", "{}");
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			const rows = planDepActions(primary, worktree, { ci: true });
			expect(rows[0].action).toBe("install");
			expect(rows[0].reason).toContain("CI");
		});
	});

	describe("planResumeConversion", () => {
		it("converts a real duplicated directory to a link when the guard passes", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			mkdirSync(join(worktree, "node_modules"));
			const plan = planResumeConversion(
				"npm/yarn/bun" as DepManager,
				primary,
				worktree,
			);
			expect(plan).toEqual({
				action: "link",
				reason: "lockfiles match; convert node_modules to symlink",
			});
		});

		it("leaves a real directory when the guard fails", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "package-lock.json", "a");
			touch(worktree, "package-lock.json", "b");
			mkdirSync(join(worktree, "node_modules"));
			const plan = planResumeConversion(
				"npm/yarn/bun" as DepManager,
				primary,
				worktree,
			);
			expect(plan.action).toBe("leave");
			expect(plan.reason).toContain("mismatch");
		});

		it("is a no-op when the directory is already a symlink", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			mkdirSync(join(primary, "node_modules"));
			symlinkSync(
				join(primary, "node_modules"),
				join(worktree, "node_modules"),
			);
			const plan = planResumeConversion(
				"npm/yarn/bun" as DepManager,
				primary,
				worktree,
			);
			expect(plan).toEqual({
				action: "noop",
				reason: "node_modules is already a symlink; no action",
			});
		});

		it("leaves non-eligible managers alone", () => {
			const dir = makeFixture();
			mkdirSync(join(dir, "node_modules"));
			const plan = planResumeConversion("pnpm" as DepManager, dir, dir);
			expect(plan.action).toBe("leave");
			expect(plan.reason).toContain("not eligible");
		});

		it("leaves in CI mode", () => {
			const primary = makeFixture();
			const worktree = makeFixture();
			touch(primary, "package-lock.json", "lock");
			touch(worktree, "package-lock.json", "lock");
			mkdirSync(join(worktree, "node_modules"));
			const plan = planResumeConversion(
				"npm/yarn/bun" as DepManager,
				primary,
				worktree,
				{ ci: true },
			);
			expect(plan.action).toBe("leave");
			expect(plan.reason).toContain("CI=true");
		});
	});
});
