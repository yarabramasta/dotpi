import { execSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createExternalStore } from "./external.js";
import {
	isSpecdStore,
	lookupStore,
	registerStore,
	type StoreRegistryEntry,
} from "./registry.js";
import { applySchema, SCHEMA_VERSION } from "./schema.js";
import { replayEventsJsonl } from "./store.js";

export interface MigrationResult {
	migrated: boolean;
	alreadyMigrated: boolean;
	storePath: string;
}

interface StoreCounts {
	items: number;
	events: number;
	links: number;
	statuses: string;
}

function readCounts(db: DatabaseSync): StoreCounts {
	const items = (
		db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }
	).n;
	const events = (
		db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }
	).n;
	const links = (
		db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }
	).n;
	// SAFETY: aggregate SELECT names kind/status/n exactly.
	const statusRows = db
		.prepare(
			"SELECT kind, status, COUNT(*) AS n FROM items GROUP BY kind, status ORDER BY kind, status",
		)
		.all() as unknown as Array<{ kind: string; status: string; n: number }>;
	const statuses = statusRows
		.map((r) => `${r.kind}:${r.status}=${r.n}`)
		.join(",");
	return { items, events, links, statuses };
}

function openSourceDb(specDir: string): DatabaseSync {
	const dbPath = join(specDir, "store.db");
	if (!existsSync(dbPath)) {
		throw new Error(`No source store at ${dbPath}`);
	}
	return new DatabaseSync(dbPath);
}

function copyLinks(sourceDb: DatabaseSync, targetDb: DatabaseSync): void {
	// SAFETY: three-column SELECT matches the links table schema.
	const links = sourceDb
		.prepare("SELECT from_item, to_item, kind FROM links")
		.all() as unknown as Array<{
		from_item: string;
		to_item: string;
		kind: string;
	}>;
	for (const link of links) {
		targetDb
			.prepare(
				"INSERT OR IGNORE INTO links (from_item, to_item, kind) VALUES (?, ?, ?)",
			)
			.run(link.from_item, link.to_item, link.kind);
	}
}

function stripSpecReinclusion(repoPath: string): void {
	const gitignorePath = join(repoPath, ".gitignore");
	if (!existsSync(gitignorePath)) return;
	const original = readFileSync(gitignorePath, "utf8");
	const filtered = original
		.split("\n")
		.filter((line) => line.trim() !== "!.spec/")
		.join("\n");
	if (filtered === original) return;
	writeFileSync(gitignorePath, filtered, "utf8");
}

function commitExternalEvents(storePath: string): void {
	execSync(
		'git add events.jsonl && git commit -m "migrate specd store events"',
		{
			cwd: storePath,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "specd",
				GIT_AUTHOR_EMAIL: "specd@localhost",
				GIT_COMMITTER_NAME: "specd",
				GIT_COMMITTER_EMAIL: "specd@localhost",
			},
		},
	);
}

/** Migrate an in-repo `.spec/` store to an external store.
 *
 * Algorithm (verify-before-flip):
 * 1. Short-circuit if already migrated (external registry + no `.spec/`).
 * 2. Refuse if the target directory already looks like a specd store.
 * 3. Create the external store directory, marker, and git repo.
 * 4. Copy the source `events.jsonl` WAL into the external dir and replay it.
 * 5. Copy the `links` table — links are not event-sourced, so replay alone
 *    cannot restore them.
 * 6. Verify item/event/link counts and projected statuses match the source.
 *    On mismatch: throw, leave `.spec/` intact, and remove the incomplete
 *    external store.
 * 7. Commit the migrated `events.jsonl` in the external store's own git repo
 *    BEFORE flipping the registry, so a commit failure cannot delete an
 *    already-registered store.
 * 8. Flip the registry to external, remove `.spec/`, strip `!.spec/` from the
 *    repo `.gitignore`.
 */
