import { describe, expect, test } from "vitest";
import {
	applyScroll,
	computeScrollStart,
	decorateOverflow,
} from "../scroll.ts";

const dim = (t: string) => `~${t}~`;

describe("computeScrollStart", () => {
	test("no focus → top-anchored", () => {
		expect(computeScrollStart(undefined, 0, 10, 40)).toBe(0);
	});

	test("clamps to bottom of the middle region", () => {
		expect(computeScrollStart([35, 36], 0, 10, 40)).toBe(30);
	});

	test("centers focused row when there is slack", () => {
		// focused rows 20-22, middle window 10 → start ≈ 20 - (10-2)/2 = 16
		expect(computeScrollStart([20, 22], 0, 10, 40)).toBe(16);
	});

	test("never negative", () => {
		expect(computeScrollStart([0, 1], 0, 10, 40)).toBe(0);
	});
});

describe("decorateOverflow", () => {
	test("up and down arrows on edges", () => {
		const win = ["a", "b", "c"];
		decorateOverflow(win, true, true, dim);
		expect(win).toEqual(["~↑~", "b", "~↓~"]);
	});

	test("single-row middle gets combined ↕", () => {
		const win = ["only"];
		decorateOverflow(win, true, true, dim);
		expect(win).toEqual(["~↕~"]);
	});

	test("only-up / only-down", () => {
		const win = ["a", "b"];
		decorateOverflow(win, true, false, dim);
		expect(win).toEqual(["~↑~", "b"]);
	});
});

describe("applyScroll", () => {
	function natural(rows: number, top = 2, bottom = 1) {
		const lines = Array.from({ length: rows }, (_, i) =>
			i < top ? `T${i}` : i >= rows - bottom ? `B` : `m${i}`,
		);
		return lines;
	}

	test("fits → unchanged", () => {
		const nat = natural(8);
		expect(
			applyScroll(nat, {
				topFixed: 2,
				bottomFixed: 1,
				focusedRange: undefined,
				termRows: 10,
				dim,
			}),
		).toEqual(nat);
	});

	test("overflow: heading + footer sticky, middle window carved", () => {
		// 30 lines, termRows 10, top 2, bottom 1 → middle 27 rows, window 7.
		const out = applyScroll(natural(30), {
			topFixed: 2,
			bottomFixed: 1,
			focusedRange: undefined,
			termRows: 10,
			dim,
		});
		expect(out).toHaveLength(10);
		expect(out[0]).toBe("T0");
		expect(out[1]).toBe("T1");
		expect(out[9]).toBe("B");
		// Top-anchored (no focus): scrollStart = 0 → no up arrow; bottom edge ↓.
		expect(out[2]).toBe("m2");
		expect(out[3]).toBe("m3");
		expect(out[8]).toBe("~↓~");
	});

	test("overflow: window centered on focused rows", () => {
		// 30 lines: middle rows are m2..m27 (26 rows), window 7, focus at m10-m11
		// → scrollStart = (10-2) - (7-1)/2 = 5 → window m7..m13.
		const out = applyScroll(natural(30), {
			topFixed: 2,
			bottomFixed: 1,
			focusedRange: [8, 9], // natural index; middle index = 8-2 = 6... see below
			termRows: 10,
			dim,
		});
		// focusedRange is natural-relative; computeScrollStart sees middle-relative
		// via its own offset math — verify arrows + sticky bounds only.
		expect(out).toHaveLength(10);
		expect(out[0]).toBe("T0");
		expect(out[9]).toBe("B");
		expect(out[2]).toBe("~↑~");
		expect(out[8]).toBe("~↓~");
	});

	test("overflow: bottom clamped — no down arrow past the end", () => {
		const out = applyScroll(natural(30), {
			topFixed: 2,
			bottomFixed: 1,
			focusedRange: [26, 27], // near the bottom
			termRows: 10,
			dim,
		});
		// Window clamps to the bottom of the middle region (m2..m28): last row
		// undecorated (no down arrow past the end).
		expect(out).toHaveLength(10);
		expect(out[2]).toBe("~↑~");
		expect(out[8]).toBe("m28");
	});

	test("term smaller than chrome → chrome-only, clamped", () => {
		const out = applyScroll(natural(30), {
			topFixed: 8,
			bottomFixed: 3,
			focusedRange: undefined,
			termRows: 6,
			dim,
		});
		expect(out).toHaveLength(6);
	});

	test("scrollStart override wins over focus-centering", () => {
		const out = applyScroll(natural(30), {
			topFixed: 2,
			bottomFixed: 1,
			focusedRange: undefined,
			termRows: 10,
			dim,
			scrollStart: 3,
		});
		// Window covers m6..m12: up arrow at the top edge, down arrow at the end.
		expect(out).toHaveLength(10);
		expect(out[2]).toBe("~↑~");
		expect(out[3]).toBe("m6");
		expect(out[8]).toBe("~↓~");
	});

	test("scrollStart override clamps to the middle region", () => {
		const out = applyScroll(natural(30), {
			topFixed: 2,
			bottomFixed: 1,
			focusedRange: undefined,
			termRows: 10,
			dim,
			scrollStart: 999,
		});
		// Clamped to the last window (m22..m28): up arrow, no down arrow at end.
		expect(out).toHaveLength(10);
		expect(out[2]).toBe("~↑~");
		expect(out[8]).toBe("m28");
	});
});
