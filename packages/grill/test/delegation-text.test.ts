import { describe, expect, test } from "vitest";
import {
	gitbutlerDelegationText,
	worktreesDelegationText,
} from "../tools/phase-tools.js";

const twoSlices = [{ paths: ["a.ts"] }, { paths: ["b.ts"] }];

describe("gitbutlerDelegationText", () => {
	test("embeds pre-computed branch names and message template per slice", () => {
		const text = gitbutlerDelegationText(
			twoSlices,
			"fix(grill): harden naming",
			"gitbutler branch naming",
		);
		expect(text).toContain("branch `grill/fix-grill`");
		expect(text).toContain("branch `grill/fix-grill-2`");
		expect(text).toContain("fix(grill): <subject>");
		expect(text).toContain("NEVER invent a branch name");
		expect(text).not.toContain("feat-grill");
	});

	test("topic fallback feeds names when plan has no conventional line", () => {
		const text = gitbutlerDelegationText(
			[{ paths: ["a.ts"] }],
			"no conventional line here",
			"Fix gitbutler branch naming bug",
		);
		expect(text).toContain("grill/fix-fix-gitbutler-branch-naming-bug");
	});

	test("mismatch is surfaced, not silently merged", () => {
		const text = gitbutlerDelegationText(twoSlices, "fix(grill): x", "");
		expect(text).toContain("stop and surface the mismatch");
	});
});

describe("worktreesDelegationText", () => {
	test("embeds branch, checkout command, and BRANCH report per slice", () => {
		const text = worktreesDelegationText(
			twoSlices,
			"fix(grill): harden naming",
			"",
		);
		expect(text).toContain("branch `grill/fix-grill`");
		expect(text).toContain("git checkout -b grill/fix-grill");
		expect(text).toContain("BRANCH: grill/fix-grill");
		expect(text).toContain("fix(grill): <subject>");
	});

	test("reported BRANCH mismatch must be stopped", () => {
		const text = worktreesDelegationText(twoSlices, "fix(grill): x", "");
		expect(text).toContain("does not match the assigned name");
	});
});
