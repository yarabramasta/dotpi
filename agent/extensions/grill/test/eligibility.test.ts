import { eligibleScouts } from "../grounding-policy.ts";

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
