import { describe, expect, test } from "vitest";
import {
	mergeConflictBlock,
	mergePlan,
	parseBranchReports,
} from "./worktree-merge.js";

describe("parseBranchReports", () => {
	test("extracts BRANCH: lines in first-seen order", () => {
		const text = `
 Writer A completed.
BRANCH: grill/feat-ui
Some other stuff.
BRANCH: grill/fix-auth
`;
		expect(parseBranchReports([text])).toEqual([
			"grill/feat-ui",
			"grill/fix-auth",
		]);
	});

	test("deduplicates repeated branches", () => {
		const text =
			"BRANCH: grill/feat-ui\nBRANCH: grill/feat-ui\nBRANCH: grill/fix-auth\n";
		expect(parseBranchReports([text])).toEqual([
			"grill/feat-ui",
			"grill/fix-auth",
		]);
	});

	test("ignores non-matching lines and whitespace", () => {
		const text =
			"  BRANCH: \t grill/scope \t \nnot a branch\nBRANCH: grill/other\n";
		expect(parseBranchReports([text])).toEqual(["grill/scope", "grill/other"]);
	});

	test("tolerates undefined and empty inputs", () => {
		expect(parseBranchReports(undefined)).toEqual([]);
		expect(parseBranchReports([])).toEqual([]);
		expect(parseBranchReports([""])).toEqual([]);
	});
});

describe("mergePlan", () => {
	test("empty branches → no steps, not all clear", () => {
		expect(mergePlan([])).toEqual({ steps: [], allClear: false });
	});

	test("sequential merge steps and allClear", () => {
		const branches = ["grill/feat-ui", "grill/fix-auth"];
		expect(mergePlan(branches)).toEqual({
			steps: ["git merge grill/feat-ui", "git merge grill/fix-auth"],
			allClear: true,
		});
	});

	test("duplicate branches → not all clear", () => {
		expect(mergePlan(["grill/a", "grill/a"])).toEqual({
			steps: ["git merge grill/a", "git merge grill/a"],
			allClear: false,
		});
	});
});

describe("mergeConflictBlock", () => {
	test("mentions branch name and both resolution paths", () => {
		const block = mergeConflictBlock("grill/feat-ui");
		expect(block).toContain("grill/feat-ui");
		expect(block).toContain("git merge --abort");
		expect(block).toContain("git commit");
		expect(block).toContain("Grill paused");
	});
});
