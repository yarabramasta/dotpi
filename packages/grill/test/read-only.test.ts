import { describe, expect, test } from "vitest";
import { isProbablyReadOnlyBash } from "../read-only.ts";

describe("isProbablyReadOnlyBash — git branch/remote allowlists", () => {
	const readonly: string[] = [
		"git status",
		"git log --oneline -3",
		"git diff HEAD",
		"git branch",
		"git branch -a",
		"git branch -vv",
		"git branch --show-current",
		"git branch --list feat",
		"git branch --sort=-committerdate",
		"git remote",
		"git remote -v",
		"git remote --verbose",
		"git remote get-url origin",
		"sed s/a/b/ file.txt",
		"find . -name x",
		"grep x f | head",
		"git log | grep x",
	];

	const mutating: string[] = [
		"git branch feature",
		"git branch -d x",
		"git branch -D x",
		"git branch -m old new",
		"git branch --edit-description",
		"git branch --unset-upstream",
		"git branch --set-upstream-to=origin/main",
		"git branch -u origin/main",
		"git remote add origin url",
		"git remote set-url origin x",
		"git remote rename a b",
		"git remote remove origin",
		"sed -i s/a/b/ file.txt",
		"sed --in-place s/a/b/ file.txt",
		"find . -name x -delete",
		"find . -name x -exec rm {} ;",
		"git ls-files | xargs sed -i s/a/b/",
		"echo hi && git push",
		"git status > /tmp/out",
	];

	test("read-only forms pass", () => {
		for (const cmd of readonly) {
			expect(isProbablyReadOnlyBash(cmd), cmd).toBe(true);
		}
	});

	test("mutating forms are blocked", () => {
		for (const cmd of mutating) {
			expect(isProbablyReadOnlyBash(cmd), cmd).toBe(false);
		}
	});
});
