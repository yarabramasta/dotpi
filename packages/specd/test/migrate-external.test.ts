import { execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

		return { repoDir };
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
		expect(externalStore.dir).toBe(storePath);

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

	it("refuses to migrate when events.jsonl does not replay to matching counts", async () => {
		const { repoDir } = await seededRepo();
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		const eventsPath = join(repoDir, ".spec", "events.jsonl");
		const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
		// Truncate to one event so replay creates fewer items/events.
		writeFileSync(eventsPath, `${lines[0]}\n`);

		expect(() => migrateToExternalStore(repoDir, storePath)).toThrow(
			/Migration refused/,
		);
		expect(existsSync(join(repoDir, ".spec"))).toBe(true);
	});

	it("strips !.spec/ from repo .gitignore when present", async () => {
		const { repoDir } = await seededRepo({ withSpecReinclusion: true });
		const storePath = join(repoDir, "..", "external-store");
		dirs.push(storePath);

		migrateToExternalStore(repoDir, storePath);

		const gitignore = readFileSync(join(repoDir, ".gitignore"), "utf8");
		expect(gitignore).not.toContain("!.spec/");
	});
});
