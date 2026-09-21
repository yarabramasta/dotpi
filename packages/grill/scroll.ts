// Scroll window helpers lifted from rpiv-ask-user-question view/dialog-builder.ts.
// Pure: all styling arrives as a callback so tests need no Theme.

const OVERFLOW_UP = "↑";
const OVERFLOW_DOWN = "↓";
const OVERFLOW_BOTH = "↕";

export type Dim = (text: string) => string;

/** No-overflow path: append the residual spacer rows after the footer. */
export function renderFitsTerminal(
	natural: string[],
	spacerRows: number,
): string[] {
	return spacerRows > 0
		? [...natural, ...Array<string>(spacerRows).fill("")]
		: natural;
}

/** Terminal too small for any middle content — show just chrome, hard-clamped. */
export function renderChromeOnly(
	natural: string[],
	topFixed: number,
	bottomFixed: number,
	termRows: number,
): string[] {
	const chromeOnly = [
		...natural.slice(0, topFixed),
		...natural.slice(natural.length - bottomFixed),
	];
	return chromeOnly.length > termRows
		? chromeOnly.slice(0, termRows)
		: chromeOnly;
}

/** Scroll window start, centered on the focused option; top-anchored when
 * there is no interactive focus. */
export function computeScrollStart(
	bodyRange: [number, number] | undefined,
	headingCount: number,
	availableMiddle: number,
	middleRows: number,
): number {
	if (!bodyRange) return 0;
	const focusedRowInMiddle = headingCount + bodyRange[0];
	const focusedHeight = bodyRange[1] - bodyRange[0];
	// Center the focused item vertically in the available middle space.
	const idealStart =
		focusedRowInMiddle -
		Math.floor(Math.max(0, availableMiddle - focusedHeight) / 2);
	return Math.max(0, Math.min(idealStart, middleRows - availableMiddle));
}

/** Mark the scroll window edges with overflow arrows; combined ↕ on a
 * single-row middle. */
export function decorateOverflow(
	scrollableMiddle: string[],
	hasUp: boolean,
	hasDown: boolean,
	dim: Dim,
): void {
	if (hasUp && hasDown && scrollableMiddle.length === 1) {
		// Single-row middle: combined ↕ avoids the prior collision where ↓ overwrote ↑.
		scrollableMiddle[0] = dim(OVERFLOW_BOTH);
		return;
	}
	if (hasUp && scrollableMiddle.length > 0) {
		scrollableMiddle[0] = dim(OVERFLOW_UP);
	}
	if (hasDown && scrollableMiddle.length > 0) {
		scrollableMiddle[scrollableMiddle.length - 1] = dim(OVERFLOW_DOWN);
	}
}

/** 3-region scroll partition over an already-rendered `natural` line array:
 * sticky heading (topFixed), scrollable middle centered on the focused rows,
 * sticky footer (bottomFixed). Returns natural unchanged when it fits. */
export function applyScroll(
	natural: string[],
	opts: {
		topFixed: number;
		bottomFixed: number;
		focusedRange: [number, number] | undefined;
		termRows: number;
		dim: Dim;
		/** Explicit top offset for non-interactive views (aux tabs). */
		scrollStart?: number;
	},
): string[] {
	const { topFixed, bottomFixed, focusedRange, termRows, dim } = opts;
	if (natural.length <= termRows) return natural;

	const middleRows = natural.length - topFixed - bottomFixed;
	const availableMiddle = Math.max(0, termRows - topFixed - bottomFixed);
	if (availableMiddle === 0) {
		return renderChromeOnly(natural, topFixed, bottomFixed, termRows);
	}

	// Read-only views (aux tabs) pass an explicit scroll offset; interactive
	// views get focus-centered scrolling as before. Both clamped to range.
	const maxStart = Math.max(0, middleRows - availableMiddle);
	const scrollStart =
		opts.scrollStart !== undefined
			? Math.max(0, Math.min(opts.scrollStart, maxStart))
			: computeScrollStart(focusedRange, 0, availableMiddle, middleRows);
	const scrollableMiddle = natural.slice(
		topFixed + scrollStart,
		topFixed + scrollStart + availableMiddle,
	);
	decorateOverflow(
		scrollableMiddle,
		scrollStart > 0,
		scrollStart + availableMiddle < middleRows,
		dim,
	);

	const result = [
		...natural.slice(0, topFixed),
		...scrollableMiddle,
		...natural.slice(natural.length - bottomFixed),
	];
	// Safety: never exceed terminal rows (covers topFixed + bottomFixed > termRows).
	return result.length > termRows ? result.slice(0, termRows) : result;
}
