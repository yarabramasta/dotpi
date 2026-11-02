import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export type DepManager =
	| "npm/yarn/bun"
	| "pnpm"
	| "composer"
	| "cocoapods"
	| "flutter"
	| "gradle"
	| "swiftpm";

export type DepAction = "link" | "install" | "skip";

export interface DepRow {
	manager: DepManager;
	dir: string;
	action: DepAction;
	reason: string;
}

export type LockfileMatch = "match" | "mismatch" | "absent";

export interface EcosystemHit {
	manager: DepManager;
	dir: string;
}

/**
 * Directory names that detectEcosystems and apply.ts must never enter or
 * mutate. Dependency-managed dirs (node_modules, vendor, Pods) are
 * deliberately excluded because they are the actual targets of the plan.
 * Match is by directory NAME anywhere in the scanned tree.
 */
export const IGNORED_DIRS: string[] = [
	// VCS
	".git",
	".svn",
	".hg",
	// IDE / editor
	".gradle",
	".idea",
	".vscode",
	// Build outputs
	"build",
	"dist",
	"out",
	".next",
	".nuxt",
	".output",
	".svelte-kit",
	"target",
	"bin",
	"obj",
	".build",
	"DerivedData",
	".dart_tool",
	// Package-manager / cache dirs (not the dep dirs we manage)
	".npm",
	".pnpm-store",
	".yarn", // Berry cache/releases
	".bun",
	".cache",
	".turbo",
	".parcel-cache",
	".vite",
	".rollup.cache",
	// Test / tool caches
	"coverage",
	".nyc_output",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	"__pycache__",
	".tox",
	".venv",
	"venv",
	// Meta-framework / deploy-tooling ephemeral state
	".astro",
	".docusaurus",
	".expo",
	".solid",
	".vercel",
	".netlify",
	".wrangler",
	".metro",
	".stackblitz",
	".symlinks",
	"ephemeral",
	"xcuserdata",
];

// Scan-time skip set: generic ignored dirs plus the dependency dirs we manage
// (we never want to recursively inspect the inside of a node_modules).
const SCAN_IGNORED_DIRS = new Set([
	...IGNORED_DIRS,
	"node_modules",
	"Pods",
	"vendor",
]);

function sha256(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function hasGradleManifest(dir: string): boolean {
	for (const name of readdirSync(dir)) {
		if (name.startsWith("settings.gradle") || name.startsWith("build.gradle")) {
			return true;
		}
	}
	return false;
}

function hasXcodeProject(dir: string): boolean {
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".xcodeproj")) return true;
	}
	return false;
}

function detectAt(dir: string): EcosystemHit[] {
	const hits: EcosystemHit[] = [];

	if (existsSync(join(dir, "pnpm-lock.yaml"))) {
		hits.push({ manager: "pnpm", dir });
	} else if (existsSync(join(dir, "package.json"))) {
		hits.push({ manager: "npm/yarn/bun", dir });
	}

	if (existsSync(join(dir, "composer.json"))) {
		hits.push({ manager: "composer", dir });
	}
	if (existsSync(join(dir, "Podfile"))) {
		hits.push({ manager: "cocoapods", dir });
	}
	if (existsSync(join(dir, "pubspec.yaml"))) {
		hits.push({ manager: "flutter", dir });
	}
	if (hasGradleManifest(dir)) {
		hits.push({ manager: "gradle", dir });
	}
	if (
		!existsSync(join(dir, "Podfile")) &&
		(existsSync(join(dir, "Package.resolved")) || hasXcodeProject(dir))
	) {
		hits.push({ manager: "swiftpm", dir });
	}

	return hits;
}

/**
 * Scan a directory tree for dependency-manager manifest files.
 * Skips common generated directories (node_modules, .git, Pods, etc.).
 */
export function detectEcosystems(root: string): EcosystemHit[] {
	const hits: EcosystemHit[] = [];
	const visited = new Set<string>();

	function walk(dir: string) {
		if (visited.has(dir)) return;
		visited.add(dir);

		hits.push(...detectAt(dir));

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const name of entries) {
			if (SCAN_IGNORED_DIRS.has(name)) continue;
			const child = join(dir, name);
			const st = lstatSync(child, { throwIfNoEntry: false });
			if (st?.isDirectory()) walk(child);
		}
	}

	walk(root);
	return hits;
}

function lockfileNames(manager: DepManager): string[] {
	switch (manager) {
		case "npm/yarn/bun":
			return ["package-lock.json", "yarn.lock", "bun.lockb"];
		case "pnpm":
			return ["pnpm-lock.yaml"];
		case "composer":
			return ["composer.lock"];
		case "cocoapods":
			return ["Podfile.lock"];
		case "flutter":
			return ["pubspec.lock"];
		case "gradle":
			return [];
		case "swiftpm":
			return ["Package.resolved"];
	}
}

