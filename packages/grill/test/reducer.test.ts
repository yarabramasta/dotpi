import { describe, expect, test } from "vitest";
import {
	initialPickerState,
	insertText,
	type PickerEnv,
	type PickerOption,
	type PickerState,
	reducePicker,
} from "../picker-state.ts";

const OPTIONS: PickerOption[] = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
];
const env: PickerEnv = { options: OPTIONS };

function step(
	state: PickerState = initialPickerState(),
	action: Parameters<typeof reducePicker>[1] = { kind: "cancel" },
	e: PickerEnv = env,
) {
	return reducePicker(state, action, e);
}

describe("reducePicker: nav", () => {
	test("nav_up clamps at first row", () => {
		const { state } = step(initialPickerState(), { kind: "nav_up" });
		expect(state.selected).toBe(0);
	});

	test("nav_down stops at sentinel row (options.length)", () => {
		let s = initialPickerState();
		for (let i = 0; i < 10; i++) s = step(s, { kind: "nav_down" }).state;
		expect(s.selected).toBe(OPTIONS.length);
	});

	test("nav exits editing but preserves the draft", () => {
		let s = {
			...initialPickerState(),
			selected: 2,
			editing: true,
			draft: "hi",
			cursor: 2,
		};
		s = step(s, { kind: "nav_up" }).state;
		expect(s.editing).toBe(false);
		expect(s.draft).toBe("hi");
		expect(s.selected).toBe(1);
	});
});

describe("reducePicker: custom draft", () => {
	test("edit_custom on sentinel row opens editor with cursor at end", () => {
		const s = { ...initialPickerState(), selected: 2 };
		const { state } = step(s, { kind: "edit_custom" });
		expect(state.editing).toBe(true);
		expect(state.cursor).toBe(0);
	});

	test("edit_custom on option row is a no-op", () => {
		const { state } = step(initialPickerState(), { kind: "edit_custom" });
		expect(state.editing).toBe(false);
	});

	test("confirm while editing non-empty draft → done custom answer", () => {
		const s = {
			...initialPickerState(),
			selected: 2,
			editing: true,
			draft: "my answer",
			cursor: 9,
		};
		const { effects } = step(s, { kind: "confirm" });
		expect(effects).toEqual([
			{
				kind: "done",
				result: {
					status: "answered",
					value: "my answer",
					label: "my answer",
					custom: true,
					note: undefined,
				},
			},
		]);
	});

	test("confirm while editing empty draft → back to browse, no effect", () => {
		const s = { ...initialPickerState(), selected: 2, editing: true };
		const { state, effects } = step(s, { kind: "confirm" });
		expect(state.editing).toBe(false);
		expect(effects).toEqual([]);
	});

	test("input_edit inserts at cursor", () => {
		const s = {
			...initialPickerState(),
			selected: 2,
			editing: true,
			draft: "ab",
			cursor: 1,
		};
		const { state } = step(s, { kind: "input_edit", data: "X" });
		expect(state.draft).toBe("aXb");
		expect(state.cursor).toBe(2);
	});

	test("input_edit drops control bytes (paste with control chars)", () => {
		const s = { ...initialPickerState(), selected: 2, editing: true };
		const { state } = step(s, { kind: "input_edit", data: "\x1b\x1fok" });
		expect(state.draft).toBe("ok");
	});

	test("\x7f deletes one grapheme (emoji safe)", () => {
		const s = {
			...initialPickerState(),
			selected: 2,
			editing: true,
			draft: "a👨‍👩‍👧b",
			cursor: "a👨‍👩‍👧".length,
		};
		const { state } = step(s, { kind: "input_edit", data: "\x7f" });
		expect(state.draft).toBe("ab");
	});

	test("input_clear empties draft and resets cursor", () => {
		const s = {
			...initialPickerState(),
			selected: 2,
			editing: true,
			draft: "junk",
			cursor: 4,
		};
		const { state } = step(s, { kind: "input_clear" });
		expect(state.draft).toBe("");
		expect(state.cursor).toBe(0);
	});

	test("input_clear while browsing is a no-op", () => {
		const s = { ...initialPickerState(), draft: "", editing: false };
		const { state, effects } = step(s, { kind: "input_clear" });
		expect(effects).toEqual([]);
		expect(state).toEqual(s);
	});
});

