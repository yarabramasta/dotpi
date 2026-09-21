import { describe, expect, test } from "vitest";
import { composeDossier, type DossierParts } from "../dossier.ts";
import { asSubagentsValue, DEFAULT_STATE } from "../state.ts";

describe("composeDossier", () => {
	test("empty parts produce empty string", () => {
		const parts: DossierParts = {};
		expect(composeDossier(parts)).toBe("");
	});

	test("joins sections and caps lines", () => {
		const structure = Array.from({ length: 40 }, (_, i) => `file${i}.ts`).join(
			"\n",
		);
		const dossier = composeDossier({
			structure,
			gitStatus: "## main\nM packages/grill/index.ts",
			gitLog: "abc feat(grill): x\ndef fix(grill): y\nghi chore: z\njkl extra",
		});
		expect(dossier).toContain("Repo structure (cymbal):");
		expect(dossier).toContain("## main");
		expect(dossier).toContain("abc feat(grill): x");
		expect(dossier).not.toContain("file39.ts"); // capped at 24 lines
		expect(dossier).not.toContain("jkl extra"); // capped at 3 commits
	});

	test("oversized dossier is truncated to the character cap", () => {
		const structure = "x".repeat(5000);
		const dossier = composeDossier({ structure });
		expect(dossier.length).toBeLessThanOrEqual(2214); // cap + "\n… (truncated)"
		expect(dossier.endsWith("… (truncated)")).toBe(true);
	});
});

describe("asSubagentsValue", () => {
	test("accepts on/off and truthy aliases", () => {
		expect(asSubagentsValue("on")).toBe(true);
		expect(asSubagentsValue("TRUE")).toBe(true);
		expect(asSubagentsValue("yes")).toBe(true);
		expect(asSubagentsValue("off")).toBe(false);
		expect(asSubagentsValue("no")).toBe(false);
		expect(asSubagentsValue("false")).toBe(false);
	});

	test("rejects anything else", () => {
		expect(asSubagentsValue("maybe")).toBeUndefined();
		expect(asSubagentsValue("")).toBeUndefined();
		expect(asSubagentsValue(undefined)).toBeUndefined();
	});
});

describe("state defaults", () => {
	test("subagents default on and schema version stamped", () => {
		expect(DEFAULT_STATE.subagents).toBe(true);
		expect(DEFAULT_STATE.schemaVersion).toBeGreaterThanOrEqual(2);
		expect(DEFAULT_STATE.reviewerRounds).toBe(0);
	});
});
