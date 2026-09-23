export type IsolationBackend = "worktrees" | "gitbutler" | "slices";

export interface ResolvedIsolation {
	backend: IsolationBackend;
	reason: string;
}

export type IsolationSetting = IsolationBackend | "auto";

export function resolveIsolation(opts: {
	setting: IsolationSetting;
	isGitbutlerMode: boolean;
	butBinary: boolean;
	isCleanTree: boolean;
	subagentsOn: boolean;
}): ResolvedIsolation {
	const { setting, isGitbutlerMode, butBinary, isCleanTree, subagentsOn } =
		opts;

	if (!subagentsOn) {
		return { backend: "slices", reason: "subagents off" };
	}

	if (setting === "worktrees") {
		if (isGitbutlerMode) {
			return {
				backend: "slices",
				reason: "worktrees refused: gitbutler-managed repo",
			};
		}
		if (isCleanTree) {
			return { backend: "worktrees", reason: "clean tree, plain git repo" };
		}
		return {
			backend: "slices",
			reason: "dirty tree — worktrees need a clean checkout",
		};
	}

	if (setting === "gitbutler") {
		if (isGitbutlerMode && butBinary) {
			return {
				backend: "gitbutler",
				reason: "gitbutler-mode repo, but binary present",
			};
		}
		return {
			backend: "slices",
			reason: isGitbutlerMode
				? "but binary not found"
				: "not a gitbutler-mode repo",
		};
	}

	if (setting === "slices") {
		return { backend: "slices", reason: "isolation setting: slices" };
	}

	// "auto"
	if (isGitbutlerMode) {
		return butBinary
			? { backend: "gitbutler", reason: "gitbutler-mode repo (auto)" }
			: {
					backend: "slices",
					reason: "gitbutler repo but no but binary (auto)",
				};
	}
	if (isCleanTree) {
		return { backend: "worktrees", reason: "clean plain-git tree (auto)" };
	}
	return { backend: "slices", reason: "dirty tree (auto)" };
}

export function isolationPickerText(r: ResolvedIsolation): string {
	return `isolation: ${r.backend} (${r.reason})`;
}

export function isolationBadge(r: ResolvedIsolation | undefined): string {
	return r?.backend ?? "";
}

const TOKEN_RE = /[^a-z0-9-]+/g;
const LEADING_HYPHEN_RE = /^-+/;
const TRAILING_HYPHEN_RE = /-+$/;
const DUP_HYPHEN_RE = /-+/g;

function sanitizeToken(token: string): string {
	return token
		.toLowerCase()
		.replace(TOKEN_RE, "-")
		.replace(LEADING_HYPHEN_RE, "")
		.replace(TRAILING_HYPHEN_RE, "")
		.replace(DUP_HYPHEN_RE, "-");
}

export function isolationBranchName(
	type: string,
	scope: string | undefined,
	existing: string[],
): string {
	let name = `grill/${sanitizeToken(type)}`;
	if (scope !== undefined && scope.length > 0) {
		name = `${name}-${sanitizeToken(scope)}`;
	}

	let candidate = name;
	let suffix = 2;
	while (existing.includes(candidate)) {
		candidate = `${name}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}
