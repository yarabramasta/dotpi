import { eligibleAuditors, eligibleScouts } from "../grounding-policy.ts";

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

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
	{ name: "codex-writer", description: "Read-only scout", executable: true },
	{ name: "personal-helper", description: "General helper", executable: true },
]);

assertEqual(
	scouts.map((scout) => scout.name),
	["scout", "researcher"],
	"read-only ordering",
);
assertEqual(eligibleScouts([]), [], "empty candidates");

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
			names: ["read", "grep", "find", "ls", "bash", "write", "contact_supervisor"],
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
	{ name: "personal-helper", description: "General helper", executable: true },
]);

assertEqual(
	auditors.map((a) => a.name),
	["reviewer", "evidence-auditor", "oracle"],
	"auditor read-only ordering",
);
assertEqual(eligibleAuditors([]), [], "empty auditor candidates");