describe("reducePicker: note", () => {
	test("note_open seeds the note editor from the committed note", () => {
		const s = { ...initialPickerState(), note: "prior" };
		const { state } = step(s, { kind: "note_open" });
		expect(state.noteEditing).toBe(true);
		expect(state.noteDraft).toBe("prior");
		expect(state.noteCursor).toBe(5);
		expect(state.editing).toBe(false);
	});

	test("note_close commits trimmed note; blank becomes undefined", () => {
		const s = {
			...initialPickerState(),
			noteEditing: true,
			noteDraft: "  hi  ",
		};
		const { state } = step(s, { kind: "note_close" });
		expect(state.note).toBe("hi");
		expect(state.noteEditing).toBe(false);

		const blank = step(
			{ ...initialPickerState(), noteEditing: true, noteDraft: "   " },
			{ kind: "note_close" },
		).state;
		expect(blank.note).toBeUndefined();
	});

	test("cancel in note mode discards draft, keeps committed note", () => {
		const s = {
			...initialPickerState(),
			note: "kept",
			noteEditing: true,
			noteDraft: "discard me",
		};
		const { state, effects } = step(s, { kind: "cancel" });
		expect(state.noteEditing).toBe(false);
		expect(state.note).toBe("kept");
		expect(effects).toEqual([]);
	});

	test("note_edit inserts and backspaces", () => {
		const s = {
			...initialPickerState(),
			noteEditing: true,
			noteDraft: "ab",
			noteCursor: 2,
		};
		const after = step(s, { kind: "note_edit", data: "!" }).state;
		expect(after.noteDraft).toBe("ab!");
		const back = step(after, { kind: "note_edit", data: "\x7f" }).state;
		expect(back.noteDraft).toBe("ab");
	});

	test("note_edit ignored outside note mode", () => {
		const { state, effects } = step(initialPickerState(), {
			kind: "note_edit",
			data: "x",
		});
		expect(state.noteDraft).toBe("");
		expect(effects).toEqual([]);
	});
});

describe("reducePicker: options + cancel", () => {
	test("confirm on option row → answered with option value, note attached", () => {
		const s = { ...initialPickerState(), selected: 1, note: "why b" };
		const { effects } = step(s, { kind: "confirm" });
		expect(effects).toEqual([
			{
				kind: "done",
				result: {
					status: "answered",
					value: "b",
					label: "Beta",
					custom: false,
					note: "why b",
				},
			},
		]);
	});

	test("cancel in browse mode → done cancelled with note", () => {
		const { effects } = step(
			{ ...initialPickerState(), note: "n" },
			{ kind: "cancel" },
		);
		expect(effects).toEqual([
			{
				kind: "done",
				result: {
					status: "cancelled",
					value: "",
					label: "",
					custom: false,
					note: "n",
				},
			},
		]);
	});

	test("cancel while editing exits editor, no effect", () => {
		const s = {
			...initialPickerState(),
			selected: 2,
			editing: true,
			draft: "draft",
		};
		const { state, effects } = step(s, { kind: "cancel" });
		expect(state.editing).toBe(false);
		expect(state.draft).toBe("draft");
		expect(effects).toEqual([]);
	});
});

describe("reducePicker: toggles", () => {
	test("tab cycling wraps both directions over TOTAL_TABS", () => {
		let s = initialPickerState();
		for (let i = 0; i < 4; i++) s = step(s, { kind: "tab_next" }).state;
		expect(s.tab).toBe(0);
		s = step(s, { kind: "tab_prev" }).state;
		expect(s.tab).toBe(3);
	});

	test("tab switch resets aux scroll", () => {
		let s = { ...initialPickerState(), scroll: 5 };
		s = step(s, { kind: "tab_next" }).state;
		expect(s.scroll).toBe(0);
	});

	test("scroll_up floors at 0, scroll_down increments (render clamps top)", () => {
		let s = step(initialPickerState(), { kind: "scroll_up" }).state;
		expect(s.scroll).toBe(0);
		s = step(s, { kind: "scroll_down" }).state;
		s = step(s, { kind: "scroll_down" }).state;
		expect(s.scroll).toBe(2);
	});

	test("expand_toggle flips", () => {
		const { state } = step(initialPickerState(), { kind: "expand_toggle" });
		expect(state.expanded).toBe(true);
	});

	test("collapse_toggle flips and is independent of editing", () => {
		const s = { ...initialPickerState(), editing: true };
		const { state } = step(s, { kind: "collapse_toggle" });
		expect(state.collapsed).toBe(true);
	});

	test("external produces open_external_editor effect only", () => {
		const { effects } = step(initialPickerState(), {
			kind: "external",
			target: "note",
		});
		expect(effects).toEqual([{ kind: "open_external_editor", target: "note" }]);
	});
});

describe("insertText", () => {
	test("newline inserts verbatim", () => {
		expect(insertText("a", 1, "\nb")).toEqual({ buffer: "a\nb", cursor: 3 });
	});

	test("empty data is a no-op", () => {
		expect(insertText("a", 1, "")).toEqual({ buffer: "a", cursor: 1 });
		expect(insertText("a", 1, "\x00\x01")).toEqual({ buffer: "a", cursor: 1 });
	});
});
