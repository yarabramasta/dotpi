import type { DatabaseSync } from "node:sqlite";

/** Forward-only migration chain: one entry per version transition, applied
 * in order until the store reaches SCHEMA_VERSION. DDL is transactional in
 * SQLite, so each run is all-or-nothing — an interrupted open leaves the
 * store at its old version and simply retries next time. */
export const MIGRATIONS: ReadonlyArray<{
	from: string;
	to: string;
	steps: readonly string[];
}> = [
	{
		from: "2",
		to: "3",
		steps: [
			"ALTER TABLE items ADD COLUMN phase TEXT",
			"ALTER TABLE items ADD COLUMN parallel INTEGER NOT NULL DEFAULT 0",
		],
	},
	{
		from: "3",
		to: "4",
		steps: [
			// v4: md promotion records (storage modes). CREATE TABLE IF NOT
			// EXISTS so fresh v4 stores applying the full DDL are no-ops here.
			"CREATE TABLE IF NOT EXISTS promotions (\n\t\t\titem_id TEXT PRIMARY KEY REFERENCES items(id),\n\t\t\tpath TEXT NOT NULL,\n\t\t\tpromoted_at TEXT NOT NULL\n\t\t)",
		],
	},
];

/** Migrate db from fromVersion to toVersion inside one transaction.
 * Returns human-readable findings for the caller to surface. Throws (with
 * the transaction rolled back) when no path exists. */
export function migrateStore(
	db: DatabaseSync,
	fromVersion: string,
	toVersion: string,
): string[] {
	const findings: string[] = [];
	db.exec("BEGIN");
	try {
		let version = fromVersion;
		while (version !== toVersion) {
			const step = MIGRATIONS.find((m) => m.from === version);
			if (!step) {
				const newer = Number(version) > Number(toVersion);
				throw new Error(
					`no migration path from schema_version ${version} to ${toVersion}` +
						(newer
							? " — the store is newer than this extension; upgrade the extension"
							: ""),
				);
			}
			for (const sql of step.steps) {
				db.exec(sql);
			}
			findings.push(`migrated schema_version ${step.from} → ${step.to}`);
			version = step.to;
		}
		db.prepare(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
		).run(toVersion);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return findings;
}
