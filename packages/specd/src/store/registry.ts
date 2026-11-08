import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The store registry maps repository paths to specd store locations.
 * Stored at ~/.pi/agent/specd-stores.json — machine-local, not committed.
 *
 * Registry entry shapes:
 *   in-repo:      { type: "in-repo" }                          → {cwd}/.spec/
 *   external:     { type: "external", storePath: "…" }          → the given path
 *   external-git: { type: "external-git", storePath: "…", remote?: "…" } → git repo
 */

/** Return the absolute path to the specd store registry file. Evaluated
 * at call time so tests can point it at a temporary directory. */
export function registryPath(): string {
	return join(
		process.env.PI_CODING_AGENT_DIR ??
			join(process.env.HOME ?? "", ".pi", "agent"),
		"specd-stores.json",
	);
}

/** Return the directory under which cloned reference stores live.
 * (e.g. ~/.pi/agent/stores). The directory is not created here. */
export function storesRoot(): string {
	return join(dirname(registryPath()), "stores");
}

export type StoreLocationType = "in-repo" | "external" | "external-git";

export interface StoreRegistryEntry {
	type: StoreLocationType;
	/** external/external-git: the absolute path to the store directory */
	storePath?: string;
	/** external-git: the git remote (for connect/push) */
	remote?: string;
	/** absolute paths to other stores this repo can read */
	references?: string[];
}

export interface StoreRegistry {
	[key: string]: StoreRegistryEntry;
}

export function readRegistry(): StoreRegistry {
	const path = registryPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as StoreRegistry;
	} catch {
		return {};
	}
}

export function writeRegistry(registry: StoreRegistry): void {
	const path = registryPath();
	const dir = join(path, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

/** Resolve a repo path to a stable, absolute, symlink-resolved key. */
function canonicalRepoPath(repoPath: string): string {
	const abs = resolve(repoPath);
	try {
		return realpathSync.native(abs);
	} catch {
		return abs;
	}
}

/** Register a repo → store mapping. The repo path is resolved to an
 * absolute, canonical path for stable lookup. */
export function registerStore(
	repoPath: string,
	entry: StoreRegistryEntry,
): void {
	const registry = readRegistry();
	registry[canonicalRepoPath(repoPath)] = entry;
	writeRegistry(registry);
}

/** Look up the registry entry for a repo. Returns undefined if not
 * registered. */
export function lookupStore(repoPath: string): StoreRegistryEntry | undefined {
	return readRegistry()[canonicalRepoPath(repoPath)];
}

/** Remove a registry entry (e.g. after a reset). */
export function unregisterStore(repoPath: string): void {
	const registry = readRegistry();
	delete registry[canonicalRepoPath(repoPath)];
	writeRegistry(registry);
}

/** If cwd is inside a linked git worktree, return the absolute path to the
 * main repository checkout. Otherwise return undefined. */
function resolveMainRepoFromWorktree(cwd: string): string | undefined {
	try {
		const output = execFileSync(
			"git",
			["rev-parse", "--git-dir", "--git-common-dir"],
			{
				cwd,
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		const [gitDir = "", commonDir = ""] = output.split("\n");
		if (!gitDir || !commonDir) return undefined;
		const absGitDir = resolve(cwd, gitDir.trim());
		const absCommonDir = resolve(cwd, commonDir.trim());
		if (absGitDir === absCommonDir) return undefined;
		return dirname(absCommonDir);
	} catch {
		return undefined;
	}
}

/** Resolve the store directory for cwd: map a linked git worktree back to
 * its main repository, then registry first, then the default in-repo path.
 * Returns the absolute path to the store directory (which contains store.db). */
export function resolveStoreDir(cwd: string): string {
	const repoPath = resolveMainRepoFromWorktree(cwd) ?? cwd;
	const entry = lookupStore(repoPath);
	if (entry?.storePath) {
		return canonicalRepoPath(resolve(entry.storePath));
	}
	// Default: in-repo
	return join(canonicalRepoPath(repoPath), ".spec");
}

export function expandHome(input: string): string {
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	if (input === "~") return homedir();
	return input;
}

/** Resolve the referenced store directories for a repo. Returns absolute
 * paths; empty when the repo is unregistered or has no references. */
export function resolveReferenceStores(repoPath: string): string[] {
	const entry = lookupStore(repoPath);
	if (!entry?.references) return [];
	return entry.references.map((ref) => canonicalRepoPath(expandHome(ref)));
}

/** Walk the reference graph starting from a store directory and return
 * every store directory reachable through references. */
function reachableStoreDirs(
	registry: StoreRegistry,
	startDir: string,
	visited = new Set<string>(),
): string[] {
	if (visited.has(startDir)) return [];
	visited.add(startDir);
	const dirs: string[] = [];
	for (const key of Object.keys(registry)) {
		if (resolveStoreDir(key) !== startDir) continue;
		for (const ref of resolveReferenceStores(key)) {
			dirs.push(ref);
			dirs.push(...reachableStoreDirs(registry, ref, visited));
		}
	}
	return dirs;
}

/** Add a reference store to a repo's registry entry. Returns the updated
 * references list on success, or a reason on rejection. */
export function addStoreReference(
	repoPath: string,
	refPath: string,
): { ok: true; refs: string[] } | { ok: false; reason: string } {
	const absRepo = canonicalRepoPath(repoPath);
	const absRef = canonicalRepoPath(expandHome(refPath));
	const selfDir = resolveStoreDir(absRepo);

	if (absRef === selfDir) {
		return { ok: false, reason: "cannot reference the repo's own store" };
	}

	const registry = readRegistry();
	const entry = registry[absRepo] ?? { type: "in-repo" };
	const refs = entry.references ?? [];

	if (refs.some((r) => resolve(expandHome(r)) === absRef)) {
		return { ok: false, reason: "reference already exists" };
	}

	if (reachableStoreDirs(registry, absRef).includes(selfDir)) {
		return { ok: false, reason: "circular reference" };
	}

	entry.references = [...refs, absRef];
	registry[absRepo] = entry;
	writeRegistry(registry);

	return { ok: true, refs: entry.references };
}

/** Check if a directory is a specd store (has store.db, the marker, or an
 * events.jsonl WAL). Read-only referenced stores may ship without store.db
 * because it is gitignored; the marker or WAL is enough to identify them. */
export function isSpecdStore(dir: string): boolean {
	return (
		existsSync(join(dir, "store.db")) ||
		existsSync(join(dir, ".specd-store.yaml")) ||
		existsSync(join(dir, "events.jsonl"))
	);
}
