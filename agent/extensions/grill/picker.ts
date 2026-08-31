import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
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
// Preview renders inline under the focus line; switch to a side-by-side pane only
// if the inline block feels cramped.
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
					const lines = rendered.slice(0, PREVIEW_MAX_LINES);
					if (rendered.length > PREVIEW_MAX_LINES) {
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
						lines.push(
							truncateToWidth(
								theme.fg(
									"dim",
									`${t.navigate} • ${t.select} • ${t.note} • ${t.cancel}`,
								),
								width,
								"",
							),
						);

						for (let i = 0; i < options.length; i++) {
							const option = options[i];
							const focused = i === selected;
							const cursor = focused ? theme.fg("accent", "›") : " ";
							const prefix = `${cursor} ${i + 1}. `;
							const labelText = truncateToWidth(
								option.label,
								Math.max(10, width - 8),
								"",
							);
							lines.push(
								truncateToWidth(
									`${prefix}${focused ? theme.bold(labelText) : labelText}`,
									width,
									"",
								),
							);
						}

						// "Type something." sentinel row.
						const customFocus = selected === options.length;
						lines.push(
							truncateToWidth(
								`${customFocus ? theme.fg("accent", "›") : " "} ${customFocus ? theme.bold(t.typeSomething) : t.typeSomething}`,
								width,
								"",
							),
						);

						const focusedOption = options[selected];
						if (focusedOption?.description) {
							lines.push(
								truncateToWidth(
									theme.fg("dim", `Details: ${focusedOption.description}`),
									width,
									"",
								),
							);
						}

						if (note) {
							lines.push(
								truncateToWidth(
									theme.fg("success", `${t.noteHeader}: ${note}`),
									width,
									"",
								),
							);
						}

						// Inline markdown preview for the focused option.
						if (focusedOption?.preview) {
							lines.push(
								truncateToWidth(theme.fg("accent", `── ${t.preview} ──`), width, ""),
							);
							for (const pline of previewLines(focusedOption.preview, width)) {
								lines.push(truncateToWidth(pline, width, ""));
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
