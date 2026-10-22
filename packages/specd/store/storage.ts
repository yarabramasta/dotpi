import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ItemRow, SpecdStore } from "./store.js";

/** The three storage modes. The SQLite store is always the source of truth;
 * md promotion adds readable, versionable file mirrors:
 * - db-only:    no md files (default; repo-quiet, per-machine)
 * - md-inrepo:  md written under docs/specd/ in the same repo (committed)
 * - md-external: md written into a configured directory outside the repo
 *   (separate repo or folder), e.g. a notes vault. */
export const STORAGE_MODES = ["db-only", "md-inrepo", "md-external"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

export interface StorageConfig {
	mode: StorageMode;
	/** md-external only: target directory (absolute, or relative to cwd). */
	mdPath?: string;
}

/** In-repo md location: docs/specd/<item-id>.md — id-only filenames stay
 * deterministic across title changes, so re-promote can never orphan files. */
const INREPO_DIR = "docs/specd";

export function readStorageConfig(store: SpecdStore): StorageConfig {
	const row = store.db
		.prepare("SELECT value FROM meta WHERE key = 'storage_mode'")
		.get() as { value: string } | undefined;
	if (!row) return { mode: "db-only" };
	try {
		const raw = JSON.parse(row.value) as Partial<StorageConfig>;
		if (STORAGE_MODES.includes(raw.mode as StorageMode)) {
			const mode = raw.mode as StorageMode;
			return {
				mode,
				mdPath: typeof raw.mdPath === "string" ? raw.mdPath : undefined,
			};
		}
	} catch {
		// fall through to default
	}
	return { mode: "db-only" };
}

export function saveStorageConfig(
	store: SpecdStore,
	config: StorageConfig,
): void {
	store.db
		.prepare(
			"INSERT INTO meta (key, value) VALUES ('storage_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.run(JSON.stringify(config));
}

/** Resolve the md target directory for a mode. Returns undefined for
 * db-only; validates md-external has a path configured. */
export function mdDir(
	store: SpecdStore,
	config: StorageConfig,
): string | undefined {
	if (config.mode === "db-only") return undefined;
	if (config.mode === "md-inrepo") return join(store.cwd, INREPO_DIR);
	if (!config.mdPath) {
		throw new Error(
			"md-external storage needs a target directory — set it with /spec storage md-external <path>.",
		);
	}
	return isAbsolute(config.mdPath)
		? config.mdPath
		: resolve(store.cwd, config.mdPath);
}

/** Render an item as a readable markdown export: YAML frontmatter (id,
 * kind, status, title, updated_at) + body. Scalar values JSON.stringify'd —
 * valid YAML, no quoting edge cases. */
export function renderItemMd(item: ItemRow): string {
	return [
		"---",
		`id: ${item.id}`,
		`kind: ${item.kind}`,
		`status: ${item.status}`,
		`title: ${JSON.stringify(item.title)}`,
		`updated_at: ${item.updated_at}`,
		"---",
		"",
		item.body,
		"",
	].join("\n");
}

function mdFilePath(
	store: SpecdStore,
	config: StorageConfig,
	item: ItemRow,
): string {
	const dir = mdDir(store, config);
	if (!dir) {
		throw new Error(
			"Storage mode is db-only — md promotion is off. Switch modes with /spec storage <mode>.",
		);
	}
	return join(dir, `${item.id}.md`);
}

/** Promote an item to its md mirror: writes (or overwrites) the file and
 * records the promotion. Deterministic per-item path; re-promoting is
 * idempotent. Returns the written path. */
export function promoteItem(store: SpecdStore, itemId: string): string {
	const row = store.db
		.prepare("SELECT * FROM items WHERE id = ?")
		.get(itemId) as ItemRow | undefined;
	if (!row) throw new Error(`Unknown item: ${itemId}.`);
	const config = readStorageConfig(store);
	const path = mdFilePath(store, config, row);
	// SAFETY: single-column row (path) matching the destructure below.
	const existing = store.db
		.prepare("SELECT path FROM promotions WHERE item_id = ?")
		.get(itemId) as { path: string } | undefined;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, renderItemMd(row), "utf8");
	store.db
		.prepare(
			"INSERT INTO promotions (item_id, path, promoted_at) VALUES (?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET path = excluded.path, promoted_at = excluded.promoted_at",
		)
		.run(itemId, path, new Date().toISOString());
	// Promotion owns exactly one file per item: a mode switch that moves
	// the mirror removes the old-location file instead of orphaning it.
	if (existing && existing.path !== path && existsSync(existing.path)) {
		rmSync(existing.path);
	}
	return path;
}

/** Remove an item's md mirror and its promotion record. Returns true if a
 * file was removed. */
export function demoteItem(store: SpecdStore, itemId: string): boolean {
	const row = store.db
		.prepare("SELECT path FROM promotions WHERE item_id = ?")
		.get(itemId) as { path: string } | undefined;
	if (!row) return false;
	if (existsSync(row.path)) rmSync(row.path);
	store.db.prepare("DELETE FROM promotions WHERE item_id = ?").run(itemId);
	return true;
}

export interface MdFinding {
	itemId: string;
	detail: string;
}

/** Doctor checks over promoted md: stale content, missing files, and
 * promotions left behind after switching back to db-only. */
export function mdDriftFindings(store: SpecdStore): MdFinding[] {
	// SAFETY: two-column rows (item_id, path) matching the destructure below.
	const rows = store.db
		.prepare("SELECT item_id, path FROM promotions")
		.all() as unknown as Array<{ item_id: string; path: string }>;
	if (rows.length === 0) return [];
	const config = readStorageConfig(store);
	const findings: MdFinding[] = [];
	if (config.mode === "db-only") {
		findings.push({
			itemId: rows[0].item_id,
			detail: `${rows.length} promoted md file(s) exist but storage mode is db-only — switch modes or demote.`,
		});
		return findings;
	}
	for (const row of rows) {
		const item = store.db
			.prepare("SELECT * FROM items WHERE id = ?")
			.get(row.item_id) as ItemRow | undefined;
		const expected = item ? mdFilePath(store, config, item) : undefined;
		if (expected && row.path !== expected) {
			findings.push({
				itemId: row.item_id,
				detail: `promoted md lives at ${row.path} but the current mode expects ${expected} — re-promote, then remove the old file.`,
			});
		}
		if (!existsSync(row.path)) {
			findings.push({
				itemId: row.item_id,
				detail: `promoted md file is missing: ${row.path} — re-promote or demote.`,
			});
			continue;
		}
		if (item && readFileSync(row.path, "utf8") !== renderItemMd(item)) {
			findings.push({
				itemId: row.item_id,
				detail: `promoted md is stale: ${row.path} — re-promote to refresh.`,
			});
		}
	}
	return findings;
}
