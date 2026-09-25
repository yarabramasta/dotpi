import { describe, expect, test } from "vitest";
import {
	initialPickerState,
	type PickerEnv,
	type PickerKeybindings,
	type PickerState,
	routePickerKey,
} from "../picker-state.ts";

const env: PickerEnv = {
	options: [
		{ value: "a", label: "Alpha" },
		{ value: "b", label: "Beta" },
	],
};

/** Stub keybinding surface: map keybinding id → key. */
function makeKb(map: Record<string, string>): PickerKeybindings {
	return { matches: (data, id) => map[id] === data };
}

const DEFAULTS = makeKb({
	"tui.select.up": "\x1b[A",
	"tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r",
	"tui.input.submit": "\r",
	"tui.select.cancel": "\x1b",
	"tui.input.newLine": "\x1b\r",
	"tui.editor.deleteToLineStart": "\x15",
	"tui.editor.deleteCharBackward": "\x7f",
	"tui.editor.cursorLeft": "\x1b[D",
	"tui.editor.cursorRight": "\x1b[C",
	"app.editor.external": "\x07",
});

function route(
	data: string,
	state: PickerState = initialPickerState(),
	kb: PickerKeybindings = DEFAULTS,
	collapseKey?: string,
) {
	return routePickerKey(data, state, env, kb, collapseKey);
}

describe("routePickerKey: browse", () => {
	test("up/down → nav", () => {
		expect(route("\x1b[A")).toEqual({ kind: "nav_up" });
		expect(route("\x1b[B")).toEqual({ kind: "nav_down" });
	});

	test("enter on option → confirm", () => {
		expect(route("\r")).toEqual({ kind: "confirm" });
	});

	test("enter on sentinel row → edit_custom", () => {
		const s = { ...initialPickerState(), selected: 2 };
		expect(route("\r", s)).toEqual({ kind: "edit_custom" });
	});

	test("tab / shift+tab and arrows cycle tabs", () => {
		expect(route("\t")).toEqual({ kind: "tab_next" });
		expect(route("\x1b[C")).toEqual({ kind: "tab_next" });
		expect(route("\x1b[Z")).toEqual({ kind: "tab_prev" });
		expect(route("\x1b[D")).toEqual({ kind: "tab_prev" });
	});

	test("n → note_open, x → expand_toggle", () => {
		expect(route("n")).toEqual({ kind: "note_open" });
		expect(route("x")).toEqual({ kind: "expand_toggle" });
	});

	test("escape → cancel", () => {
		expect(route("\x1b")).toEqual({ kind: "cancel" });
	});

	test("unmatched printable → ignore", () => {
		expect(route("q")).toEqual({ kind: "ignore" });
	});
});

describe("routePickerKey: editing (custom draft)", () => {
	const editing = { ...initialPickerState(), selected: 2, editing: true };

	test("newline inserts before confirm (rpiv collision rule)", () => {
		const collide = makeKb({
			"tui.select.confirm": "\r",
			"tui.input.submit": "\r",
			"tui.input.newLine": "\r",
		});
		expect(route("\r", editing, collide)).toEqual({
			kind: "input_edit",
			data: "\n",
		});
	});

	test("enter → confirm when newLine bound elsewhere", () => {
		expect(route("\r", editing)).toEqual({ kind: "confirm" });
	});

	test("ctrl+u → delete to line start, ctrl+g → external custom", () => {
		expect(route("\x15", editing)).toEqual({
			kind: "input_edit",
			data: "\x15",
		});
		expect(route("\x07", editing)).toEqual({
			kind: "external",
			target: "custom",
		});
	});

	test("backspace → grapheme delete chunk", () => {
		expect(route("\x7f", editing)).toEqual({
			kind: "input_edit",
			data: "\x7f",
		});
	});

	test("option+backspace raw sequences → word delete", () => {
		expect(route("\x17", editing)).toEqual({
			kind: "input_edit",
			data: "\x17",
		});
		expect(route("\x1b\x7f", editing)).toEqual({
			kind: "input_edit",
			data: "\x17",
		});
	});

	test("deleteWordBackward keybinding → word delete", () => {
		const kb = makeKb({ "tui.editor.deleteWordBackward": "\x17" });
		expect(route("\x17", editing, kb)).toEqual({
			kind: "input_edit",
			data: "\x17",
		});
	});

	test("left/right → cursor moves", () => {
		expect(route("\x1b[D", editing)).toEqual({ kind: "cursor_left" });
		expect(route("\x1b[C", editing)).toEqual({ kind: "cursor_right" });
	});

	test("up/down → nav (draft preserved by reducer)", () => {
		expect(route("\x1b[A", editing)).toEqual({ kind: "nav_up" });
		expect(route("\x1b[B", editing)).toEqual({ kind: "nav_down" });
	});

	test("plain text → input_edit", () => {
		expect(route("hello", editing)).toEqual({
			kind: "input_edit",
			data: "hello",
		});
	});
});

