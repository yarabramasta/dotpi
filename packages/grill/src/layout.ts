// Layout decider lifted from rpiv-ask-user-question's preview-layout-decider.ts,
// keeping Grill Me's tuned constants (see UI-REDESIGN.md step 4): the choices
// column gets the larger share (0.6 vs rpiv's 0.5) and a smaller preview floor
// (40 vs 45) so options+descriptions never get squeezed by the preview pane.

/** Min terminal/pane width for the side-by-side layout to engage. */
export const SIDE_BY_SIDE_MIN_WIDTH = 100;
/** Visual gap between options column and preview column in side-by-side. */
export const COLUMN_GAP = 2;
/** 1 col padding before the preview column content. */
export const PREVIEW_PAD_LEFT = 1;
/** Floor for the left column width — prevents collapse on short labels. */
export const MIN_LEFT = 30;
/** Ceiling ratio: left column never exceeds this fraction of pane width. */
export const MAX_LEFT_RATIO = 0.6;
/** Floor for the preview column width. */
export const MIN_PREVIEW_WIDTH = 40;

export type PreviewLayoutMode = "side-by-side" | "stacked";

/** Decide layout mode from terminal + pane widths. Pure. */
export function decideLayout(
	terminalWidth: number,
	paneWidth: number,
): PreviewLayoutMode {
	return terminalWidth >= SIDE_BY_SIDE_MIN_WIDTH &&
		paneWidth >= SIDE_BY_SIDE_MIN_WIDTH
		? "side-by-side"
		: "stacked";
}

/** Left column width in side-by-side mode. `expanded` (x) shrinks the left
 * column so the preview gets ~65%. Pure; replaces the inline ratio math that
 * lived in picker.ts render(). */
export function leftColumnWidth(width: number, expanded: boolean): number {
	const leftRatio = expanded ? 0.35 : MAX_LEFT_RATIO;
	const ratioWidth = Math.floor(width * leftRatio);
	const available = width - COLUMN_GAP - MIN_PREVIEW_WIDTH;
	return Math.max(MIN_LEFT, Math.min(ratioWidth, Math.max(1, available)));
}
