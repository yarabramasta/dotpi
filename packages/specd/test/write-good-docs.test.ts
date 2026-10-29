import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TASKS_ENTRY_PROMPT } from "../src/commands/prompts.js";

const SKILL_PATH = resolve(".agents/skills/write-good-docs/SKILL.md");
const WORKER_PATH = resolve("agent/agents/specd-worker.md");

describe("write-good-docs integration", () => {
	it("keeps the vendored skill and the worker prompt under single-source control", () => {
		expect(existsSync(SKILL_PATH)).toBe(true);
		expect(existsSync(WORKER_PATH)).toBe(true);
	});

	it("worker prompt references the skill and states its core contract", () => {
		const worker = readFileSync(WORKER_PATH, "utf8");
		expect(worker).toContain(".agents/skills/write-good-docs/SKILL.md");
		expect(worker).toContain("Diataxis");
		expect(worker).toContain("named audience");
		expect(worker).toMatch(/AI-writing tropes/i);
	});

	it("worker prompt does not duplicate the skill content wholesale", () => {
		const worker = readFileSync(WORKER_PATH, "utf8");
		expect(worker).not.toContain(
			"Do not read the whole skill directory by default.",
		);
		expect(worker).not.toContain(
			"Use this skill when documentation needs to become more useful",
		);
	});

	it("docs tasks created by specd embed the skill contract", () => {
		const prompt = TASKS_ENTRY_PROMPT("spec-0001");
		expect(prompt).toContain("write-good-docs");
		expect(prompt).toContain("Diataxis");
		expect(prompt).toContain("name the audience");
		expect(prompt).toMatch(/AI-writing tropes/i);
	});
});
