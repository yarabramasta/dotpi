import { describe, expect, test } from "vitest";
import { statusTokens } from "../prompts.ts";
import { DEFAULT_STATE, type GrillState } from "../state.ts";

function state(overrides: Partial<GrillState>): GrillState {
	return { ...DEFAULT_STATE, active: true, ...overrides };
}

describe("statusTokens", () => {
	test("inactive default state: bare token", () => {
		expect(statusTokens(DEFAULT_STATE)).toBe("🔥 grill");
	});

	test("interview with open question: Q number + decided count", () => {
		const s = state({
			currentQuestion: "Which library?",
			decisions: [
				{ question: "q", value: "a", label: "A", custom: false, at: 1 },
				{ question: "q", value: "b", label: "B", custom: false, at: 2 },
				{ question: "q", value: "c", label: "C", custom: true, at: 3 },
			],
		});
		expect(statusTokens(s)).toBe("🔥 grill · Q4 · 3 decided");
	});

	test("interview grounded: grounded token", () => {
		const s = state({
			currentQuestion: "Q?",
			decisions: [],
			grounding: { summary: "cymbal map", source: "cymbal", at: 1 },
		});
		expect(statusTokens(s)).toBe("🔥 grill · Q1 · grounded");
	});

	test("interview grounding skipped: ⚠ ungrounded token", () => {
		const s = state({
			currentQuestion: "Q?",
			grounding: { summary: "skipped", skippedReason: "no scouts", at: 1 },
		});
		expect(statusTokens(s)).toBe("🔥 grill · Q1 · ⚠ ungrounded");
	});

	test("interview without open question: no Q token", () => {
		const s = state({
			decisions: [
				{ question: "q", value: "a", label: "A", custom: false, at: 1 },
			],
		});
		expect(statusTokens(s)).toBe("🔥 grill · 1 decided");
	});

	test("output-selection phase", () => {
		const s = state({
			phase: "output-selection",
			decisions: [
				{ question: "q", value: "a", label: "A", custom: false, at: 1 },
			],
			currentQuestion: "irrelevant",
		});
		expect(statusTokens(s)).toBe("🔥 grill · pick outputs");
	});

	test("output phase: artifact basename", () => {
		const s = state({ outputPhase: true, outputPaths: ["docs/design.md"] });
		expect(statusTokens(s)).toBe("🔥 grill → writing design.md");
	});

	test("output phase delegating: writer token", () => {
		const s = state({
			outputPhase: true,
			delegate: true,
			chosenWriter: "doc-writer",
			outputPaths: ["README.md"],
		});
		expect(statusTokens(s)).toBe("🔥 grill → writing README.md · doc-writer");
	});

	test("output phase delegating without chosen writer: fallback", () => {
		const s = state({ outputPhase: true, delegate: true });
		expect(statusTokens(s)).toBe("🔥 grill → writing outputs · writer");
	});
});
