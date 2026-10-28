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

/** Git refuses refs whose path component exceeds 255 bytes (ENAMETOOLONG);
 *  cap the slug so `grill/<type>-<slug>` always fits. */
const MAX_SLUG_LEN = 48;

function capSlug(slug: string): string {
	if (slug.length <= MAX_SLUG_LEN) return slug;
	return sanitizeToken(slug.slice(0, MAX_SLUG_LEN));
}

export function isolationBranchName(
	type: string,
	scope: string | undefined,
	existing: string[],
): string {
	let name = `grill/${sanitizeToken(type)}`;
	const scopeSlug = scope === undefined ? "" : sanitizeToken(scope);
	// Scope identical to the type reads badly (`docs-docs`); type alone suffices.
	if (scopeSlug.length > 0 && scopeSlug !== sanitizeToken(type)) {
		name = `${name}-${capSlug(scopeSlug)}`;
	}

	let candidate = name;
	let suffix = 2;
	while (existing.includes(candidate)) {
		candidate = `${name}-${suffix}`;
		suffix += 1;
	}
	return candidate;
}

function stem(path: string): string {
	return (path.split("/").pop() ?? "").replace(/\.[^.]*$/, "");
}

/** Basenames that say nothing about what a slice does — subject slug wins
 *  over these. */
const GENERIC_STEMS = new Set([
	"index",
	"main",
	"utils",
	"helpers",
	"types",
	"consts",
	"constants",
	"common",
	"shared",
	"core",
	"base",
	"mod",
]);

export interface SliceBranch {
	type: string;
	scope: string;
	branch: string;
}

/** Per-slice branch names: scope from the slice's own paths when the paths
 *  are informative (deepest shared dir / file stem), else the plan/topic
 *  subject slug (e.g. `index.ts` slices get `fix-token-expiry`, not
 *  `fix-index`). Type from the plan/topic. Collisions suffix -2, -3… */
export function sliceBranches(
	slices: { paths: string[] }[],
	plan: string,
	topic: string,
): SliceBranch[] {
	const { type, slug } = parseConventionalScope(plan, topic);
	const out: SliceBranch[] = [];
	for (const slice of slices) {
		const pathScope = sliceScope(slice.paths);
		const scope =
			pathScope.length >= 3 && !GENERIC_STEMS.has(pathScope) ? pathScope : slug;
		out.push({
			type,
			scope,
			branch: isolationBranchName(
				type,
				scope,
				out.map((n) => n.branch),
			),
		});
	}
	return out;
}

/** Human-style scope for a slice of paths: the deepest directory segment
 *  shared by every path, else the first file's stem. */
export function sliceScope(paths: string[]): string {
	if (paths.length === 0) return "";
	if (paths.length === 1) return capSlug(sanitizeToken(stem(paths[0])));
	const dirs = paths.map((p) => p.split("/").slice(0, -1));
	const common: string[] = [];
	for (let i = 0; i < (dirs[0]?.length ?? 0); i++) {
		const seg = dirs[0][i];
		if (!dirs.every((d) => d[i] === seg)) break;
		common.push(seg);
	}
	return capSlug(sanitizeToken(common.at(-1) ?? stem(paths[0])));
}

const CONVENTIONAL_RE =
	/^(feat|fix|chore|docs|style|refactor|test|build|ci|perf)(\([^)\s]+\))?!?:/;

function intentType(text: string): string {
	const t = text.toLowerCase();
	if (/\b(fix|bug|crash|error|regression)\b/.test(t)) return "fix";
	if (/\b(docs?|documentation)\b/.test(t)) return "docs";
	if (/\b(test|qa|spec)\b/.test(t)) return "test";
	if (/\b(refactor|cleanup|rename)\b/.test(t)) return "refactor";
	if (/\b(chore|bump|upgrade)\b/.test(t)) return "chore";
	return "feat";
}

/** Scope-style slug from topic: first few words only; drop the first word
 *  that produced the intent type so "Fix x" doesn't yield `fix-fix-x` and
 *  "Create docs for app X" doesn't yield `docs-create-docs-for-app`. */
function topicScopeSlug(topic: string, type: string): string {
	const words = topic.split(/\s+/).filter(Boolean);
	const at = words.findIndex(
		(w) => w.toLowerCase().replace(/[^a-z]/g, "") === type,
	);
	if (at >= 0) words.splice(at, 1);
	return capSlug(sanitizeToken(words.slice(0, 4).join(" ")));
}

/** Branch type/slug for isolation naming: the plan's first conventional-commit
 *  line wins; otherwise fall back to the session topic's work intent + slug
 *  (never the dead `grill/feat-grill` default). */
export function parseConventionalScope(
	plan: string,
	topic = "",
): { type: string; slug: string } {
	const matched = plan
		.split(/\r?\n/)
		.find((line) => CONVENTIONAL_RE.test(line.trim()));
	const match = matched?.match(CONVENTIONAL_RE);
	const type = match?.[1] ?? intentType(topic);
	const slug = match?.[2]
		? capSlug(sanitizeToken(match[2].slice(1, -1)))
		: topicScopeSlug(topic, type) || "grill";
	return { type, slug };
}
