import { describe, expect, test } from "vitest";
import {
	gitbutlerDelegationText,
	worktreesDelegationText,
} from "../tools/phase-tools.js";

const twoSlices = [{ paths: ["a.ts"] }, { paths: ["b.ts"] }];

const docSlices = [
	{ paths: ["docs/readme.md", "docs/guide.md"] },
	{ paths: ["src/api/routes.ts"] },
];

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

	test("per-slice scope from slice paths, not the batch topic", () => {
		const text = gitbutlerDelegationText(
			docSlices,
			"docs(readme): write app guides",
			"Create docs for app X",
		);
		expect(text).toContain("branch `grill/docs`");
		expect(text).toContain("branch `grill/docs-routes`");
		expect(text).toContain(
			'but commit -b grill/docs <ids> -m "docs: <subject>"',
		);
		expect(text).toContain(
			'but commit -b grill/docs-routes <ids> -m "docs(routes): <subject>"',
		);
	});

	test("type comes from topic intent when plan has no conventional line", () => {
		const text = gitbutlerDelegationText(
			[{ paths: ["branch-naming.test.ts"] }],
			"no conventional line here",
			"Fix gitbutler branch naming bug",
		);
		expect(text).toContain("grill/fix-branch-naming");
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
