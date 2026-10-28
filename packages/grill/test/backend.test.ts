import { describe, expect, test } from "vitest";
import {
	isolationBadge,
	isolationBranchName,
	isolationPickerText,
	parseConventionalScope,
	resolveIsolation,
	sliceBranches,
	sliceScope,
} from "../src/backends/backend.js";

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

	test("caps scope so the ref component stays under git's 255-byte limit", () => {
		const long = "x".repeat(280);
		const name = isolationBranchName("fix", long, []);
		expect(name.length).toBeLessThan(100);
		expect(name).toBe(`grill/fix-${"x".repeat(48)}`);
	});

	test("scope equal to type is not doubled", () => {
		expect(isolationBranchName("docs", "docs", [])).toBe("grill/docs");
		expect(isolationBranchName("docs", "docs", ["grill/docs"])).toBe(
			"grill/docs-2",
		);
	});
});

describe("parseConventionalScope", () => {
	test("plan's conventional-commit line wins, paren scope as slug", () => {
		expect(parseConventionalScope("fix(grill): handle paste", "")).toEqual({
			type: "fix",
			slug: "grill",
		});
	});

	test("plan line without paren scope falls back to topic slug", () => {
		expect(
			parseConventionalScope("fix: handle paste", "Worktrees & Branch Naming"),
		).toEqual({
			type: "fix",
			slug: "worktrees-branch-naming",
		});
	});

	test("no plan line: type from topic intent, slug from topic", () => {
		expect(
			parseConventionalScope(
				"Fix branch naming for gitbutler",
				"Fix gitbutler branch naming bug",
			),
		).toEqual({ type: "fix", slug: "gitbutler-branch-naming-bug" });
	});

	test("prose-first plan: later conventional line wins", () => {
		expect(
			parseConventionalScope(
				"Some prose intro paragraph.\nfix(grill): harden naming",
				"",
			),
		).toEqual({ type: "fix", slug: "grill" });
	});

	test("topic slug is a short scope, not the whole summary", () => {
		const { type, slug } = parseConventionalScope(
			"",
			"Fix gitbutler branch naming bug and improve delegation slice text",
		);
		expect(type).toBe("fix");
		expect(slug).toBe("gitbutler-branch-naming-bug");
	});

	test("intent keyword mined from topic is not repeated in slug", () => {
		expect(parseConventionalScope("", "Create docs for app X")).toEqual({
			type: "docs",
			slug: "create-for-app-x",
		});
	});

	test("multi-word slug still capped for pathological topics", () => {
		const topic = [
			"fix",
			"x".repeat(30),
			"y".repeat(30),
			"z".repeat(30),
			"w".repeat(30),
		].join(" ");
		const { slug } = parseConventionalScope("", topic);
		expect(slug.length).toBe(48);
		expect(slug.endsWith("-")).toBe(false);
	});

	test("empty plan and topic: grill guard", () => {
		expect(parseConventionalScope("", "")).toEqual({
			type: "feat",
			slug: "grill",
		});
	});
});

describe("sliceScope", () => {
	test("single path uses the file stem", () => {
		expect(sliceScope(["src/auth/login.ts"])).toBe("login");
		expect(sliceScope(["docs/readme.md"])).toBe("readme");
	});

	test("multiple paths use the deepest shared directory segment", () => {
		expect(sliceScope(["src/auth/login.ts", "src/auth/logout.ts"])).toBe(
			"auth",
		);
		expect(sliceScope(["docs/readme.md", "docs/api/guide.md"])).toBe("docs");
	});

	test("root-level files fall back to the first stem", () => {
		expect(sliceScope(["README.md", "CHANGELOG.md"])).toBe("readme");
	});

	test("directory tokens without extension keep their name", () => {
		expect(sliceScope(["src/auth"])).toBe("auth");
	});
});

describe("sliceBranches", () => {
	test("informative path scope wins over subject slug", () => {
		const [{ branch }] = sliceBranches(
			[{ paths: ["src/auth/login.ts"] }],
			"docs(readme): write guides",
			"Create docs for app X",
		);
		expect(branch).toBe("grill/docs-login");
	});

	test("generic stems fall back to the subject slug", () => {
		const [a, b] = sliceBranches(
			[{ paths: ["src/index.ts"] }, { paths: ["src/utils.ts"] }],
			"docs(readme): write guides",
			"",
		);
		expect(a.branch).toBe("grill/docs-readme");
		expect(b.branch).toBe("grill/docs-readme-2");
	});

	test("type from topic intent when plan has no conventional line", () => {
		const [{ branch }] = sliceBranches(
			[{ paths: ["src/token-expiry.ts"] }],
			"no conventional line here",
			"Fix token expiry bug",
		);
		expect(branch).toBe("grill/fix-token-expiry");
	});

	test("scope equal to type collapses to type alone", () => {
		const [{ branch }] = sliceBranches(
			[{ paths: ["docs/readme.md", "docs/guide.md"] }],
			"docs(readme): write guides",
			"",
		);
		expect(branch).toBe("grill/docs");
	});
});
