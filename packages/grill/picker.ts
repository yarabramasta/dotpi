import type {
	ExtensionContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isKeyRepeat,
	Markdown,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { renderInlineInputRow } from "./inline-input.js";
import { decideLayout, leftColumnWidth, PREVIEW_PAD_LEFT } from "./layout.js";
import {
	initialPickerState,
	type PickerEnv,
	type PickerOption,
	type PickerResult,
	type PickerState,
	reducePicker,
	routePickerKey,
} from "./picker-state.js";
import { applyScroll } from "./scroll.js";
import { readCollapseKey } from "./settings.js";
import { renderTabContent, renderTabStrip } from "./tabs.js";

export type { PickerOption, PickerResult } from "./picker-state.js";

// English-only since the locales.ts cut; the rpiv-style picker stays custom TUI.
const EN_STRINGS = {
	navigate: "↑/↓ to navigate",
	select: "Enter to select",
	typeSomething: "Type something.",
	note: "n to add note",
	cancel: "Esc to cancel",
	preview: "Preview",
	expand: "x to expand",
	collapse: "x to collapse",
	noteHeader: "Note",
	customEditorTitle: "Type your answer",
	noteEditorTitle: "Add a note",
};

const PREVIEW_MAX_LINES = 6;

const ACTIVE_POINTER = "❯ ";
const INACTIVE_POINTER = "  ";
const CONTINUATION_INDENT = "  ";

function wrapPlain(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		if (para.length === 0) {
			out.push("");
			continue;
		}
		let line = "";
		for (const word of para.split(/\s+/)) {
			const candidate = line ? `${line} ${word}` : word;
			if (candidate.length > width && line) {
				out.push(line);
				line = word;
			} else {
				line = candidate;
			}
		}
		out.push(line);
	}
	return out;
}

interface PickerOutcome {
	kind: "result" | "external";
	result?: PickerResult;
	target?: "custom" | "note";
}

