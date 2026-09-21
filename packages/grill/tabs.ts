import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth } from "@earendil-works/pi-tui";
import { runtime } from "./state.js";

// Aux read-only tabs (UI-REDESIGN.md step 5): Checkpoint | Grounding | Review.
// Content is sourced from grill session state; nothing here mutates it.
export const TAB_NAMES = [
	"Question",
	"Checkpoint",
	"Grounding",
	"Review",
] as const;

export function renderTabStrip(
	tab: number,
	width: number,
	fg: (color: string, text: string) => string,
): string {
	const strip = TAB_NAMES.map((name, i) =>
		i === tab ? fg("accent", name) : name,
	).join(" | ");
	return truncateToWidth(strip, width, "");
}

/** Raw markdown body for a tab. Empty string = nothing recorded yet. */
export function tabContent(tab: number): string {
	if (tab === 0) return "";
	const state = runtime.state;
	if (tab === 1) return state.checkpoint || "(no checkpoint recorded yet)";
	if (tab === 2) {
		const parts: string[] = [];
		if (state.dossier?.text) parts.push(state.dossier.text);
		if (state.grounding) {
			parts.push(
				state.grounding.skippedReason
					? `⚠ grounding skipped: ${state.grounding.skippedReason}`
					: `✓ grounding: ${state.grounding.summary}`,
			);
		} else {
			parts.push("(no grounding evidence this session)");
		}
		if (state.reviewer) {
			parts.push(
				state.reviewer.skippedReason
					? `⚠ reviewer skipped: ${state.reviewer.skippedReason}`
					: `✓ reviewer: ${state.reviewer.summary}`,
			);
		}
		return parts.join("\n\n");
	}
	// tab 3: Review — decisions ✓ + open questions ?.
	const lines: string[] = [];
	for (const d of state.decisions) {
		lines.push(`✓ ${d.label}${d.note ? ` — ${d.note}` : ""}`);
	}
	if (state.currentQuestion) lines.push(`? ${state.currentQuestion}`);
	if (!lines.length) lines.push("(nothing decided yet)");
	return lines.join("\n");
}

/** Render a tab body as markdown lines, clamped to width. */
export function renderTabContent(tab: number, width: number): string[] {
	const body = tabContent(tab);
	if (!body) return [];
	const md = new Markdown(body, 0, 0, getMarkdownTheme());
	const rendered = md.render(Math.max(1, width - 2));
	md.invalidate();
	return rendered.map((line) => truncateToWidth(line, width, ""));
}
