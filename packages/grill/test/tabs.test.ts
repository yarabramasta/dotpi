import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_STATE, type GrillState, runtime } from "../state.ts";
import {
	renderTabContent,
	renderTabStrip,
	TAB_NAMES,
	tabContent,
} from "../tabs.ts";

beforeAll(() => {
	// Markdown rendering needs the theme registry (same as pi's own setup).
	initTheme();
});

function setState(overrides: Partial<GrillState>): void {
	runtime.state = { ...DEFAULT_STATE, active: true, ...overrides };
}

afterEach(() => {
	runtime.state = { ...DEFAULT_STATE };
});

describe("TAB_NAMES", () => {
	test("four tabs, question first", () => {
		expect(TAB_NAMES).toEqual([
			"Question",
			"Checkpoint",
			"Grounding",
			"Review",
		]);
	});
});

describe("tabContent", () => {
	test("question tab: empty (picker renders itself)", () => {
		expect(tabContent(0)).toBe("");
	});

	test("checkpoint tab: session checkpoint markdown", () => {
		setState({ checkpoint: "# Shared understanding\n- decision" });
		expect(tabContent(1)).toBe("# Shared understanding\n- decision");
	});

	test("checkpoint tab: empty state placeholder", () => {
		expect(tabContent(1)).toBe("(no checkpoint recorded yet)");
	});

	test("grounding tab: dossier + evidence summaries", () => {
		setState({
			dossier: { text: "repo structure", at: 1 },
			grounding: { summary: "cymbal map ok", source: "cymbal", at: 2 },
			reviewer: { skippedReason: "no reviewer", summary: "", at: 3 },
		});
		const body = tabContent(2);
		expect(body).toContain("repo structure");
		expect(body).toContain("✓ grounding: cymbal map ok");
		expect(body).toContain("⚠ reviewer skipped: no reviewer");
	});

	test("grounding tab: skip reason instead of summary", () => {
		setState({ grounding: { summary: "", skippedReason: "no scouts", at: 1 } });
		expect(tabContent(2)).toContain("⚠ grounding skipped: no scouts");
	});

	test("review tab: decisions ✓ + open question ?", () => {
		setState({
			decisions: [
				{
					question: "q1",
					value: "a",
					label: "Alpha",
					custom: false,
					note: "why a",
					at: 1,
				},
				{ question: "q2", value: "b", label: "Beta", custom: true, at: 2 },
			],
			currentQuestion: "Which next?",
		});
		const body = tabContent(3);
		expect(body).toBe("✓ Alpha — why a\n✓ Beta\n? Which next?");
	});

	test("review tab: nothing decided yet", () => {
		expect(tabContent(3)).toBe("(nothing decided yet)");
	});
});

describe("renderTabStrip", () => {
	test("active tab accent-styled, others plain", () => {
		const strip = renderTabStrip(1, 80, (c, s) =>
			c === "accent" ? `[${s}]` : s,
		);
		expect(strip).toBe("Question | [Checkpoint] | Grounding | Review");
	});

	test("truncates to width (visible width, reset sequence excluded)", () => {
		const strip = renderTabStrip(0, 10, (_c, s) => s);
		expect(visibleWidth(strip)).toBeLessThanOrEqual(10);
	});
});

describe("renderTabContent", () => {
	test("question tab renders nothing", () => {
		expect(renderTabContent(0, 80)).toEqual([]);
	});

	test("renders markdown lines, clamped to width", () => {
		setState({
			checkpoint:
				"# Title\n\nSome **bold** paragraph that is long enough to wrap past eighty columns for sure.",
		});
		const lines = renderTabContent(1, 80);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines)
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	test("does not mutate session state", () => {
		setState({ checkpoint: "stable" });
		const before = runtime.state;
		renderTabContent(1, 80);
		expect(runtime.state).toBe(before);
	});
});
