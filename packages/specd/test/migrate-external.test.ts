import { execSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateToExternalStore } from "../src/store/migrate-external.js";
import { lookupStore } from "../src/store/registry.js";
import {
	addLink,
	appendEvent,
	createItem,
	openStore,
} from "../src/store/store.js";

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_AUTHOR_NAME: "specd",
		GIT_AUTHOR_EMAIL: "specd@localhost",
		GIT_COMMITTER_NAME: "specd",
		GIT_COMMITTER_EMAIL: "specd@localhost",
	};
}

describe("migrate to external store", () => {
	const dirs: string[] = [];
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "specd-migrate-agent-"));
		dirs.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		}
		for (const dir of dirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		dirs.length = 0;
	});

	async function seededRepo(options?: { withSpecReinclusion?: boolean }) {
		const repoDir = mkdtempSync(join(tmpdir(), "specd-migrate-repo-"));
		dirs.push(repoDir);

		execSync("git init", { cwd: repoDir, stdio: "ignore" });
		writeFileSync(
			join(repoDir, ".gitignore"),
			options?.withSpecReinclusion
				? "*\n!.gitignore\n!.spec/\n"
				: "*\n!.gitignore\n",
		);
		execSync('git add .gitignore && git commit -m "init"', {
			cwd: repoDir,
			stdio: "ignore",
			env: gitEnv(),
		});

		const store = await openStore(repoDir);
		const spec = createItem(store, {
			kind: "spec",
			title: "Auth",
			actor: "test",
		});
		const task = createItem(store, {
			kind: "task",
			title: "T1",
			actor: "test",
		});
		appendEvent(store, { item: spec.id, type: "spec.approved", actor: "test" });
		addLink(store, task.id, spec.id, "part-of");
		store.db.close();

		return { repoDir, specId: spec.id, taskId: task.id };
	}

	it("migrates counts and statuses, removes .spec/, strips .gitignore", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		const result = migrateToExternalStore(repoDir, storePath);
		expect(result.migrated).toBe(true);
		expect(result.storePath).toBe(storePath);

		expect(existsSync(join(repoDir, ".spec"))).toBe(false);
		expect(existsSync(storePath)).toBe(true);
		expect(lookupStore(repoDir)).toEqual({
			type: "external",
			storePath,
		});

		const repoGitignore = readFileSync(join(repoDir, ".gitignore"), "utf8");
		expect(repoGitignore).not.toContain("!.spec/");

		const externalStore = await openStore(repoDir);
		expect(externalStore.dir).toBe(realpathSync(storePath));

		const items = (
			externalStore.db.prepare("SELECT COUNT(*) AS n FROM items").get() as {
				n: number;
			}
		).n;
		const events = (
			externalStore.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
				n: number;
			}
		).n;
		const links = (
			externalStore.db.prepare("SELECT COUNT(*) AS n FROM links").get() as {
				n: number;
			}
		).n;
		expect(items).toBe(2);
		expect(events).toBe(3);
		expect(links).toBe(1);

		const statuses = externalStore.db
			.prepare(
				"SELECT kind, status, COUNT(*) AS n FROM items GROUP BY kind, status ORDER BY kind, status",
			)
			.all() as Array<{ kind: string; status: string; n: number }>;
		expect(statuses).toContainEqual({ kind: "spec", status: "approved", n: 1 });
		expect(statuses).toContainEqual({ kind: "task", status: "draft", n: 1 });

		externalStore.db.close();

		const porcelain = execSync("git status --porcelain", {
			cwd: repoDir,
			encoding: "utf8",
		});
		expect(porcelain).toBe("");
	});

	it("is idempotent", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		migrateToExternalStore(repoDir, storePath);
		const result = migrateToExternalStore(repoDir, storePath);

		expect(result.alreadyMigrated).toBe(true);
		expect(result.migrated).toBe(false);
		expect(existsSync(join(repoDir, ".spec"))).toBe(false);
	});

	it("refuses to migrate when source db has events absent from events.jsonl", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		const sourceDb = new DatabaseSync(join(repoDir, ".spec", "store.db"));
		sourceDb
			.prepare(
				"INSERT INTO items (id, kind, title, status, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				"db-ahead-spec-001",
				"spec",
				"Db ahead spec",
				"draft",
				"",
				"2024-01-01T00:00:00.000Z",
				"2024-01-01T00:00:00.000Z",
			);
		sourceDb
			.prepare(
				"INSERT INTO events (id, item, type, payload, at, actor) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				100,
				"db-ahead-spec-001",
				"created",
				JSON.stringify({
					kind: "spec",
					title: "Db ahead spec",
					body: "",
					pathScope: null,
					phase: null,
					parallel: false,
				}),
				"2024-01-01T00:00:00.000Z",
				"test",
			);
		sourceDb.close();

		expect(() => migrateToExternalStore(repoDir, storePath)).toThrow(
			/1 event exists only in the stale store\.db and is not in events\.jsonl/,
		);
		expect(existsSync(join(repoDir, ".spec"))).toBe(true);
		expect(existsSync(storePath)).toBe(false);
	});

	it("strips !.spec/ from repo .gitignore when present", async () => {
		const { repoDir } = await seededRepo({ withSpecReinclusion: true });
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		migrateToExternalStore(repoDir, storePath);

		const gitignore = readFileSync(join(repoDir, ".gitignore"), "utf8");
		expect(gitignore).not.toContain("!.spec/");
	});

	it("refuses to migrate when target already holds a specd store", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);
		mkdirSync(storePath, { recursive: true });

		writeFileSync(
			join(storePath, ".specd-store.yaml"),
			"type: specd-store\nversion: 1\nrepo: other\n",
		);

		expect(() => migrateToExternalStore(repoDir, storePath)).toThrow(
			/already holds a specd store/,
		);
		expect(existsSync(join(repoDir, ".spec"))).toBe(true);
		expect(
			readFileSync(join(storePath, ".specd-store.yaml"), "utf8"),
		).toContain("repo: other");
		expect(lookupStore(repoDir)?.type).not.toBe("external");
	});

	it("commits before flip and leaves .spec/ intact on commit failure", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);
		mkdirSync(storePath, { recursive: true });

		execSync("git init", { cwd: storePath, stdio: "ignore" });
		writeFileSync(
			join(storePath, ".git", "hooks", "prepare-commit-msg"),
			'#!/bin/sh\nif grep -q "migrate specd store events" "$1"; then exit 1; fi\n',
		);
		chmodSync(join(storePath, ".git", "hooks", "prepare-commit-msg"), 0o755);

		expect(() => migrateToExternalStore(repoDir, storePath)).toThrow(
			/could not commit migrated events/,
		);
		expect(existsSync(join(repoDir, ".spec"))).toBe(true);
		expect(lookupStore(repoDir)?.type).not.toBe("external");
		expect(existsSync(storePath)).toBe(false);
	});

	it("warns and migrates when source store.db is stale (jsonl superset)", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		const eventsPath = join(repoDir, ".spec", "events.jsonl");
		const extra =
			JSON.stringify({
				id: 100,
				item: "spec-0003",
				type: "created",
				payload: JSON.stringify({
					kind: "spec",
					title: "Extra spec",
					body: "",
					pathScope: null,
					phase: null,
					parallel: false,
				}),
				at: "2024-01-01T00:00:00.000Z",
				actor: "test",
				batch: null,
			}) +
			"\n" +
			JSON.stringify({
				id: 101,
				item: "spec-0003",
				type: "spec.approved",
				payload: "{}",
				at: "2024-01-01T00:00:01.000Z",
				actor: "test",
				batch: null,
			}) +
			"\n";
		appendFileSync(eventsPath, extra);

		const result = migrateToExternalStore(repoDir, storePath);
		expect(result.migrated).toBe(true);
		expect(result.warning).toMatch(/source store\.db was stale/);
		expect(result.warning).toMatch(/events\.jsonl is authoritative/);
		expect(existsSync(join(repoDir, ".spec"))).toBe(false);
		expect(existsSync(storePath)).toBe(true);

		const targetDb = new DatabaseSync(join(storePath, "store.db"), {
			readOnly: true,
		});
		const items = (
			targetDb.prepare("SELECT COUNT(*) AS n FROM items").get() as {
				n: number;
			}
		).n;
		const events = (
			targetDb.prepare("SELECT COUNT(*) AS n FROM events").get() as {
				n: number;
			}
		).n;
		targetDb.close();
		expect(items).toBe(3);
		expect(events).toBe(5);
	});

	it("refuses to migrate when events.jsonl does not replay to expected state", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		const eventsPath = join(repoDir, ".spec", "events.jsonl");
		const invalid = JSON.stringify({
			id: 100,
			item: "missing-spec-001",
			type: "spec.approved",
			payload: "{}",
			at: "2024-01-01T00:00:00.000Z",
			actor: "test",
			batch: null,
		});
		appendFileSync(eventsPath, `${invalid}\n`);

		expect(() => migrateToExternalStore(repoDir, storePath)).toThrow(
			/Migration refused/,
		);
		expect(existsSync(join(repoDir, ".spec"))).toBe(true);
		expect(existsSync(storePath)).toBe(false);
	});
});