export function migrateToExternalStore(
	repoPath: string,
	storePath: string,
): MigrationResult {
	const resolvedRepo = resolve(repoPath);
	const resolvedStore = resolve(storePath);
	const specDir = join(resolvedRepo, ".spec");
	const sourceEventsPath = join(specDir, "events.jsonl");

	// AC 6: idempotent — already external and `.spec/` is already gone.
	const entry = lookupStore(resolvedRepo);
	if (
		(entry?.type === "external" || entry?.type === "external-git") &&
		!existsSync(specDir)
	) {
		return {
			migrated: false,
			alreadyMigrated: true,
			storePath: entry.storePath ?? resolvedStore,
		};
	}

	if (!existsSync(sourceEventsPath)) {
		throw new Error(
			`No in-repo events.jsonl at ${sourceEventsPath}; nothing to migrate.`,
		);
	}

	if (isSpecdStore(resolvedStore)) {
		throw new Error(
			`Migration refused: ${resolvedStore} already holds a specd store; migration would destroy it. Remove the target directory to retry.`,
		);
	}

	// 1-2. Create external dir + marker + git repo.
	mkdirSync(dirname(resolvedStore), { recursive: true });
	createExternalStore(resolvedStore, resolvedRepo);

	// 3-4. Copy WAL, replay into a fresh target db, and copy links
	// (links are not event-sourced) BEFORE registry flip. Treat replay
	// failures as a verified refusal — `.spec/` stays intact.
	const targetEventsPath = join(resolvedStore, "events.jsonl");
	cpSync(sourceEventsPath, targetEventsPath);

	try {
		const targetDb = new DatabaseSync(join(resolvedStore, "store.db"));
		applySchema(targetDb);
		replayEventsJsonl(targetDb, targetEventsPath);
		targetDb
			.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
			.run("schema_version", SCHEMA_VERSION);

		const sourceDb = openSourceDb(specDir);
		copyLinks(sourceDb, targetDb);
		sourceDb.close();
		targetDb.close();
	} catch (err) {
		rmSync(resolvedStore, { recursive: true, force: true });
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Migration refused: could not replay source store into target (${reason}).`,
		);
	}

	// 5. Verify BEFORE destroying anything.
	const sourceVerifyDb = openSourceDb(specDir);
	const targetVerifyDb = new DatabaseSync(join(resolvedStore, "store.db"), {
		readOnly: true,
	});
	const sourceCounts = readCounts(sourceVerifyDb);
	const targetCounts = readCounts(targetVerifyDb);
	sourceVerifyDb.close();
	targetVerifyDb.close();

	if (
		sourceCounts.items !== targetCounts.items ||
		sourceCounts.events !== targetCounts.events ||
		sourceCounts.links !== targetCounts.links ||
		sourceCounts.statuses !== targetCounts.statuses
	) {
		// Refuse to delete `.spec/`; clean up the incomplete external store.
		rmSync(resolvedStore, { recursive: true, force: true });
		throw new Error(
			`Migration refused: source and target store contents do not match. ` +
				`items ${sourceCounts.items} vs ${targetCounts.items}, ` +
				`events ${sourceCounts.events} vs ${targetCounts.events}, ` +
				`links ${sourceCounts.links} vs ${targetCounts.links}.`,
		);
	}

	// 6. Commit migrated events BEFORE destructive flip. If commit fails,
	// clean up the target while `.spec/` and registry remain intact.
	try {
		commitExternalEvents(resolvedStore);
	} catch (err) {
		rmSync(resolvedStore, { recursive: true, force: true });
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Migration refused: could not commit migrated events in external store (${reason}).`,
		);
	}

	// 7. Verified and committed: flip registry, remove old store, clean repo.
	try {
		registerStore(resolvedRepo, {
			type: "external",
			storePath: resolvedStore,
		} as StoreRegistryEntry);
		rmSync(specDir, { recursive: true, force: true });
		stripSpecReinclusion(resolvedRepo);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		console.warn(
			`specd migration completed but post-flip cleanup failed for ${resolvedRepo}: ${reason}`,
		);
	}

	return {
		migrated: true,
		alreadyMigrated: false,
		storePath: resolvedStore,
	};
}
