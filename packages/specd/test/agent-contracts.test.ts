import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ponytail: fixed-depth relative to this test file; upgrade to walking up to .git if structure changes.
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const RESOLVABLE_TOOLS = new Set([
	// Pi builtins
	"read",
	"edit",
	"write",
	"bash",
	"grep",
	"find",
	"ls",
	// extension tools that resolve for the agents in this repo
	"watchdog_diff",
	"contact_supervisor",
]);

type AgentFrontmatter = {
	name?: string;
	tools: string[];
	timeoutMs?: number;
};

function extractFrontmatter(text: string): Record<string, string> {
	const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
	if (!match) throw new Error("missing frontmatter block");

	const entries: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		if (!line.trim()) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key) entries[key] = value;
	}
	return entries;
}

function parseAgent(path: string): AgentFrontmatter {
	const text = readFileSync(path, "utf8");
	const fm = extractFrontmatter(text);
	const tools = (fm.tools ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	const timeoutMs = fm.timeoutMs ? Number(fm.timeoutMs) : undefined;
	return {
		name: fm.name,
		tools,
		timeoutMs: Number.isNaN(timeoutMs) ? undefined : timeoutMs,
	};
}

function assertResolvable(agent: AgentFrontmatter, source: string): void {
	const unknown = agent.tools.filter((t) => !RESOLVABLE_TOOLS.has(t));
	if (unknown.length > 0) {
		throw new Error(
			`${source}: ${agent.name ?? "agent"} declares unknown tool(s): ${unknown.join(", ")}`,
		);
	}
}

describe("agent contract frontmatter", () => {
	it("only permits tools from the resolvable set", () => {
		const agentsDir = resolve(REPO_ROOT, "agent/agents");
		for (const entry of readdirSync(agentsDir)) {
			if (!entry.endsWith(".md")) continue;
			const path = join(agentsDir, entry);
			const agent = parseAgent(path);
			expect(() => assertResolvable(agent, entry)).not.toThrow();
		}
	});

	it("pins the worker allowlist and 90-minute timeout", () => {
		const agent = parseAgent(
			resolve(REPO_ROOT, "agent/agents/specd-worker.md"),
		);
		expect(new Set(agent.tools)).toEqual(
			new Set(["read", "edit", "write", "bash", "grep", "find", "ls"]),
		);
		expect(agent.timeoutMs).toBe(5_400_000);
	});

	it("pins the reviewer allowlist", () => {
		const agent = parseAgent(
			resolve(REPO_ROOT, "agent/agents/specd-reviewer.md"),
		);
		expect(new Set(agent.tools)).toEqual(
			new Set([
				"read",
				"grep",
				"find",
				"ls",
				"watchdog_diff",
				"contact_supervisor",
			]),
		);
	});

	it("rejects a fixture naming specd_dashboard", () => {
		const fixturePath = resolve(
			import.meta.dirname,
			"fixtures",
			"specd-dashboard.md",
		);
		const agent = parseAgent(fixturePath);
		expect(agent.tools).toContain("specd_dashboard");
		expect(() => assertResolvable(agent, basename(fixturePath))).toThrow(
			/specd_dashboard/,
		);
	});
});
