import { history, parseJsonLoose, type SpecdStore } from "./store/store.js";

/** Naming conventions (conventional-commits aligned, D-naming): every
 * artifact's name states the goal of the operation. Task items carry an
 * optional conventional type (feat | fix | chore | docs | test | refactor
 * | perf | style | build | ci) in their created payload; scope derives
 * from the task's path scope. Consumers: the worktree tool (branch), the
 * export tool (issue title), and the run prompt (worker commits/PR). */

const CC_TYPES = new Set([
	"feat",
	"fix",
	"chore",
	"docs",
	"test",
	"refactor",
	"perf",
	"style",
	"build",
	"ci",
]);

/** Directory-ish segments that don't name a scope by themselves. */
const GENERIC_ROOTS = new Set([
	"src",
	"lib",
	"packages",
	"apps",
	"test",
	"tests",
	"docs",
	"scripts",
	".github",
	"bin",
	"config",
]);

/** The task's conventional type — from the created payload's `type`
 * (specd_create_item extra), defaulting to "feat". */
export function ccTypeOf(store: SpecdStore, itemId: string): string {
	for (const e of history(store, itemId)) {
		if (e.type !== "created") continue;
		const payload = parseJsonLoose<{ type?: string }>(e.payload);
		const t = payload?.type?.toLowerCase();
		if (t && CC_TYPES.has(t)) return t;
	}
	return "feat";
}

/** Derive a conventional scope from the task's path scope: the first
 * directory-ish segment that isn't a generic root. Files at the root
 * (README.md) and pure-glob scopes give "" — the title renders without
 * a scope parenthesis. */
export function scopeOf(pathScope: string | null | undefined): string {
	if (!pathScope) return "";
	const segments = pathScope
		.split("/")
		.map((seg) => seg.replace(/\*+/g, "").trim())
		.filter(Boolean);
	for (const seg of segments) {
		if (seg.includes(".")) continue; // a file, not a directory
		if (GENERIC_ROOTS.has(seg)) continue;
		return seg;
	}
	return "";
}

/** Conventional title: `type(scope): Title` / `type: Title`. The title
 * keeps its casing except the first character (conventional subjects
 * start lowercase; acronyms like README survive). */
export function ccTitle(
	store: SpecdStore,
	itemId: string,
	title: string,
): string {
	const type = ccTypeOf(store, itemId);
	const scope = scopeOf(itemRowPathScope(store, itemId));
	const subject = title.charAt(0).toLowerCase() + title.slice(1);
	return scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
}

function itemRowPathScope(store: SpecdStore, itemId: string): string | null {
	const row = store.db
		.prepare("SELECT path_scope FROM items WHERE id = ?")
		.get(itemId) as { path_scope: string | null } | undefined;
	return row?.path_scope ?? null;
}

/** Branch name for the execution seam: the tool namespace (specd/* —
 * what the reset sweep prunes) + conventional type + ref + slug. */
export function branchName(
	item: {
		id: string;
		title: string;
	},
	type: string,
): string {
	const slug = item.title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `specd/${type}/${item.id}-${slug}`;
}
