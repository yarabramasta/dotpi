import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SpecdStore } from "./store.js";

/** The store registry maps repository paths to specd store locations.
 * Stored at ~/.pi/agent/specd-stores.json — machine-local, not committed.
 *
 * Registry entry shapes:
 *   in-repo:      { type: "in-repo" }                          → {cwd}/.spec/
 *   external:     { type: "external", storePath: "…" }          → the given path
 *   external-git: { type: "external-git", storePath: "…", remote?: "…" } → git repo
 */

const REGISTRY_PATH = join(
	process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.env["HOME"] ?? "", ".pi", "agent"),
	"specd-stores.json",
);

export type StoreLocationType = "in-repo" | "external" | "external-git";

export interface StoreRegistryEntry {
	type: StoreLocationType;
	/** external/external-git: the absolute path to the store directory */
	storePath?: string;
	/** external-git: the git remote (for connect/push) */
	remote?: string;
}

export interface StoreRegistry {
	[key: string]: StoreRegistryEntry;
}

export function readRegistry(): StoreRegistry {
	if (!existsSync(REGISTRY_PATH)) return {};
	try {
		return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as StoreRegistry;
	} catch {
		return {};
	}
}

export function writeRegistry(registry: StoreRegistry): void {
	const dir = join(REGISTRY_PATH, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
}

/** Register a repo → store mapping. The repo path is resolved to an
 * absolute path for stable lookup. */
export function registerStore(repoPath: string, entry: StoreRegistryEntry): void {
	const registry = readRegistry();
	registry[resolve(repoPath)] = entry;
	writeRegistry(registry);
}

/** Look up the registry entry for a repo. Returns undefined if not
 * registered. */
export function lookupStore(repoPath: string): StoreRegistryEntry | undefined {
	return readRegistry()[resolve(repoPath)];
}

/** Remove a registry entry (e.g. after a reset). */
export function unregisterStore(repoPath: string): void {
	const registry = readRegistry();
	delete registry[resolve(repoPath)];
	writeRegistry(registry);
}

/** Resolve the store directory for a repo: registry first, then the
 * default in-repo path. Returns the absolute path to the store
 * directory (which contains store.db). */
export function resolveStoreDir(repoPath: string): string {
	const entry = lookupStore(repoPath);
	if (entry?.storePath) {
		return resolve(entry.storePath);
	}
	// Default: in-repo
	return join(resolve(repoPath), ".spec");
}

/** Check if a directory is a specd store (has store.db + the marker). */
export function isSpecdStore(dir: string): boolean {
	return existsSync(join(dir, "store.db"));
}
