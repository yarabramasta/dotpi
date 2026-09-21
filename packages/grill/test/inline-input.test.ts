import { describe, expect, test } from "vitest";
import { renderInlineInputRow } from "../inline-input.ts";

// Strip styling for width-agnostic assertions.
const plain = (text: string) => text;

// Strip styling + pi-tui's zero-width CURSOR_MARKER (OSC-style \x1b_pi:c\x07).
const stripAnsi = (s: string) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: CURSOR_MARKER is a fixed ESC/BEL-delimited sequence that must be matched literally.
	s.replace(/\x1b_pi:c\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");

describe("renderInlineInputRow", () => {
	test("single line with row prefix", () => {
		const rows = renderInlineInputRow({
			buffer: "hello",
			cursorOffset: 5,
			rowPrefix: "❯ 3. ",
			continuationPrefix: "     ",
			contentWidth: 40,
			selectedText: plain,
		});
		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0])).toBe("❯ 3. hello\xa0");
	});

	test("cursor mid-buffer inverts the cell under it without splitting text", () => {
		const rows = renderInlineInputRow({
			buffer: "abc",
			cursorOffset: 1,
			rowPrefix: "",
			continuationPrefix: "",
			contentWidth: 40,
			selectedText: plain,
		});
		// "a" before cursor, "b" under cursor (reverse video), "c" after; no NBSP
		// cell mid-buffer.
		expect(rows[0]).toContain("a");
		expect(rows[0]).toContain("\x1b[7mb\x1b[27m");
		expect(stripAnsi(rows[0])).toBe("abc");
	});

	test("cursor on emoji does not split the cluster", () => {
		const rows = renderInlineInputRow({
			buffer: "a👨‍👩‍👧b",
			cursorOffset: 1,
			rowPrefix: "",
			continuationPrefix: "",
			contentWidth: 40,
			selectedText: plain,
		});
		// Whole ZWJ cluster under the cursor as one cell.
		expect(rows[0]).toContain("\x1b[7m👨‍👩‍👧\x1b[27m");
	});

	test("wraps long buffers with continuation prefix", () => {
		const rows = renderInlineInputRow({
			buffer: "aaaa bbbb cccc dddd eeee",
			cursorOffset: 24,
			rowPrefix: "❯ 1. ",
			continuationPrefix: "  ",
			contentWidth: 10,
			selectedText: plain,
		});
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows.slice(1)) {
			expect(row.startsWith("  ")).toBe(true);
		}
		// Reassembled content preserves all words (strip spaces and the join pipe).
		expect(stripAnsi(rows.join("|")).replace(/[ |]/g, "")).toContain(
			"aaaabbbbccccddddeeee",
		);
	});

	test("newline renders as wrapped logical line; cursor sits on NBSP at line end", () => {
		const rows = renderInlineInputRow({
			buffer: "a\nb",
			cursorOffset: 1,
			rowPrefix: "",
			continuationPrefix: "",
			contentWidth: 40,
			selectedText: plain,
		});
		// Cursor at the newline: NBSP cell before the line break, then "b".
		expect(rows[0]).toContain("\x1b[7m\xa0\x1b[27m");
	});

	test("empty buffer renders just the cursor cell", () => {
		const rows = renderInlineInputRow({
			buffer: "",
			cursorOffset: 0,
			rowPrefix: "Note: ",
			continuationPrefix: "      ",
			contentWidth: 40,
			selectedText: plain,
		});
		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0])).toBe("Note: \xa0");
	});

	test("out-of-range cursor falls back to end of buffer", () => {
		const rows = renderInlineInputRow({
			buffer: "abc",
			cursorOffset: 99,
			rowPrefix: "",
			continuationPrefix: "",
			contentWidth: 40,
			selectedText: plain,
		});
		// Cursor on NBSP past "c".
		expect(stripAnsi(rows[0])).toBe("abc\xa0");
	});

	test("selectedText styling is applied per emitted line", () => {
		const rows = renderInlineInputRow({
			buffer: "x",
			cursorOffset: 1,
			rowPrefix: "",
			continuationPrefix: "",
			contentWidth: 40,
			selectedText: (t) => `<${t}>`,
		});
		expect(rows[0]).toContain("<x");
	});
});