describe("routePickerKey: note mode", () => {
	const noting = { ...initialPickerState(), noteEditing: true };

	test("enter → note_close, newline inserts", () => {
		expect(route("\r", noting)).toEqual({ kind: "note_close" });
		expect(route("\x1b\r", noting)).toEqual({ kind: "note_edit", data: "\n" });
	});

	test("ctrl+g → external note, ctrl+u → delete to line start", () => {
		expect(route("\x07", noting)).toEqual({ kind: "external", target: "note" });
		expect(route("\x15", noting)).toEqual({
			kind: "note_edit",
			data: "\x15",
		});
	});

	test("text → note_edit", () => {
		expect(route("abc", noting)).toEqual({ kind: "note_edit", data: "abc" });
	});

	test("option+backspace raw sequences → word delete", () => {
		expect(route("\x17", noting)).toEqual({
			kind: "note_edit",
			data: "\x17",
		});
		expect(route("\x1b\x7f", noting)).toEqual({
			kind: "note_edit",
			data: "\x17",
		});
	});

	test("deleteWordBackward keybinding → word delete", () => {
		const kb = makeKb({ "tui.editor.deleteWordBackward": "\x17" });
		expect(route("\x17", noting, kb)).toEqual({
			kind: "note_edit",
			data: "\x17",
		});
	});
});

describe("routePickerKey: aux tabs (read-only)", () => {
	const aux = { ...initialPickerState(), tab: 1 };

	test("tab cycling still works", () => {
		expect(route("\t", aux)).toEqual({ kind: "tab_next" });
		expect(route("\x1b[Z", aux)).toEqual({ kind: "tab_prev" });
		expect(route("\x1b[C", aux)).toEqual({ kind: "tab_next" });
		expect(route("\x1b[D", aux)).toEqual({ kind: "tab_prev" });
	});

	test("cancel still works", () => {
		expect(route("\x1b", aux)).toEqual({ kind: "cancel" });
	});

	test("up/down scroll overflowed content", () => {
		expect(route("\x1b[A", aux)).toEqual({ kind: "scroll_up" });
		expect(route("\x1b[B", aux)).toEqual({ kind: "scroll_down" });
	});

	test("mutating keys are swallowed", () => {
		expect(route("\r", aux)).toEqual({ kind: "ignore" });
		expect(route("n", aux)).toEqual({ kind: "ignore" });
		expect(route("x", aux)).toEqual({ kind: "ignore" });
		expect(route("q", aux)).toEqual({ kind: "ignore" });
	});
});

describe("routePickerKey: collapsed", () => {
	const collapsed = { ...initialPickerState(), collapsed: true };

	test("cancel still works; everything else swallowed", () => {
		expect(route("\x1b", collapsed)).toEqual({ kind: "cancel" });
		expect(route("\r", collapsed)).toEqual({ kind: "ignore" });
		expect(route("\x1b[A", collapsed)).toEqual({ kind: "ignore" });
		expect(route("n", collapsed)).toEqual({ kind: "ignore" });
	});
});

describe("routePickerKey: collapse key intercept", () => {
	test("configured key toggles from any mode", () => {
		const editing = { ...initialPickerState(), selected: 2, editing: true };
		expect(route("\x1d", editing, DEFAULTS, "ctrl+]")).toEqual({
			kind: "collapse_toggle",
		});
	});

	test("off disables the toggle", () => {
		expect(route("\x1d", initialPickerState(), DEFAULTS, "off")).toEqual({
			kind: "ignore",
		});
	});
});

describe("routePickerKey: bracketed paste", () => {
	const noting = { ...initialPickerState(), noteEditing: true };
	const editing = { ...initialPickerState(), selected: 2, editing: true };
	const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

	test("paste in note mode → cleaned note_edit", () => {
		expect(route(paste("hello"), noting)).toEqual({
			kind: "note_edit",
			data: "hello",
		});
	});

	test("paste in custom editing → cleaned input_edit", () => {
		expect(route(paste("hello"), editing)).toEqual({
			kind: "input_edit",
			data: "hello",
		});
	});

	test("paste in browse mode → ignore", () => {
		expect(route(paste("hello"))).toEqual({ kind: "ignore" });
	});

	test("start marker without end marker still cleans", () => {
		expect(route("\x1b[200~world", noting)).toEqual({
			kind: "note_edit",
			data: "world",
		});
	});

	test("paste while collapsed is swallowed", () => {
		const collapsed = { ...initialPickerState(), collapsed: true };
		expect(route(paste("hello"), collapsed)).toEqual({ kind: "ignore" });
	});
});
