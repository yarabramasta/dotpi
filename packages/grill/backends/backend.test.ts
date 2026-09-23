import { describe, expect, test } from "vitest";
import {
	isolationBadge,
	isolationBranchName,
	isolationPickerText,
	resolveIsolation,
} from "./backend.js";

describe("resolveIsolation", () => {
	test("subagents off forces slices", () => {
		expect(
			resolveIsolation({
				setting: "auto",
				isGitbutlerMode: false,
				butBinary: false,
				isCleanTree: true,
				subagentsOn: false,
			}),
		).toEqual({ backend: "slices", reason: "subagents off" });
	});

	describe("explicit worktrees", () => {
		test("clean plain-git tree → worktrees", () => {
			expect(
				resolveIsolation({
					setting: "worktrees",
					isGitbutlerMode: false,
					butBinary: false,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({ backend: "worktrees", reason: "clean tree, plain git repo" });
		});

		test("dirty tree → slices", () => {
			expect(
				resolveIsolation({
					setting: "worktrees",
					isGitbutlerMode: false,
					butBinary: false,
					isCleanTree: false,
					subagentsOn: true,
				}),
			).toEqual({
				backend: "slices",
				reason: "dirty tree — worktrees need a clean checkout",
			});
		});

		test("gitbutler repo → refused", () => {
			expect(
				resolveIsolation({
					setting: "worktrees",
					isGitbutlerMode: true,
					butBinary: true,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({
				backend: "slices",
				reason: "worktrees refused: gitbutler-managed repo",
			});
		});
	});

	describe("explicit gitbutler", () => {
		test("mode + but binary → gitbutler", () => {
			expect(
				resolveIsolation({
					setting: "gitbutler",
					isGitbutlerMode: true,
					butBinary: true,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({
				backend: "gitbutler",
				reason: "gitbutler-mode repo, but binary present",
			});
		});

		test("mode without but binary → slices", () => {
			expect(
				resolveIsolation({
					setting: "gitbutler",
					isGitbutlerMode: true,
					butBinary: false,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({ backend: "slices", reason: "but binary not found" });
		});

		test("not a gitbutler repo → slices", () => {
			expect(
				resolveIsolation({
					setting: "gitbutler",
					isGitbutlerMode: false,
					butBinary: true,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({ backend: "slices", reason: "not a gitbutler-mode repo" });
		});
	});

	test("explicit slices → slices", () => {
		expect(
			resolveIsolation({
				setting: "slices",
				isGitbutlerMode: true,
				butBinary: true,
				isCleanTree: false,
				subagentsOn: true,
			}),
		).toEqual({ backend: "slices", reason: "isolation setting: slices" });
	});

	describe("auto", () => {
		test("gitbutler mode + but binary → gitbutler", () => {
			expect(
				resolveIsolation({
					setting: "auto",
					isGitbutlerMode: true,
					butBinary: true,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({ backend: "gitbutler", reason: "gitbutler-mode repo (auto)" });
		});

		test("gitbutler mode without but binary → slices", () => {
			expect(
				resolveIsolation({
					setting: "auto",
					isGitbutlerMode: true,
					butBinary: false,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({
				backend: "slices",
				reason: "gitbutler repo but no but binary (auto)",
			});
		});

		test("clean plain-git tree → worktrees", () => {
			expect(
				resolveIsolation({
					setting: "auto",
					isGitbutlerMode: false,
					butBinary: false,
					isCleanTree: true,
					subagentsOn: true,
				}),
			).toEqual({
				backend: "worktrees",
				reason: "clean plain-git tree (auto)",
			});
		});

		test("dirty plain-git tree → slices", () => {
			expect(
				resolveIsolation({
					setting: "auto",
					isGitbutlerMode: false,
					butBinary: false,
					isCleanTree: false,
					subagentsOn: true,
				}),
			).toEqual({ backend: "slices", reason: "dirty tree (auto)" });
		});
	});
});

describe("isolationPickerText", () => {
	test("formats backend and reason", () => {
		expect(
			isolationPickerText({
				backend: "worktrees",
				reason: "clean tree, plain git repo",
			}),
		).toBe("isolation: worktrees (clean tree, plain git repo)");
	});
});

describe("isolationBadge", () => {
	test("undefined returns empty", () => {
		expect(isolationBadge(undefined)).toBe("");
	});

	test("returns backend short name", () => {
		expect(isolationBadge({ backend: "gitbutler", reason: "x" })).toBe(
			"gitbutler",
		);
	});
});

describe("isolationBranchName", () => {
	test("no scope", () => {
		expect(isolationBranchName("feat", undefined, [])).toBe("grill/feat");
	});

	test("with scope", () => {
		expect(isolationBranchName("feat", "ui", [])).toBe("grill/feat-ui");
	});

	test("sanitizes spaces and uppercase", () => {
		expect(isolationBranchName("FEAT", "UI Polish", [])).toBe(
			"grill/feat-ui-polish",
		);
	});

	test("sanitizes invalid characters", () => {
		expect(isolationBranchName("fix", "auth/login!", [])).toBe(
			"grill/fix-auth-login",
		);
	});

	test("avoids collisions by suffixing", () => {
		expect(isolationBranchName("feat", "ui", ["grill/feat-ui"])).toBe(
			"grill/feat-ui-2",
		);
		expect(
			isolationBranchName("feat", "ui", ["grill/feat-ui", "grill/feat-ui-2"]),
		).toBe("grill/feat-ui-3");
	});
});
