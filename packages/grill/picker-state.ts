import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";

// Re-exported by picker.ts so tools keep their import paths.
export interface PickerOption {
	value: string;
	label: string;
	description?: string;
	preview?: string;
}

export interface PickerResult {
	status: "answered" | "cancelled";
	value: string;
	label: string;
	custom: boolean;
	note?: string;
}

/** Aux tabs (step 5). Tab 0 is the Question tab (the picker itself); the rest
 * render read-only content. Cycling is wired in the reducer now so the strip
 * is a pure render change when it lands. */
export const TOTAL_TABS = 4;

export interface PickerState {
	/** 0..options.length-1 = option rows; options.length = "Type something." sentinel. */
	selected: number;
	tab: number;
	/** Preview expand toggle (x). */
	expanded: boolean;
	/** Collapse mode (step 6): overlay hidden, all keys swallowed except cancel. */
	collapsed: boolean;
	/** Inline custom-answer draft active ("Type something." row edits in place). */
	editing: boolean;
	draft: string;
	/** UTF-16 offset into `draft`; grapheme-safe (see graphemeBefore). */
	cursor: number;
	/** Committed note; trimmed on close. */
	note?: string;
	/** Inline note editor active. */
	noteEditing: boolean;
	noteDraft: string;
	noteCursor: number;
	/** Aux-tab scroll offset (up/down while a read-only tab is open). */
	scroll: number;
}

/** Reducer environment: the option rows for the current question. Static per
 * picker round, so it stays out of the persistent state. */
export interface PickerEnv {
	options: PickerOption[];
}

export type PickerAction =
	| { kind: "nav_up" }
	| { kind: "nav_down" }
	| { kind: "tab_next" }
	| { kind: "tab_prev" }
	| { kind: "scroll_up" }
	| { kind: "scroll_down" }
	| { kind: "edit_custom" }
	| { kind: "confirm" }
	| { kind: "note_open" }
	| { kind: "note_close" }
	| { kind: "cancel" }
	| { kind: "collapse_toggle" }
	| { kind: "expand_toggle" }
	/** Clear the active buffer (draft while editing, noteDraft while noteEditing). */
	| { kind: "input_clear" }
	| { kind: "cursor_left" }
	| { kind: "cursor_right" }
	/** Printable text inserted at the cursor of the active buffer; "\x7f"
	 * (deleteCharBackward) deletes the grapheme before the cursor. */
	| { kind: "input_edit"; data: string }
	/** Explicit note-target insert (note mode routes here exclusively). */
	| { kind: "note_edit"; data: string }
	/** Ctrl+G: eject to the external editor; runtime executes the effect. */
	| { kind: "external"; target: "custom" | "note" }
	/** Key fell through every binding; render nothing new. */
	| { kind: "ignore" };

export type PickerEffect =
	| { kind: "open_external_editor"; target: "custom" | "note" }
	| { kind: "done"; result: PickerResult };

export interface PickerStateEnv {
	state: PickerState;
	effects: PickerEffect[];
}

