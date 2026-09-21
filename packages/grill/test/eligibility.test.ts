import { describe, expect, test } from "vitest";
import {
	eligibleAuditors,
	eligibleScouts,
	eligibleWriters,
} from "../grounding-policy.ts";

describe("eligibleScouts", () => {
	test("keeps read-only agents in canonical order", () => {
		const scouts = eligibleScouts([
			{ name: "worker", description: "Read-only scout", executable: true },
			{ name: "scout", description: "Repository scout", executable: true },
			{
				name: "delegate",
				description: "Delegate",
				executable: true,
				tools: { names: ["read", "edit"] },
			},
			{ name: "researcher", description: "Researcher", executable: true },
			{
				name: "codex-writer",
				description: "Read-only scout",
				executable: true,
			},
			{
				name: "personal-helper",
				description: "General helper",
				executable: true,
			},
		]);
		expect(scouts.map((scout) => scout.name)).toEqual(["scout", "researcher"]);
	});

	test("empty candidates", () => {
		expect(eligibleScouts([])).toEqual([]);
	});
});

describe("eligibleAuditors", () => {
	test("keeps read-only reviewers in canonical order", () => {
		const auditors = eligibleAuditors([
			{
				name: "reviewer",
				description:
					"Versatile review specialist for code diffs, plans, proposed solutions, and codebase health",
				executable: true,
				tools: { names: ["read", "grep", "find", "ls", "contact_supervisor"] },
			},
			{
				name: "evidence-auditor",
				description:
					"Independent evidence reviewer for checking whether research claims are supported by their sources",
				executable: true,
				tools: {
					names: [
						"read",
						"web_search",
						"fetch_content",
						"get_search_content",
						"source_check",
					],
				},
			},
			{
				name: "oracle",
				description:
					"High-context decision-consistency oracle that protects inherited state and prevents drift",
				executable: true,
				tools: { names: ["read", "grep", "find", "ls", "bash"] },
			},
			{
				name: "scout",
				description:
					"Fast codebase recon that returns compressed context for handoff",
				executable: true,
				tools: {
					names: [
						"read",
						"grep",
						"find",
						"ls",
						"bash",
						"write",
						"contact_supervisor",
					],
				},
			},
			{
				name: "worker",
				description:
					"Implementation agent for normal tasks and approved oracle handoffs",
				executable: true,
				tools: {
					names: [
						"read",
						"grep",
						"find",
						"ls",
						"bash",
						"edit",
						"write",
						"contact_supervisor",
					],
				},
			},
			{
				name: "codex-writer",
				description:
					"Explicit workspace-writing one-shot execution through the Codex CLI",
				executable: true,
				runner: { type: "external-cli:codex" },
			},
			{
				name: "personal-helper",
				description: "General helper",
				executable: true,
			},
		]);
		expect(auditors.map((a) => a.name)).toEqual([
			"reviewer",
			"evidence-auditor",
			"oracle",
		]);
	});

	test("empty candidates", () => {
		expect(eligibleAuditors([])).toEqual([]);
	});
});

describe("eligibleWriters", () => {
	// Writers are the inverse of read-only scouts/auditors: keep mutating,
	// external CLI/job, or writer-named agents; rank writer/worker names first.
	test("keeps mutating/writer-named agents canonical-first", () => {
		const writers = eligibleWriters([
			{
				name: "reviewer",
				description:
					"Versatile review specialist for code diffs, plans, proposed solutions, and codebase health",
				executable: true,
				tools: { names: ["read", "grep", "find", "ls", "contact_supervisor"] },
			},
			{
				name: "scout",
				description:
					"Fast codebase recon that returns compressed context for handoff",
				executable: true,
				tools: { names: ["read", "grep", "find", "ls", "bash"] },
			},
			{
				name: "worker",
				description:
					"Implementation agent for normal tasks and approved oracle handoffs",
				executable: true,
				tools: {
					names: [
						"read",
						"grep",
						"find",
						"ls",
						"bash",
						"edit",
						"write",
						"contact_supervisor",
					],
				},
			},
			{
				name: "codex-writer",
				description:
					"Explicit workspace-writing one-shot execution through the Codex CLI",
				executable: true,
				runner: { type: "external-cli:codex" },
			},
			{
				name: "researcher",
				description: "Read-only researcher",
				executable: true,
			},
			{
				name: "personal-helper",
				description: "General helper",
				executable: true,
			},
		]);
		expect(writers.map((w) => w.name)).toEqual(["worker", "codex-writer"]);
	});

	test("empty candidates", () => {
		expect(eligibleWriters([])).toEqual([]);
	});
});
