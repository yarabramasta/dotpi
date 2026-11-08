import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lookupStore } from "../src/store/registry.js";
import { registerSinkTools } from "../src/tools/sink-tools.js";

interface CapturedToolDef {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
	}>;
}

function captureStoreTool(name: string): CapturedToolDef {
	const defs: CapturedToolDef[] = [];
	const fakePi = {
		registerTool(def: CapturedToolDef) {
			defs.push(def);
		},
	} as unknown as ExtensionAPI;
	registerSinkTools(fakePi);
	const found = defs.find((d) => d.name === name);
	if (!found) throw new Error(`tool ${name} not registered`);
	return found;
}

function initFixtureRepo(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "specd-store-repo-"));
	execFileSync("git", ["init", "-q", "-b", "main", dir]);
	execFileSync("git", ["-C", dir, "config", "user.name", "test"]);
	execFileSync("git", ["-C", dir, "config", "user.email", "test@fixture"]);
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("specd_store", () => {
	const tool = () => captureStoreTool("specd_store");
	const dirs: string[] = [];
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "specd-store-agent-"));
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

	it("register external creates the store with marker, git repo, and events.jsonl-tracking gitignore", async () => {
		const { dir, cleanup } = initFixtureRepo();
		dirs.push(dir);
		try {
			const storePath = join(dirname(dir), `${basename(dir)}-store`);

			const res = await tool().execute(
				"t1",
				{ action: "register", type: "external", storePath },
				undefined,
				undefined,
				{ cwd: dir } as unknown as ExtensionContext,
			);

			expect(res.content[0]?.text).toMatch(/Registered/);
			expect(existsSync(storePath)).toBe(true);
			expect(existsSync(join(storePath, ".specd-store.yaml"))).toBe(true);
			expect(existsSync(join(storePath, ".git"))).toBe(true);
			const gitignore = readFileSync(join(storePath, ".gitignore"), "utf8");
			expect(gitignore).toContain("!events.jsonl");
			expect(lookupStore(dir)).toEqual({
				type: "external",
				storePath,
			});
		} finally {
			cleanup();
		}
	});

	it("register external-git also creates the store", async () => {
		const { dir, cleanup } = initFixtureRepo();
		dirs.push(dir);
		try {
			const storePath = join(dirname(dir), `${basename(dir)}-store`);

			const res = await tool().execute(
				"t1",
				{
					action: "register",
					type: "external-git",
					storePath,
					remote: "git@example.com:store.git",
				},
				undefined,
				undefined,
				{ cwd: dir } as unknown as ExtensionContext,
			);

			expect(res.content[0]?.text).toMatch(/Registered/);
			expect(existsSync(storePath)).toBe(true);
			expect(existsSync(join(storePath, ".specd-store.yaml"))).toBe(true);
			expect(existsSync(join(storePath, ".git"))).toBe(true);
			expect(lookupStore(dir)).toEqual({
				type: "external-git",
				storePath,
				remote: "git@example.com:store.git",
			});
		} finally {
			cleanup();
		}
	});

	it("register expands ~ in storePath to $HOME", async () => {
		const { dir, cleanup } = initFixtureRepo();
		dirs.push(dir);
		try {
			const target = mkdtempSync(join(homedir(), "specd-reg-XXXXXX"));
			dirs.push(target);
			const rel = relative(homedir(), target);

			const res = await tool().execute(
				"t1",
				{ action: "register", type: "external", storePath: `~/${rel}` },
				undefined,
				undefined,
				{ cwd: dir } as unknown as ExtensionContext,
			);

			expect(res.content[0]?.text).toMatch(/Registered/);
			expect(existsSync(target)).toBe(true);
			expect(existsSync(join(target, ".specd-store.yaml"))).toBe(true);
			expect(lookupStore(dir)?.storePath).toBe(target);
		} finally {
			cleanup();
		}
	});

	it("status prompt recommends external and labels in-repo as machine-local", async () => {
		const { dir, cleanup } = initFixtureRepo();
		dirs.push(dir);
		try {
			const res = await tool().execute(
				"t1",
				{ action: "status" },
				undefined,
				undefined,
				{ cwd: dir } as unknown as ExtensionContext,
			);

			const text = res.content[0]?.text ?? "";
			expect(text).toMatch(/recommended default for new repos/);
			expect(text).toMatch(/machine-local/);
			expect(text).not.toMatch(/committed/);
		} finally {
			cleanup();
		}
	});
});
