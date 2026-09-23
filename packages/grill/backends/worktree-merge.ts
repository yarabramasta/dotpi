const BRANCH_LINE_RE = /^BRANCH:\s*(\S+)\s*$/;

/** Extract writer-reported branch names from one or more report strings.
 * Preserves first-seen order and removes duplicates. */
export function parseBranchReports(
	texts: readonly string[] | undefined,
): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const text of texts ?? []) {
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			const match = BRANCH_LINE_RE.exec(line);
			if (!match) continue;
			const branch = match[1];
			if (seen.has(branch)) continue;
			seen.add(branch);
			result.push(branch);
		}
	}
	return result;
}

/** Plan sequential merges for the given branch names. */
export function mergePlan(branches: readonly string[]): {
	steps: string[];
	allClear: boolean;
} {
	const unique = new Set(branches);
	return {
		steps: branches.map((b) => `git merge ${b}`),
		allClear: branches.length > 0 && unique.size === branches.length,
	};
}

/** Human-facing instructions when a merge fails. The user must resolve the
 * conflict manually or abort; grill does not resolve silently. */
export function mergeConflictBlock(branch: string): string {
	return [
		`Merge failed for slice branch: ${branch}`,
		"Grill paused. Resolve the conflict before continuing.",
		"",
		"To bail: git merge --abort",
		"To continue: resolve the conflicts, then git commit",
	].join("\n");
}
