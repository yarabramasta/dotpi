import { describe, expect, test } from "vitest";
import {
	decideLayout,
	leftColumnWidth,
	MAX_LEFT_RATIO,
	MIN_LEFT,
	MIN_PREVIEW_WIDTH,
	SIDE_BY_SIDE_MIN_WIDTH,
} from "../layout.ts";

describe("decideLayout", () => {
	test("stacked below the width floor", () => {
		expect(decideLayout(99, 99)).toBe("stacked");
		expect(decideLayout(80, 120)).toBe("stacked");
		expect(decideLayout(120, 80)).toBe("stacked");
	});

	test("side-by-side at/above the floor on both axes", () => {
		expect(decideLayout(100, 100)).toBe("side-by-side");
		expect(decideLayout(160, 160)).toBe("side-by-side");
	});
});

describe("leftColumnWidth", () => {
	test("default ratio capped by available (preview floor wins)", () => {
		// ratioWidth = 60 but available = 100 - 2 - 40 = 58 → left = 58.
		expect(leftColumnWidth(100, false)).toBe(58);
	});

	test("expanded (x) shrinks to 0.35", () => {
		expect(leftColumnWidth(100, true)).toBe(35);
	});

	test("preview floor protected: never starves the right pane", () => {
		// available = width - GAP(2) - MIN_PREVIEW_WIDTH(40)
		const w = 100;
		const available = w - 2 - MIN_PREVIEW_WIDTH;
		expect(leftColumnWidth(w, false)).toBeLessThanOrEqual(available);
	});

	test("floor MIN_LEFT applies on narrow-but-qualifying widths", () => {
		const w = SIDE_BY_SIDE_MIN_WIDTH;
		expect(leftColumnWidth(w, true)).toBeGreaterThanOrEqual(MIN_LEFT);
	});

	test("ratio is the tuned 0.6 constant", () => {
		expect(MAX_LEFT_RATIO).toBe(0.6);
		expect(MIN_PREVIEW_WIDTH).toBe(40);
	});
});