function findLockfile(manager: DepManager, dir: string): string | undefined {
	for (const name of lockfileNames(manager)) {
		const path = join(dir, name);
		if (existsSync(path)) return path;
	}
	return undefined;
}

/**
 * Compare primary vs worktree lockfile content by SHA256.
 * Returns `absent` when either side has none of the manager's lockfiles.
 */
export function lockfileMatches(
	manager: DepManager,
	primaryDir: string,
	worktreeDir: string,
): LockfileMatch {
	const primary = findLockfile(manager, primaryDir);
	const worktree = findLockfile(manager, worktreeDir);
	if (!primary || !worktree) return "absent";
	return sha256(primary) === sha256(worktree) ? "match" : "mismatch";
}

function linkableDepDir(manager: DepManager): string | undefined {
	switch (manager) {
		case "npm/yarn/bun":
			return "node_modules";
		case "composer":
			return "vendor";
		case "cocoapods":
			return "Pods";
		default:
			return undefined;
	}
}

function guardReason(match: LockfileMatch): string {
	switch (match) {
		case "match":
			return "lockfiles match";
		case "mismatch":
			return "lockfiles mismatch";
		case "absent":
			return "lockfile absent on one or both sides";
	}
}

/**
 * Build a dependency-action matrix for the worktree relative to the primary checkout.
 * CI=true forces install and disables links.
 */
export function planDepActions(
	primaryDir: string,
	worktreeDir: string,
	options?: { ci?: boolean },
): DepRow[] {
	const ci = options?.ci ?? false;
	const hits = detectEcosystems(worktreeDir);
	const rows: DepRow[] = [];

	for (const hit of hits) {
		const rel = relative(worktreeDir, hit.dir);
		const primaryHitDir = join(primaryDir, rel);
		switch (hit.manager) {
			case "npm/yarn/bun":
			case "composer":
			case "cocoapods": {
				const match = lockfileMatches(hit.manager, primaryHitDir, hit.dir);
				if (match === "match" && !ci) {
					rows.push({
						...hit,
						action: "link",
						reason: `${guardReason(match)}; safe to link ${linkableDepDir(hit.manager)}`,
					});
				} else {
					const base =
						match === "match" && ci
							? "guard passed but CI"
							: guardReason(match);
					rows.push({
						...hit,
						action: "install",
						reason: `${base}; run install`,
					});
				}
				break;
			}
			case "pnpm":
				rows.push({
					...hit,
					action: "install",
					reason:
						"pnpm stores are content-addressable but node_modules cannot be safely symlinked across worktrees; always install",
				});
				break;
			case "gradle":
				rows.push({
					...hit,
					action: "skip",
					reason: "Gradle caches are shared; no worktree action needed",
				});
				break;
			case "swiftpm":
				rows.push({
					...hit,
					action: "skip",
					reason: "Swift Package Manager uses a global package cache; skip",
				});
				break;
			case "flutter":
				rows.push({
					...hit,
					action: "skip",
					reason: "Flutter pub cache is shared; skip pub get",
				});
				break;
		}
	}

	return rows;
}

export interface ResumePlan {
	action: "link" | "noop" | "leave";
	reason: string;
}

/**
 * Decide what to do with an existing duplicated dependency directory in the worktree.
 * Only npm/yarn/bun, composer and CocoaPods support conversion; everything else is left alone.
 */
export function planResumeConversion(
	manager: DepManager,
	primaryDir: string,
	worktreeDir: string,
	options?: { ci?: boolean },
): ResumePlan {
	const ci = options?.ci ?? false;
	if (ci) {
		return {
			action: "leave",
			reason: "CI=true; do not create links, leave dir for install",
		};
	}

	const depDir = linkableDepDir(manager);
	if (!depDir) {
		return {
			action: "leave",
			reason: `${manager} dependency directories are not eligible for linking`,
		};
	}

	const target = join(worktreeDir, depDir);
	const stat = lstatSync(target, { throwIfNoEntry: false });
	if (!stat) {
		return {
			action: "leave",
			reason: `${depDir} does not exist; nothing to convert`,
		};
	}
	if (stat.isSymbolicLink()) {
		return {
			action: "noop",
			reason: `${depDir} is already a symlink; no action`,
		};
	}
	if (!stat.isDirectory()) {
		return {
			action: "leave",
			reason: `${depDir} is not a directory; no action`,
		};
	}

	const match = lockfileMatches(manager, primaryDir, worktreeDir);
	if (match === "match") {
		return {
			action: "link",
			reason: `lockfiles match; convert ${depDir} to symlink`,
		};
	}
	return {
		action: "leave",
		reason: `${guardReason(match)}; leave duplicated ${depDir}`,
	};
}
