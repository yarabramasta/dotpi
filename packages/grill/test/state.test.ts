import { describe, expect, test } from "vitest";
import { composeDossier, type DossierParts } from "../dossier.ts";
import { asSubagentsValue, DEFAULT_STATE } from "../state.ts";
import { shouldRewriteTitle, titleFromTopic } from "../title.ts";

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

describe("shouldRewriteTitle", () => {
	test("rewrites unset and generic grill titles", () => {
		expect(shouldRewriteTitle(undefined)).toBe(true);
		expect(shouldRewriteTitle("")).toBe(true);
		expect(shouldRewriteTitle("Start a Grill Me session for this topic:")).toBe(
			true,
		);
		expect(shouldRewriteTitle("grill")).toBe(true);
		expect(shouldRewriteTitle("/grill auth refactor")).toBe(true);
	});

	test("keeps custom titles", () => {
		expect(shouldRewriteTitle("Refactor auth module")).toBe(false);
		expect(shouldRewriteTitle("pi - my-project")).toBe(false);
	});
});

describe("titleFromTopic", () => {
	test("short topic passes through with prefix", () => {
		expect(titleFromTopic("auth refactor")).toBe("grill: auth refactor");
	});

	test("long topic cuts at word boundary under 40 chars", () => {
		const title = titleFromTopic(
			"complete re-design of the grill extension with dialog style UX and subagents",
		);
		expect(title.startsWith("grill: ")).toBe(true);
		expect(title.length).toBeLessThanOrEqual(48); // "grill: " + 40 + ellipsis
		expect(title.endsWith("…")).toBe(true);
	});

	test("empty topic falls back", () => {
		expect(titleFromTopic("   ")).toBe("grill: untitled");
	});
});
