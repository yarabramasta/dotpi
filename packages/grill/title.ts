/** Session-title fix: when a grill session starts and the current chat session
 * title still reads as a generic grill prompt, rewrite it from the topic so
 * resume lists are distinguishable. Never touches a user-set custom title. */

const GENERIC_TITLE_PATTERNS: RegExp[] = [
	/^\/?grill(\s|$)/i,
	/grill me session/i,
	/^grill me\b/i,
	/socratic grill/i,
	/^socratic(\s|$)/i,
];

/** True when the current title is unset or still a generic grill prompt. */
export function shouldRewriteTitle(current: string | undefined): boolean {
	const trimmed = current?.trim();
	if (!trimmed) return true;
	return GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Pure topic → title mapping: "grill: " prefix, ~40 chars, word-boundary cut. */
export function titleFromTopic(topic: string): string {
	const collapsed = topic.replace(/\s+/g, " ").trim();
	if (!collapsed) return "grill: untitled";
	const MAX = 40;
	if (collapsed.length <= MAX) return `grill: ${collapsed}`;
	const cut = collapsed.slice(0, MAX);
	const boundary = cut.lastIndexOf(" ");
	return `grill: ${(boundary > 20 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}