// ponytail: single blocking picker. State lives in a pure reducer
// (picker-state.ts); this file only renders it and executes effects — editor
// ejections happen ONLY on explicit Ctrl+G (invariant: everything else edits
// in place). Overflow scrolling and the side-by-side/stacked preview split
// come from scroll.ts / layout.ts (lifted from rpiv, grill-tuned constants).
// Collapse mode (step 6): overlay hidden via OverlayHandle + raw
// ctx.ui.onTerminalInput capture re-opens it (pattern: rpiv questionnaire
// session); without raw capture the collapsed state falls back to one dim row.
export async function showPicker(
	ctx: ExtensionContext,
	question: string,
	options: PickerOption[],
): Promise<PickerResult> {
	if (!ctx.hasUI) {
		return { status: "cancelled", value: "", label: "", custom: false };
	}

	// Terminal attention, same idea as rpiv's overlay bell.
	try {
		if (process.stdout.isTTY) process.stdout.write("\x07");
	} catch {
		// best effort; the overlay must still open.
	}

	const env: PickerEnv = { options };
	let state: PickerState = initialPickerState();
	const cancelled: PickerResult = {
		status: "cancelled",
		value: "",
		label: "",
		custom: false,
	};

	// --- Collapse-mode wiring (raw capture is the only reopen path while the
	// overlay is hidden; pi-tui does not route input to hidden overlays). ---
	const collapseKey = readCollapseKey(ctx);
	const canReopenWhileHidden =
		collapseKey !== "off" && typeof ctx.ui.onTerminalInput === "function";
	let overlayHandle: OverlayHandle | undefined;
	let tuiRef: TUI | undefined;
	let hasAnnouncedHide = false;
	const notifyHide = () => {
		if (hasAnnouncedHide) return;
		hasAnnouncedHide = true;
		ctx.ui.notify?.(
			`grill picker hidden — press ${collapseKey} to reopen`,
			"info",
		);
	};
	const removeCollapseListener = canReopenWhileHidden
		? ctx.ui.onTerminalInput((data) => {
				const handle = overlayHandle;
				if (!handle) return undefined;
				// Other overlays on top (e.g. /btw) keep their keystrokes.
				if (!handle.isHidden() && !handle.isFocused()) return undefined;
				if (
					!matchesKey(data, collapseKey as Parameters<typeof matchesKey>[1])
				) {
					return undefined;
				}
				// Kitty-protocol press/repeat/release: toggle on the initial press.
				if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };
				state = { ...state, collapsed: !state.collapsed };
				handle.setHidden(state.collapsed);
				if (state.collapsed) notifyHide();
				tuiRef?.requestRender();
				return { consume: true };
			})
		: undefined;

	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const outcome = await ctx.ui.custom<PickerOutcome | undefined>(
				(tui: TUI, theme: Theme, keybindings: KeybindingsManager, done) => {
					tuiRef = tui;
					const t = EN_STRINGS;
					const border = new DynamicBorder((s: string) =>
						theme.fg("accent", s),
					);
					let previewCache:
						| {
								source: string;
								width: number;
								expanded: boolean;
								lines: string[];
						  }
						| undefined;

					function previewLines(
						source: string | undefined,
						width: number,
					): string[] {
						if (!source) return [];
						if (
							previewCache &&
							previewCache.source === source &&
							previewCache.width === width &&
							previewCache.expanded === state.expanded
						) {
							return previewCache.lines;
						}
						const md = new Markdown(source, 0, 0, getMarkdownTheme());
						const rendered = md.render(Math.max(1, width - 3));
						md.invalidate();
						const lines = state.expanded
							? rendered
							: rendered.slice(0, PREVIEW_MAX_LINES);
						if (!state.expanded && rendered.length > PREVIEW_MAX_LINES) {
							lines.push(
								theme.fg(
									"dim",
									`… ${rendered.length - PREVIEW_MAX_LINES} more lines`,
								),
							);
						}
						previewCache = {
							source,
							width,
							expanded: state.expanded,
							lines,
						};
						return lines;
					}

					return {
						render(width: number) {
							if (state.collapsed) {
								// One dim row, visible or as post-hide fallback.
								return [
									theme.fg(
										"dim",
										` 🔥 grill picker hidden — press ${collapseKey} to reopen `,
									),
								];
							}
							const lines: string[] = [];
							lines.push(...border.render(width));

							// Sticky heading: top border + question + strip + hint.
							let qCount = 0;
							for (const qline of wrapPlain(question, width - 2)) {
								lines.push(truncateToWidth(theme.bold(qline), width, ""));
								qCount++;
							}
							// Tab strip sits between question and hint; active tab accent.
							lines.push(
								truncateToWidth(
									renderTabStrip(state.tab, width, (c: string, s: string) =>
										theme.fg(c as never, s),
									),
									width,
									"",
								),
							);
							const hasPreview = options.some((o) => o.preview);
							let expandHint = "";
							if (hasPreview)
								expandHint = state.expanded
									? ` • ${t.collapse}`
									: ` • ${t.expand}`;
							lines.push(
								truncateToWidth(
									theme.fg(
										"dim",
										`${t.navigate} • ${t.select} • ${t.note}${expandHint} • ${t.cancel}`,
									),
									width,
									"",
								),
							);
							// Sticky heading = top border + question lines + strip + hint.
							const topFixed = 3 + qCount;

							const finish = (
								focusedRange: [number, number] | undefined,
								scrollStart?: number,
							): string[] => {
								lines.push(...border.render(width));
								return applyScroll(lines, {
									topFixed,
									bottomFixed: 1,
									focusedRange,
									termRows: tui.terminal.rows,
									dim: (s) => theme.fg("dim", s),
									scrollStart,
								});
							};

							// Aux tabs: read-only markdown content, scrollable with ↑/↓.
							if (state.tab !== 0) {
								lines.push(...renderTabContent(state.tab, width));
								return finish(undefined, state.scroll);
							}

							const numberWidth = String(options.length + 1).length;
							const prefixWidth = ACTIVE_POINTER.length + numberWidth + 2; // pointer + digits + ". "
							const sideBySide =
								decideLayout(width, width) === "side-by-side" && hasPreview;

							// Choices are the decision; preview is auxiliary. Left column
							// width comes from layout.ts (grill-tuned ratio/floors).
							const leftWidth = sideBySide
								? leftColumnWidth(width, state.expanded)
								: width;
							const contentWidth = Math.max(1, leftWidth - prefixWidth);

							// Option rows, rpiv style: pointer + number + label, wrapped
							// description indented 2 below each row (visible for every
							// option, not just the focused one). rowStart tracks each row's
							// first line inside the middle content so overflow scroll can
							// center focus.
							const leftLines: string[] = [];
							const rowStart: number[] = [];
							for (let i = 0; i < options.length; i++) {
								rowStart[i] = leftLines.length;
								const option = options[i];
								const focused = i === state.selected && !state.editing;
								const pointer = focused
									? theme.fg("accent", ACTIVE_POINTER)
									: INACTIVE_POINTER;
								const number = String(i + 1).padStart(numberWidth, " ");
								const label = truncateToWidth(option.label, contentWidth, "…");
								const styled = focused
									? theme.fg("accent", theme.bold(label))
									: label;
								leftLines.push(
									truncateToWidth(`${pointer}${number}. ${styled}`, width, ""),
								);
								if (option.description) {
									for (const seg of wrapPlain(
										option.description,
										contentWidth,
									)) {
										leftLines.push(
											truncateToWidth(
												CONTINUATION_INDENT + theme.fg("muted", seg),
												width,
												"",
											),
										);
									}
								}
							}

							// "Type something." sentinel row / inline custom-answer editor.
							rowStart[options.length] = leftLines.length;
							const customFocus =
								state.selected === options.length && !state.editing;
							const cPointer = customFocus
								? theme.fg("accent", ACTIVE_POINTER)
								: state.editing
									? theme.fg("accent", ACTIVE_POINTER)
									: INACTIVE_POINTER;
							const sentinelPrefix = `${cPointer}${String(options.length + 1).padStart(numberWidth, " ")}. `;
							if (state.editing) {
								// Inline draft editor: cursor-marked, wrapped, accent-styled.
								for (const row of renderInlineInputRow({
									buffer: state.draft,
									cursorOffset: state.cursor,
									rowPrefix: sentinelPrefix,
									continuationPrefix: " ".repeat(visibleWidth(sentinelPrefix)),
									contentWidth: Math.max(
										1,
										width - visibleWidth(sentinelPrefix),
									),
									selectedText: (text) => theme.fg("accent", theme.bold(text)),
								})) {
									leftLines.push(truncateToWidth(row, width, ""));
								}
							} else {
								const cLabel = customFocus
									? theme.fg("accent", theme.bold(t.typeSomething))
									: t.typeSomething;
								leftLines.push(
									truncateToWidth(`${sentinelPrefix}${cLabel}`, width, ""),
								);
							}

							const focusedOption = options[state.selected];

							// Committed note line, or the inline note editor in its place.
							if (state.noteEditing) {
								const notePrefix = `${theme.fg("success", `${t.noteHeader}: `)}`;
								for (const row of renderInlineInputRow({
									buffer: state.noteDraft,
									cursorOffset: state.noteCursor,
									rowPrefix: notePrefix,
									continuationPrefix: " ".repeat(6),
									contentWidth: Math.max(1, width - 6),
									selectedText: (text) => theme.fg("success", text),
								})) {
									leftLines.push(truncateToWidth(row, width, ""));
								}
							} else if (state.note) {
								leftLines.push(
									truncateToWidth(
										theme.fg("success", `${t.noteHeader}: ${state.note}`),
										width,
										"",
									),
								);
							}

							// Middle content + focused range (middle-relative rows).
							let focusedRange: [number, number] | undefined;
							if (sideBySide) {
								const rightWidth = Math.max(
									1,
									width - leftWidth - 2 - PREVIEW_PAD_LEFT,
								);

								const rightLines = focusedOption?.preview
									? previewLines(focusedOption.preview, rightWidth).map((pl) =>
											truncateToWidth(
												" ".repeat(PREVIEW_PAD_LEFT) + pl,
												width,
												"",
											),
										)
									: [];
								const rows = Math.max(leftLines.length, rightLines.length);
								for (let r = 0; r < rows; r++) {
									const leftRaw = leftLines[r] ?? "";
									const rightRaw = rightLines[r] ?? "";
									const leftClamped = truncateToWidth(leftRaw, leftWidth, "");
									const leftPad = " ".repeat(
										Math.max(0, leftWidth - visibleWidth(leftClamped)),
									);
									const gap = rightRaw ? " ".repeat(2) : "";
									lines.push(
										truncateToWidth(
											`${leftClamped}${leftPad}${gap}${rightRaw}`,
											width,
											"",
										),
									);
								}
								const focusStart = rowStart[state.selected];
								if (focusStart !== undefined) {
									const end = rowStart[state.selected + 1] ?? leftLines.length;
									focusedRange = [focusStart, Math.max(focusStart + 1, end)];
								}
							} else {
								lines.push(...leftLines);

								// Inline markdown preview for the focused option (narrow).
								if (focusedOption?.preview) {
									lines.push(
										truncateToWidth(
											theme.fg("accent", `── ${t.preview} ──`),
											width,
											"",
										),
									);
									const block = previewLines(focusedOption.preview, width);
									for (const pline of block) {
										lines.push(truncateToWidth(pline, width, ""));
									}
									if (state.selected < options.length) {
										const focusStart = rowStart[state.selected];
										const end =
											(rowStart[state.selected + 1] ?? leftLines.length) +
											block.length +
											1; // +1: preview header row belongs to the focused block
										focusedRange = [focusStart, Math.max(focusStart + 1, end)];
									}
								}
							}
							if (
								focusedRange === undefined &&
								rowStart[state.selected] !== undefined
							) {
								const focusStart = rowStart[state.selected];
								const end = rowStart[state.selected + 1] ?? leftLines.length;
								focusedRange = [focusStart, Math.max(focusStart + 1, end)];
							}

							// Sticky footer + overflow scroll (sticky heading/footer,
							// middle window centered on the focused row; no-op when it fits).
							return finish(focusedRange);
						},
						invalidate() {
							border.invalidate();
							previewCache = undefined;
						},
						handleInput(data: string) {
							const action = routePickerKey(
								data,
								state,
								env,
								keybindings,
								collapseKey,
							);
							if (action.kind === "ignore") return;
							const prevCollapsed = state.collapsed;
							const { state: next, effects } = reducePicker(state, action, env);
							state = next;
							// In-band collapse (fallback mode or unfocused overlay):
							// mirror the raw-listener behavior on the overlay handle.
							if (
								state.collapsed !== prevCollapsed &&
								canReopenWhileHidden &&
								overlayHandle
							) {
								overlayHandle.setHidden(state.collapsed);
								if (state.collapsed) notifyHide();
							}
							const doneEffect = effects.find((e) => e.kind === "done");
							if (doneEffect && doneEffect.kind === "done") {
								done({ kind: "result", result: doneEffect.result });
								return;
							}
							const extEffect = effects.find(
								(e) => e.kind === "open_external_editor",
							);
							if (extEffect && extEffect.kind === "open_external_editor") {
								done({ kind: "external", target: extEffect.target });
								return;
							}
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						maxHeight: "100%",
						margin: { left: 0, right: 0, bottom: 0 },
					},
					onHandle: (handle) => {
						overlayHandle = handle;
					},
				},
			);

			if (outcome == null) {
				return { ...cancelled, note: state.note };
			}

			if (outcome.kind === "result") {
				return outcome.result ?? cancelled;
			}

			// Explicit Ctrl+G ejection (the only editor modal in a round).
			if (outcome.target === "custom") {
				const edited = await ctx.ui.editor(
					EN_STRINGS.customEditorTitle,
					state.draft,
				);
				if (edited?.trim()) {
					return {
						status: "answered",
						value: edited.trim(),
						label: edited.trim(),
						custom: true,
						note: state.note,
					};
				}
				// Cancelled or emptied: empty draft drops, keep browsing.
				if (edited !== undefined) {
					state = { ...state, editing: false, draft: "", cursor: 0 };
				} else {
					state = { ...state, editing: false };
				}
				continue;
			}

			{
				const edited = await ctx.ui.editor(
					EN_STRINGS.noteEditorTitle,
					state.noteDraft,
				);
				if (edited !== undefined) {
					const trimmed = edited.trim();
					state = {
						...state,
						noteEditing: false,
						noteDraft: edited,
						noteCursor: edited.length,
						note: trimmed || undefined,
					};
				} else {
					state = { ...state, noteEditing: false };
				}
			}
		}
	} finally {
		removeCollapseListener?.();
	}
}
