import { describe, expect, it } from "vitest";
import { branchName, ccTitle, scopeOf } from "../naming.js";import { appendEvent, createItem } from "../store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

describe("naming conventions (conventional commits)", () => {
	async function task(
		t: TestStore,
		opts: {
			title: string;
			pathScope?: string;
			type?: string;
		},
	): Promise<string> {
		const item = createItem(t.store, {
			kind: "task",
			title: opts.title,
			body: "",
			pathScope: opts.pathScope,
			actor: "test",
			...(opts.type ? { extra: { type: opts.type } } : {}),
		});
		return item.id;
	}

	it("scope derives from path scope: subdir of generic root wins", async () => {
		const t = await makeStore();
		try {
			const id = await task(t, {
				title: "Add login route",
				pathScope: "src/auth/login.ts",
			});
			expect(ccTitle(t.store, id, "Add login route")).toBe(
				"feat(auth): add login route",
			);
			// direct scope checks: subdir of a generic root, file at root,
			// pure glob
			expect(scopeOf("src/auth/login.ts")).toBe("auth");
			expect(scopeOf("README.md")).toBe("");
			expect(scopeOf("src/**/*.ts")).toBe("");
			expect(
				branchName({ id, title: "Add login route" }, "feat"),
			).toBe("specd/feat/task-0001-add-login-route");
		} finally {
			t.cleanup();
		}
	});

	it("files at the root and pure-glob scopes give no scope", async () => {
		const t = await makeStore();
		try {
			const id = await task(t, {
				title: "Add project README",
				pathScope: "README.md",
			});
			expect(ccTitle(t.store, id, "Add project README")).toBe(
				"feat: add project README",
			);
		} finally {
			t.cleanup();
		}
	});

	it("explicit type from the created payload is honored", async () => {
		const t = await makeStore();
		try {
			const id = await task(t, {
				title: "Fix session expiry",
				pathScope: "src/auth/**",
				type: "fix",
			});
			expect(ccTitle(t.store, id, "Fix session expiry")).toBe(
				"fix(auth): fix session expiry",
			);
		} finally {
			t.cleanup();
		}
	});

	it("unknown types fall back to feat", async () => {
		const t = await makeStore();
		try {
			const id = await task(t, {
				title: "Add thing",
				pathScope: "src/thing/**",
				type: "bananas",
			});
			expect(ccTitle(t.store, id, "Add thing")).toBe(
				"feat(thing): add thing",
			);
		} finally {
			t.cleanup();
		}
	});

	it("acronyms survive the subject lowercasing", async () => {
		const t = await makeStore();
		try {
			const id = await task(t, {
				title: "Update README usage section",
				pathScope: "README.md",
			});
			expect(ccTitle(t.store, id, "Update README usage section")).toBe(
				"feat: update README usage section",
			);
		} finally {
			t.cleanup();
		}
	});
});
