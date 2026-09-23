export interface WriterSlice {
	paths: string[];
}

/**
 * Split a list of paths into at most `maxWriters` balanced slices. Every path
 * appears in exactly one slice; duplicate inputs are deduplicated. Empty input
 * produces no slices.
 *
 * `maxWriters <= 0` is treated as `1` so there is always a valid fan-out.
 */
export function sliceApprovedPaths(
	paths: string[],
	maxWriters = 3,
): WriterSlice[] {
	const unique = [...new Set(paths)];
	if (unique.length === 0) return [];

	const writers = Math.max(1, maxWriters);
	const buckets = Math.min(writers, unique.length);
	const base = Math.floor(unique.length / buckets);
	const extra = unique.length % buckets;

	const slices: WriterSlice[] = [];
	let index = 0;
	for (let i = 0; i < buckets; i++) {
		const size = base + (i < extra ? 1 : 0);
		slices.push({ paths: unique.slice(index, index + size) });
		index += size;
	}
	return slices;
}

/**
 * Extract repo-path-looking tokens from an approved plan text.
 *
 * ponytail: mirrors state.ts `approvedOutputPaths` regex; keep in sync.
 */
export function parsePlanPaths(plan: string | undefined): string[] {
	if (!plan) return [];
	const paths = new Set<string>();
	const lines = plan.split(/\r?\n/);
	for (const line of lines) {
		const stripped = line.trim();
		if (!stripped || stripped.startsWith("#")) continue;
		const tokens =
			stripped.match(
				/(?<![\w/])([A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+|[A-Za-z0-9._-]+\.(?:ts|js|json|md|py|go|rs|sh|ya?ml|txt|tsx|jsx))/g,
			) ?? [];
		for (const token of tokens) {
			if (
				token.length >= 3 &&
				!/^https?:\/\//.test(token) &&
				!/^ssh:/.test(token)
			) {
				paths.add(token);
			}
		}
	}
	return [...paths];
}
