import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../store/doctor.js";
import { MIGRATIONS } from "../store/migrate.js";
import { SCHEMA_VERSION } from "../store/schema.js";
import { openStore } from "../store/store.js";

/** DDL reproduced from the on-disk v2 store (verified via read-only
 * sqlite3): v3 minus the phase/parallel columns. */
const V2_DDL = `
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
CREATE TABLE items (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	title TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'draft',
	body TEXT NOT NULL DEFAULT '',
	path_scope TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	item TEXT NOT NULL REFERENCES items(id),
	type TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}',
	at TEXT NOT NULL,
	actor TEXT NOT NULL,
	batch TEXT
);
CREATE INDEX events_item_idx ON events(item);
CREATE TABLE links (
	from_item TEXT NOT NULL REFERENCES items(id),
	to_item TEXT NOT NULL REFERENCES items(id),
	kind TEXT NOT NULL,
	PRIMARY KEY (from_item, to_item, kind)
);
CREATE VIRTUAL TABLE item_fts USING fts5(
	id UNINDEXED,
	title,
	body
);
`;

interface V2Fixture {
	dir: string;
	db: DatabaseSync;
	cleanup: () => void;
}

function makeV2Store(version = "2"): V2Fixture {
	const dir = mkdtempSync(join(tmpdir(), "specd-v2-"));
	mkdirSync(join(dir, ".spec"), { recursive: true });
	const db = new DatabaseSync(join(dir, ".spec", "store.db"));
	db.exec(V2_DDL);
	db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
		version,
	);
	// A minimal lingua-lair-shaped cycle: approved spec, exported task, link.
	db.exec(`
		INSERT INTO items (id, kind, title, status, body, path_scope, created_at, updated_at) VALUES
			('spec-0001', 'spec', 'S', 'approved', 'body', NULL, '2026-10-22T15:17:00.000Z', '2026-10-22T15:18:00.000Z'),
			('task-0001', 'task', 'T', 'exported', 'ac', 'src/canon.ts', '2026-10-22T15:17:30.000Z', '2026-10-22T15:19:00.000Z');
		INSERT INTO events (item, type, payload, at, actor) VALUES
			('spec-0001', 'created', '{"kind":"spec","title":"S","body":"body","pathScope":null}', '2026-10-22T15:17:00.000Z', 'agent'),
			('spec-0001', 'spec.approved', '{}', '2026-10-22T15:18:00.000Z', 'agent'),
			('task-0001', 'created', '{"kind":"task","title":"T","body":"ac","pathScope":"src/canon.ts"}', '2026-10-22T15:17:30.000Z', 'agent'),
			('task-0001', 'task.exported', '{}', '2026-10-22T15:19:00.000Z', 'agent');
		INSERT INTO links (from_item, to_item, kind) VALUES ('task-0001', 'spec-0001', 'part-of');
		INSERT INTO item_fts (id, title, body) VALUES
			('spec-0001', 'S', 'body'),
			('task-0001', 'T', 'ac');
	`);
	return {
		dir,
		db,
		cleanup: () => {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

let fixture: V2Fixture | undefined;

afterEach(() => {
	fixture?.cleanup();
	fixture = undefined;
});

describe("v2 → v3 in-place migration", () => {
	it("chain terminates at the current schema version", () => {
		expect(MIGRATIONS.length).toBeGreaterThan(0);
		expect(MIGRATIONS[MIGRATIONS.length - 1]?.to).toBe(SCHEMA_VERSION);
		for (let i = 1; i < MIGRATIONS.length; i++) {
			expect(MIGRATIONS[i]?.from).toBe(MIGRATIONS[i - 1]?.to);
		}
	});

	it("migrates on open, keeps every row and event, doctor reports clean", async () => {
		fixture = makeV2Store();
		const store = await openStore(fixture.dir);

		const version = store.db
			.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
			.get() as { value: string };
		expect(version.value).toBe("3");

		const rows = store.db
			.prepare("SELECT id, status, phase, parallel FROM items ORDER BY id")
			.all() as Array<{
			id: string;
			status: string;
			phase: string | null;
			parallel: number;
		}>;
		expect(rows).toEqual([
			{ id: "spec-0001", status: "approved", phase: null, parallel: 0 },
			{ id: "task-0001", status: "exported", phase: null, parallel: 0 },
		]);

		const events = store.db
			.prepare("SELECT item, type, payload FROM events ORDER BY id")
			.all() as Array<{ item: string; type: string; payload: string }>;
		expect(events).toHaveLength(4);
		expect(events[0]?.payload).toBe(
			'{"kind":"spec","title":"S","body":"body","pathScope":null}',
		);

		expect(runDoctor(store)).toEqual([]);
		store.db.close();
	});

	it("reopen after migration is a no-op (no duplicate columns)", async () => {
		fixture = makeV2Store();
		const first = await openStore(fixture.dir);
		first.db.close();
		const second = await openStore(fixture.dir);
		const cols = second.db
			.prepare(
				"SELECT COUNT(*) AS n FROM pragma_table_info('items') WHERE name IN ('phase','parallel')",
			)
			.get() as { n: number };
		expect(cols.n).toBe(2);
		second.db.close();
	});

	it("refuses stores newer than the extension, transaction rolled back", async () => {
		fixture = makeV2Store("9");
		await expect(openStore(fixture.dir)).rejects.toThrow(
			/no migration path from schema_version 9/,
		);
		// Rollback check: version stamp and columns untouched.
		const version = fixture.db
			.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
			.get() as { value: string };
		expect(version.value).toBe("9");
		const cols = fixture.db
			.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('items')")
			.get() as { n: number };
		expect(cols.n).toBe(8);
	});
});