export function initialPickerState(): PickerState {
	return {
		selected: 0,
		tab: 0,
		expanded: false,
		collapsed: false,
		editing: false,
		draft: "",
		cursor: 0,
		note: undefined,
		noteEditing: false,
		noteDraft: "",
		noteCursor: 0,
		scroll: 0,
	};
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

/** Width (UTF-16 units) of the grapheme cluster containing the character just
 * before `cursor`. 0 when already at the start. */
function graphemeBefore(buffer: string, cursor: number): number {
	if (cursor <= 0) return 0;
	for (const seg of graphemeSegmenter.segment(buffer)) {
		const end = seg.index + seg.segment.length;
		if (end >= cursor) return cursor - seg.index;
	}
	return 0;
}

const isPrintable = (ch: string): boolean =>
	ch === "\n" || (ch.codePointAt(0) ?? 0) >= 0x20;

/** Insert `data` at `cursor`, dropping non-printable control bytes. Mutates
 * nothing; returns the next buffer + cursor. */
export function insertText(
	buffer: string,
	cursor: number,
	data: string,
): { buffer: string; cursor: number } {
	if (!data) return { buffer, cursor };
	const text = [...data].filter(isPrintable).join("");
	if (!text) return { buffer, cursor };
	return {
		buffer: buffer.slice(0, cursor) + text + buffer.slice(cursor),
		cursor: cursor + text.length,
	};
}

/** Delete the preceding whitespace + word, leaving the cursor where the
 * removed chunk began. `cursor === 0` is a no-op. */
function deleteWordBackward(
	buffer: string,
	cursor: number,
): { buffer: string; cursor: number } {
	if (cursor <= 0) return { buffer, cursor };
	let start = cursor;
	while (start > 0 && /\s/.test(buffer[start - 1])) start--;
	while (start > 0 && !/\s/.test(buffer[start - 1])) start--;
	return {
		buffer: buffer.slice(0, start) + buffer.slice(cursor),
		cursor: start,
	};
}

/** Apply one input chunk to a buffer: printable insert, "\x7f" grapheme
 * delete-before-cursor, or "\x17"/"\x1b\x7f" delete-word-backward. */
function applyEdit(
	buffer: string,
	cursor: number,
	data: string,
): { buffer: string; cursor: number } {
	if (data === "\x7f") {
		const width = graphemeBefore(buffer, cursor);
		if (width === 0) return { buffer, cursor };
		return {
			buffer: buffer.slice(0, cursor - width) + buffer.slice(cursor),
			cursor: cursor - width,
		};
	}
	if (data === "\x17" || data === "\x1b\x7f") {
		return deleteWordBackward(buffer, cursor);
	}
	if (data === "\x15") {
		if (cursor <= 0) return { buffer, cursor };
		const lineStart = buffer.lastIndexOf("\n", cursor - 1);
		const nextCursor = lineStart === -1 ? 0 : lineStart;
		return {
			buffer: buffer.slice(0, nextCursor) + buffer.slice(cursor),
			cursor: nextCursor,
		};
	}
	return insertText(buffer, cursor, data);
}

const wrapTab = (index: number): number =>
	((index % TOTAL_TABS) + TOTAL_TABS) % TOTAL_TABS;

/** Pure picker reducer. Zero TUI access; effects are returned for the runtime
 * (picker.ts) to execute — never performed here. */
export function reducePicker(
	state: PickerState,
	action: PickerAction,
	env: PickerEnv,
): PickerStateEnv {
	const next: PickerState = { ...state };
	const effects: PickerEffect[] = [];
	const done = (result: PickerResult) => effects.push({ kind: "done", result });

	switch (action.kind) {
		case "nav_up":
			// Leaving the draft keeps it (browse preserves the draft).
			next.editing = false;
			next.selected = Math.max(0, state.selected - 1);
			break;
		case "nav_down":
			next.editing = false;
			next.selected = Math.min(env.options.length, state.selected + 1);
			break;
		case "tab_next":
			next.tab = wrapTab(state.tab + 1);
			next.scroll = 0;
			break;
		case "tab_prev":
			next.tab = wrapTab(state.tab - 1);
			next.scroll = 0;
			break;
		case "scroll_up":
			// Render clamps the top end; keep 0 as the floor here.
			next.scroll = Math.max(0, state.scroll - 1);
			break;
		case "scroll_down":
			// Render clamps against the content height.
			next.scroll = state.scroll + 1;
			break;
		case "edit_custom":
			// Only the sentinel row starts the inline draft editor.
			if (state.selected === env.options.length) {
				next.editing = true;
				next.noteEditing = false;
				next.cursor = state.draft.length;
			}
			break;
		case "confirm":
			if (state.noteEditing) {
				next.noteEditing = false;
				next.note = state.noteDraft.trim() || undefined;
				break;
			}
			if (state.editing) {
				const value = state.draft.trim();
				if (value) {
					done({
						status: "answered",
						value,
						label: value,
						custom: true,
						note: state.note,
					});
				} else {
					next.editing = false;
				}
				break;
			}
			// Defensive: confirm on the sentinel row without editing → start draft.
			if (state.selected === env.options.length) {
				next.editing = true;
				next.cursor = state.draft.length;
				break;
			}
			{
				const option = env.options[state.selected];
				if (option) {
					done({
						status: "answered",
						value: option.value,
						label: option.label,
						custom: false,
						note: state.note,
					});
				}
			}
			break;
		case "note_open":
			next.editing = false;
			next.noteEditing = true;
			next.noteDraft = state.note ?? "";
			next.noteCursor = (state.note ?? "").length;
			break;
		case "note_close": {
			const note = state.noteDraft.trim();
			next.noteEditing = false;
			next.note = note || undefined;
			break;
		}
		case "cancel":
			if (state.noteEditing) {
				// Discard the note draft; keep any committed note.
				next.noteEditing = false;
				break;
			}
			if (state.editing) {
				next.editing = false;
				break;
			}
			done({
				status: "cancelled",
				value: "",
				label: "",
				custom: false,
				note: state.note,
			});
			break;
		case "collapse_toggle":
			next.collapsed = !state.collapsed;
			break;
		case "expand_toggle":
			next.expanded = !state.expanded;
			break;
		case "input_clear":
			if (state.noteEditing) {
				next.noteDraft = "";
				next.noteCursor = 0;
			} else if (state.editing) {
				next.draft = "";
				next.cursor = 0;
			}
			break;
		case "cursor_left":
		case "cursor_right": {
			const delta = action.kind === "cursor_left" ? -1 : 1;
			if (state.noteEditing) {
				next.noteCursor = Math.min(
					state.noteDraft.length,
					Math.max(0, state.noteCursor + delta),
				);
			} else if (state.editing) {
				next.cursor = Math.min(
					state.draft.length,
					Math.max(0, state.cursor + delta),
				);
			}
			break;
		}
		case "input_edit":
			if (state.editing) {
				const applied = applyEdit(state.draft, state.cursor, action.data);
				next.draft = applied.buffer;
				next.cursor = applied.cursor;
			}
			break;
		case "note_edit":
			if (state.noteEditing) {
				const applied = applyEdit(
					state.noteDraft,
					state.noteCursor,
					action.data,
				);
				next.noteDraft = applied.buffer;
				next.noteCursor = applied.cursor;
			}
			break;
		case "external":
			effects.push({ kind: "open_external_editor", target: action.target });
			break;
		default:
			break;
	}

	return { state: next, effects };
}

/** Minimal keybinding surface the router needs — matches the shape of pi's
 * KeybindingsManager, so tests can stub it freely. */
export interface PickerKeybindings {
	matches(data: string, keybinding: string): boolean;
}
export type { KeybindingsManager };

// Confirm has two semantic sources (rpiv rule): `tui.select.confirm` is the
// select-list default; `tui.input.submit` is the user's "send" key. With pi
// defaults both resolve to enter, so matching either is equivalent.
function isConfirm(kb: PickerKeybindings, data: string): boolean {
	return (
		kb.matches(data, "tui.select.confirm") ||
		kb.matches(data, "tui.input.submit")
	);
}

// Bracketed paste markers: pi-tui re-wraps pasted content as
// \x1b[200~text\x1b[201~ before dispatching it to components
// (terminal.ts, "existing editor handling").
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

const EXTERNAL_ID = "app.editor.external";
const CLEAR_ID = "tui.editor.deleteToLineStart";
const BACKSPACE_ID = "tui.editor.deleteCharBackward";
const DELETE_WORD_BACKWARD_ID = "tui.editor.deleteWordBackward";

/** Map raw input to a PickerAction via pi keybinding ids. Mode-dispatched like
 * rpiv's key-router; pure. `tui.input.newLine` is checked before confirm in
 * edit modes so a newline never confirms even when the two ids share a key. */
export function routePickerKey(
	data: string,
	state: PickerState,
	env: PickerEnv,
	kb: PickerKeybindings,
	collapseKey?: string,
): PickerAction {
	// Collapse toggle is intercepted at the top so it works from every mode
	// (editing, notes, collapsed) without reaching a consuming branch.
	if (
		collapseKey &&
		collapseKey !== "off" &&
		matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])
	) {
		return { kind: "collapse_toggle" };
	}

	// Collapsed: swallow everything except cancel (step 6 semantics).
	if (state.collapsed) {
		return kb.matches(data, "tui.select.cancel")
			? { kind: "cancel" }
			: { kind: "ignore" };
	}

	// Bracketed paste: strip the markers and route the cleaned text to the
	// active editor. Browse mode has no buffer, so paste is ignored there.
	if (data.startsWith(BRACKETED_PASTE_START)) {
		const text = data.endsWith(BRACKETED_PASTE_END)
			? data.slice(
					BRACKETED_PASTE_START.length,
					data.length - BRACKETED_PASTE_END.length,
				)
			: data.slice(BRACKETED_PASTE_START.length);
		if (state.noteEditing) return { kind: "note_edit", data: text };
		if (state.editing) return { kind: "input_edit", data: text };
		return { kind: "ignore" };
	}

	if (state.noteEditing) {
		if (kb.matches(data, "tui.input.newLine")) {
			return { kind: "note_edit", data: "\n" };
		}
		if (isConfirm(kb, data)) return { kind: "note_close" };
		if (kb.matches(data, CLEAR_ID)) return { kind: "note_edit", data: "\x15" };
		if (kb.matches(data, EXTERNAL_ID))
			return { kind: "external", target: "note" };
		if (kb.matches(data, BACKSPACE_ID))
			return { kind: "note_edit", data: "\x7f" };
		if (
			kb.matches(data, DELETE_WORD_BACKWARD_ID) ||
			data === "\x17" ||
			data === "\x1b\x7f"
		)
			return { kind: "note_edit", data: "\x17" };
		if (kb.matches(data, "tui.editor.cursorLeft"))
			return { kind: "cursor_left" };
		if (kb.matches(data, "tui.editor.cursorRight"))
			return { kind: "cursor_right" };
		if (kb.matches(data, "tui.select.cancel")) return { kind: "cancel" };
		return { kind: "note_edit", data };
	}

	if (state.editing) {
		// Newline wins over confirm (rpiv rule): insert even on a shared key.
		if (kb.matches(data, "tui.input.newLine")) {
			return { kind: "input_edit", data: "\n" };
		}
		if (isConfirm(kb, data)) return { kind: "confirm" };
		if (kb.matches(data, CLEAR_ID)) return { kind: "input_edit", data: "\x15" };
		if (kb.matches(data, EXTERNAL_ID))
			return { kind: "external", target: "custom" };
		if (kb.matches(data, BACKSPACE_ID))
			return { kind: "input_edit", data: "\x7f" };
		if (
			kb.matches(data, DELETE_WORD_BACKWARD_ID) ||
			data === "\x17" ||
			data === "\x1b\x7f"
		)
			return { kind: "input_edit", data: "\x17" };
		if (kb.matches(data, "tui.editor.cursorLeft"))
			return { kind: "cursor_left" };
		if (kb.matches(data, "tui.editor.cursorRight"))
			return { kind: "cursor_right" };
		if (kb.matches(data, "tui.select.cancel")) return { kind: "cancel" };
		// Nav exits the editor; the draft is preserved for when they return.
		if (kb.matches(data, "tui.select.up")) return { kind: "nav_up" };
		if (kb.matches(data, "tui.select.down")) return { kind: "nav_down" };
		return { kind: "input_edit", data };
	}

	// Browse mode.
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
		return { kind: "tab_next" };
	}
	if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
		return { kind: "tab_prev" };
	}
	// Aux tabs (Checkpoint/Grounding/Review) are read-only: tab cycling and
	// cancel work there; up/down scroll the overflowed content.
	if (state.tab !== 0) {
		if (kb.matches(data, "tui.select.cancel")) return { kind: "cancel" };
		if (kb.matches(data, "tui.select.up")) return { kind: "scroll_up" };
		if (kb.matches(data, "tui.select.down")) return { kind: "scroll_down" };
		return { kind: "ignore" };
	}
	if (isConfirm(kb, data)) {
		return state.selected === env.options.length
			? { kind: "edit_custom" }
			: { kind: "confirm" };
	}
	if (kb.matches(data, "tui.select.up")) return { kind: "nav_up" };
	if (kb.matches(data, "tui.select.down")) return { kind: "nav_down" };
	if (data === "n") return { kind: "note_open" };
	if (data === "x") return { kind: "expand_toggle" };
	if (kb.matches(data, "tui.select.cancel")) return { kind: "cancel" };
	return { kind: "ignore" };
}

// ponytail: collapseKey rides on the router, not a keybinding id — settings.ts
// owns it (step 6); matchesKey handles the raw key directly.
