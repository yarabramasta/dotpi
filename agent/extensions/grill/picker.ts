import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { strings, type Language } from "./locales.js";

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

type Instruction =
	| { kind: "pick"; index: number }
	| { kind: "custom" }
	| { kind: "note" }
	| { kind: "cancel" };

const PREVIEW_MAX_LINES = 6;

// Layout constants. Started from rpiv-ask-user-question's values, then tuned for
// Grill Me: choices column gets the larger share (MAX_LEFT_RATIO 0.6) and a
// smaller preview floor (40) so options+descriptions never get squeezed by the
// preview pane.
const SIDE_BY_SIDE_MIN_WIDTH = 100;
const COLUMN_GAP = 2;
const PREVIEW_PAD_LEFT = 1;
const MIN_LEFT = 30;
const MAX_LEFT_RATIO = 0.6;
const MIN_PREVIEW_WIDTH = 40;
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

// ponytail: single blocking picker. Reimplements rpiv's ↑/↓+Enter interaction on
// shared pi-tui primitives instead of vendoring rpiv's ~80KB layered state machine.
// Options render like rpiv-ask-user-question rows (pointer + number + label, wrapped
// description indented 2); preview goes side-by-side in a right pane when any option
// has one and the terminal is wide enough, else stacked inline.
export async function showPicker(
	ctx: ExtensionContext,
	question: string,
	options: PickerOption[],
	lang: Language,
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

	let note: string | undefined;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const instruction = await ctx.ui.custom<Instruction | undefined>(
			(tui: TUI, theme: Theme, _keybindings, done) => {
				const t = strings(lang);
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				let selected = 0;
				// ponytail: preview expand toggle. x drops the line cap so the
				// full preview shows; also widens the preview column.
				let expanded = false;
				let previewCache:
					| { source: string; width: number; lines: string[] }
					| undefined;

				function previewLines(source: string | undefined, width: number): string[] {
					if (!source) return [];
					if (
						previewCache &&
						previewCache.source === source &&
						previewCache.width === width
					) {
						return previewCache.lines;
					}
					const md = new Markdown(source, 0, 0, getMarkdownTheme());
					const rendered = md.render(Math.max(1, width - 3));
					md.invalidate();
					const lines = expanded ? rendered : rendered.slice(0, PREVIEW_MAX_LINES);
					if (!expanded && rendered.length > PREVIEW_MAX_LINES) {
						lines.push(
							theme.fg("dim", `… ${rendered.length - PREVIEW_MAX_LINES} more lines`),
						);
					}
					previewCache = { source, width, lines };
					return lines;
				}

				return {
					render(width: number) {
						const lines: string[] = [];
						lines.push(...border.render(width));
						for (const qline of wrapPlain(question, width - 2)) {
							lines.push(truncateToWidth(theme.bold(qline), width, ""));
						}
						const hasPreview = options.some((o) => o.preview);
						let expandHint = "";
						if (hasPreview)
							expandHint = expanded ? ` • ${t.collapse}` : ` • ${t.expand}`;
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

						const numberWidth = String(options.length + 1).length;
						const prefixWidth = ACTIVE_POINTER.length + numberWidth + 2; // pointer + digits + ". "
						const sideBySide = hasPreview && width >= SIDE_BY_SIDE_MIN_WIDTH;

						// Choices are the decision; preview is auxiliary. Give the left
						// (options + descriptions) column a fixed larger share so long
						// descriptions don't collapse into a narrow wrapped strip.
						// ponytail: fixed ratio instead of a label-width cap; the old cap
						// starved descriptions whenever option labels were short, handing
						// all spare width to the preview pane.
						let leftWidth = width;
						if (sideBySide) {
							// Expanded (x): shrink the left column so the preview gets ~65%.
							const leftRatio = expanded ? 0.35 : MAX_LEFT_RATIO;
							const ratioWidth = Math.floor(width * leftRatio);
							const available = width - COLUMN_GAP - MIN_PREVIEW_WIDTH;
							leftWidth = Math.max(
								MIN_LEFT,
								Math.min(ratioWidth, Math.max(1, available)),
							);
						}
						const contentWidth = Math.max(1, leftWidth - prefixWidth);

						// Option rows, rpiv style: pointer + number + label, wrapped
						// description indented 2 below each row (visible for every option,
						// not just the focused one).
						const leftLines: string[] = [];
						for (let i = 0; i < options.length; i++) {
							const option = options[i];
							const focused = i === selected;
							const pointer = focused
								? theme.fg("accent", ACTIVE_POINTER)
								: INACTIVE_POINTER;
							const number = String(i + 1).padStart(numberWidth, " ");
							const label = truncateToWidth(option.label, contentWidth, "…");
							const styled = focused ? theme.fg("accent", theme.bold(label)) : label;
							leftLines.push(
								truncateToWidth(`${pointer}${number}. ${styled}`, width, ""),
							);
							if (option.description) {
								for (const seg of wrapPlain(option.description, contentWidth)) {
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

						// "Type something." sentinel row, same prefix shape.
						const customFocus = selected === options.length;
						const cPointer = customFocus
							? theme.fg("accent", ACTIVE_POINTER)
							: INACTIVE_POINTER;
						const cLabel = customFocus
							? theme.fg("accent", theme.bold(t.typeSomething))
							: t.typeSomething;
						leftLines.push(
							truncateToWidth(
								`${cPointer}${String(options.length + 1).padStart(numberWidth, " ")}. ${cLabel}`,
								width,
								"",
							),
						);

						const focusedOption = options[selected];

						if (note) {
							leftLines.push(
								truncateToWidth(
									theme.fg("success", `${t.noteHeader}: ${note}`),
									width,
									"",
								),
							);
						}

						if (sideBySide) {
							const rightWidth = Math.max(
								1,
								width - leftWidth - COLUMN_GAP - PREVIEW_PAD_LEFT,
							);

							const rightLines = focusedOption?.preview
								? previewLines(focusedOption.preview, rightWidth).map((pl) =>
										truncateToWidth(" ".repeat(PREVIEW_PAD_LEFT) + pl, width, ""),
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
								const gap = rightRaw ? " ".repeat(COLUMN_GAP) : "";
								lines.push(
									truncateToWidth(
										`${leftClamped}${leftPad}${gap}${rightRaw}`,
										width,
										"",
									),
								);
							}
						} else {
							lines.push(...leftLines);

							// Inline markdown preview for the focused option (narrow/no-preview).
							if (focusedOption?.preview) {
								lines.push(
									truncateToWidth(theme.fg("accent", `── ${t.preview} ──`), width, ""),
								);
								for (const pline of previewLines(focusedOption.preview, width)) {
									lines.push(truncateToWidth(pline, width, ""));
								}
							}
						}

						lines.push(...border.render(width));
						return lines;
					},
					invalidate() {
						border.invalidate();
						previewCache = undefined;
					},
					handleInput(data: string) {
						if (matchesKey(data, "up")) {
							selected = Math.max(0, selected - 1);
							tui.requestRender();
						} else if (matchesKey(data, "down")) {
							selected = Math.min(options.length, selected + 1);
							tui.requestRender();
						} else if (matchesKey(data, "enter")) {
							if (selected === options.length) done({ kind: "custom" });
							else done({ kind: "pick", index: selected });
						} else if (matchesKey(data, "n")) {
							done({ kind: "note" });
						} else if (matchesKey(data, "escape")) {
							done({ kind: "cancel" });
						} else if (matchesKey(data, "x")) {
							// Toggle preview expand; drop cache so cap re-applies on collapse.
							expanded = !expanded;
							previewCache = undefined;
							tui.requestRender();
						}
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
			},
		);

		if (instruction == null || instruction.kind === "cancel") {
			return { status: "cancelled", value: "", label: "", custom: false, note };
		}
		if (instruction.kind === "note") {
			const edited = await ctx.ui.editor(
				strings(lang).noteEditorTitle,
				note ?? "",
			);
			if (edited !== undefined) note = edited.trim() || undefined;
			continue;
		}
		if (instruction.kind === "custom") {
			const edited = await ctx.ui.editor(strings(lang).customEditorTitle, "");
			if (edited != null && edited.trim()) {
				const value = edited.trim();
				return { status: "answered", value, label: value, custom: true, note };
			}
			continue;
		}
		const option = options[instruction.index];
		if (!option)
			return { status: "cancelled", value: "", label: "", custom: false, note };
		return {
			status: "answered",
			value: option.value,
			label: option.label,
			custom: false,
			note,
		};
	}
}
