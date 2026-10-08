import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import {
	addEdge,
	createAtom,
	demote,
	getAtom,
	listAtoms,
	promote,
	queryAtoms,
	readBody,
	setStatus,
	supersede,
	updateAtom,
} from "../atoms.ts";
import { renderDigest } from "../digest.ts";
import { runDoctor } from "../doctor.ts";
import { renderExport } from "../exports.ts";
import { initAtom } from "../init.ts";
import { migrateLegacyStore } from "../migrate.ts";
import { openAtomStore, SCHEMA_VERSION } from "../store.ts";
import { detectWorkspace } from "../workspace.ts";

type RowWithSources = { sources: string | null };

const repos: string[] = [];
function makeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "grill-atom-"));
	repos.push(repo);
	return repo;
}
afterEach(() => {
	while (repos.length) {
		const repo = repos.pop();
		if (repo) rmSync(repo, { recursive: true, force: true });
	}
});

describe("store v2", () => {
	test("openAtomStore scaffolds atoms.db, gitignore, gitattributes, schema_version", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		expect(existsSync(store.paths.dbPath)).toBe(true);
		expect(existsSync(store.paths.gitignorePath)).toBe(true);
		expect(existsSync(store.paths.gitattributesPath)).toBe(true);
		expect(readFileSync(store.paths.gitignorePath, "utf8")).toBe(
			"*\n!atoms.db\natoms.db-journal\natoms.db-wal\natoms.db-shm\n",
		);
		const version = (
			store.db
				.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
				.get() as { value: string }
		).value;
		expect(version).toBe(SCHEMA_VERSION);
		const tables = (
			store.db
				.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'atoms%'")
				.all() as { name: string }[]
		).map((r) => r.name);
		expect(tables).toContain("atoms");
		expect(tables).toContain("atoms_fts");
		const cols = (
			store.db.prepare("PRAGMA table_info(atoms)").all() as {
				name: string;
			}[]
		).map((c) => c.name);
		expect(cols).toContain("body");
	});

	test("openAtomStore is idempotent across reopen", async () => {
		const repo = makeRepo();
		const store1 = await openAtomStore(repo);
		createAtom(store1, { type: "decision", title: "d", body: "b1" });
		store1.db.close();
		const store2 = await openAtomStore(repo);
		expect(getAtom(store2, "dec-0001")?.body).toBe("b1");
	});

	test("edges reject dangling foreign keys", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		createAtom(store, { type: "decision", title: "d", body: "b" });
		expect(() =>
			store.db.exec(
				"INSERT INTO edges (from_id, to_id, kind) VALUES ('dec-0001', 'no-such-id', 'cited')",
			),
		).toThrow();
	});

	test("duplicate atom id insert throws", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		createAtom(store, { type: "decision", title: "d", body: "b" });
		expect(() =>
			store.db.exec(
				"INSERT INTO atoms (id, type, title, status, created_at) VALUES ('dec-0001', 'decision', 'dup', 'draft', 0)",
			),
		).toThrow();
	});

	test("legacy kb.db blocks openAtomStore (no auto-read)", async () => {
		const repo = makeRepo();
		mkdirSync(join(repo, ".pi", "knowledge"), { recursive: true });
		new DatabaseSync(join(repo, ".pi", "knowledge", "kb.db")).close();
		mkdirSync(join(repo, ".pi", "knowledge", "nodes"), { recursive: true });
		await expect(openAtomStore(repo)).rejects.toThrow(/legacy/);
	});
});

describe("atoms", () => {
	test("createAtom stores body in db, no md file", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "A",
			body: "body-a",
			sources: ["https://x"],
		});
		const b = createAtom(store, {
			type: "decision",
			title: "B",
			body: "body-b",
		});
		expect(a.id).toBe("dec-0001");
		expect(b.id).toBe("dec-0002");
		expect(readBody(store, a.id)).toBe("body-a");
		expect(existsSync(join(repo, ".pi", "knowledge", "nodes"))).toBe(false);
		expect((getAtom(store, a.id) as RowWithSources).sources).toBe(
			'["https://x"]',
		);
	});

	test("createAtom links persist as edges", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const r = createAtom(store, { type: "research", title: "R", body: "r" });
		const d = createAtom(store, {
			type: "decision",
			title: "D",
			body: "d",
			links: [{ to: r.id, kind: "cited" }],
		});
		const edges = store.db.prepare("SELECT * FROM edges").all() as Array<{
			from_id: string;
			to_id: string;
			kind: string;
		}>;
		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({
			from_id: d.id,
			to_id: r.id,
			kind: "cited",
		});
	});

	test("addEdge rejects dangling target", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		createAtom(store, { type: "decision", title: "d", body: "d" });
		expect(() => addEdge(store, "dec-0001", "missing", "cited")).toThrow();
	});

	test("setStatus and supersede", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const old = createAtom(store, {
			type: "decision",
			title: "old",
			body: "o",
		});
		const neu = createAtom(store, {
			type: "decision",
			title: "new",
			body: "n",
		});
		supersede(store, old.id, neu.id);
		expect(getAtom(store, old.id)?.status).toBe("superseded");
		const edge = store.db
			.prepare("SELECT kind FROM edges WHERE from_id = ? AND to_id = ?")
			.get(neu.id, old.id) as { kind: string };
		expect(edge.kind).toBe("supersedes");
		setStatus(store, neu.id, "accepted");
		expect(getAtom(store, neu.id)?.status).toBe("accepted");
	});

	test("queryAtoms: FTS5 hits body text", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		createAtom(store, {
			type: "decision",
			title: "Auth",
			body: "signing tokens rotate hourly",
		});
		createAtom(store, {
			type: "decision",
			title: "Cache",
			body: "ttl",
			scope: "packages/api",
		});
		createAtom(store, { type: "research", title: "Notes", body: "notes" });
		expect(queryAtoms(store, { q: "signing" })).toHaveLength(1);
		expect(queryAtoms(store, { q: "Auth" })).toHaveLength(1);
		expect(queryAtoms(store, { type: "decision" })).toHaveLength(2);
		expect(queryAtoms(store, { status: "draft" })).toHaveLength(3);
		expect(queryAtoms(store, { scope: "packages/api" })).toHaveLength(1);
		// AND across tokens
		expect(queryAtoms(store, { q: "signing tokens" })).toHaveLength(1);
		expect(queryAtoms(store, { q: "signing ttl" })).toHaveLength(0);
	});

	test("queryAtoms falls back to LIKE on malformed FTS query", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		createAtom(store, {
			type: "decision",
			title: 'Wunderbar "quoted"',
			body: 'unbalanced " paren (',
		});
		expect(() => queryAtoms(store, { q: 'unbalanced " (' })).not.toThrow();
		expect(queryAtoms(store, { q: 'unbalanced " (' })).toHaveLength(1);
	});

	test("FTS stays in sync with body updates", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "t",
			body: "original words",
		});
		store.db
			.prepare("UPDATE atoms SET body = ? WHERE id = ?")
			.run("replaced body entirely", a.id);
		expect(queryAtoms(store, { q: "replaced" })).toHaveLength(1);
		expect(queryAtoms(store, { q: "original" })).toHaveLength(0);
	});

	test("listAtoms orders by created_at desc", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, { type: "decision", title: "a", body: "a" });
		const b = createAtom(store, { type: "research", title: "b", body: "b" });
		// same-millisecond ties fall back to id ASC — set created_at explicitly
		store.db
			.prepare("UPDATE atoms SET created_at = ? WHERE id = ?")
			.run(1, a.id);
		store.db
			.prepare("UPDATE atoms SET created_at = ? WHERE id = ?")
			.run(2, b.id);
		const rows = listAtoms(store);
		expect(rows[0]?.id).toBe(b.id);
		expect(rows[1]?.id).toBe(a.id);
	});

	test("queryAtoms: id, statusNot, after, limit, sort filters", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, { type: "decision", title: "a", body: "a" });
		const b = createAtom(store, { type: "research", title: "b", body: "b" });
		const c = createAtom(store, { type: "plan", title: "c", body: "c" });
		store.db
			.prepare("UPDATE atoms SET created_at = ? WHERE id = ?")
			.run(1, a.id);
		store.db
			.prepare("UPDATE atoms SET created_at = ? WHERE id = ?")
			.run(2, b.id);
		store.db
			.prepare("UPDATE atoms SET created_at = ? WHERE id = ?")
			.run(3, c.id);
		setStatus(store, c.id, "accepted");

		expect(queryAtoms(store, { id: b.id })).toHaveLength(1);
		expect(queryAtoms(store, { statusNot: "draft" })).toHaveLength(1);
		expect(queryAtoms(store, { statusNot: "draft" })[0]?.id).toBe(c.id);
		expect(queryAtoms(store, { after: "1970-01-01" })).toHaveLength(3);
		expect(queryAtoms(store, { after: "9999-01-01" })).toHaveLength(0);
		const top1 = queryAtoms(store, { limit: 1 });
		expect(top1).toHaveLength(1);
		expect(top1[0]?.id).toBe(c.id); // recency desc: newest first
		const byId = queryAtoms(store, { sort: "id" });
		expect(byId.map((r) => r.id)).toEqual([a.id, c.id, b.id]); // dec < plan < res alphabetically
		expect(() => queryAtoms(store, { after: "not-a-date" })).toThrow(
			/invalid after/,
		);
	});
});

describe("promote → export round-trip", () => {
	test("promote writes readable export and updates row", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "Single Store",
			body: "Bodies live in SQLite.",
			scope: "packages/grill",
			sources: ["https://example.com/x"],
		});
		const updated = promote(store, a.id);
		expect(updated.status).toBe("promoted");
		expect(updated.promoted_to).toBe("docs/decisions/single-store.md");
		const file = join(repo, "docs", "decisions", "single-store.md");
		expect(existsSync(file)).toBe(true);
		const md = readFileSync(file, "utf8");
		expect(md).toContain("---");
		expect(md).toContain(`id: ${a.id}`);
		expect(md).toContain("type: decision");
		expect(md).toContain("status: promoted");
		expect(md).toContain('"Single Store"');
		expect(md).toContain("Bodies live in SQLite.");
		// round-trip: export body equals db body
		expect(renderExport(getAtom(store, a.id) as never)).toBe(md);
	});

	test("non-decision types export flat under docs/atoms", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const r = createAtom(store, {
			type: "research",
			title: "FTS5 research",
			body: "findings",
		});
		const updated = promote(store, r.id);
		expect(updated.promoted_to).toBe("docs/atoms/fts5-research.md");
	});

	test("slug collisions get -2 suffixes", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, { type: "decision", title: "Same", body: "1" });
		const b = createAtom(store, { type: "decision", title: "Same", body: "2" });
		expect(promote(store, a.id).promoted_to).toBe("docs/decisions/same.md");
		expect(promote(store, b.id).promoted_to).toBe("docs/decisions/same-2.md");
	});

	test("explicit docsPath overrides default layout", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, { type: "decision", title: "X", body: "x" });
		const updated = promote(store, a.id, "docs/custom/x.md");
		expect(updated.promoted_to).toBe("docs/custom/x.md");
		expect(existsSync(join(repo, "docs", "custom", "x.md"))).toBe(true);
	});
});

describe("demote", () => {
	test("reverses promotion: status, promoted_to, export file", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "tidy repo",
			body: "b",
		});
		const promoted = promote(store, a.id);
		const file = join(repo, promoted.promoted_to as string);
		expect(existsSync(file)).toBe(true);

		const result = demote(store, a.id);
		expect(result.atom.status).toBe("accepted");
		expect(result.atom.promoted_to).toBeNull();
		expect(result.removedExport).toBe(promoted.promoted_to);
		expect(existsSync(file)).toBe(false);
		expect(getAtom(store, a.id)?.status).toBe("accepted");
	});

	test("non-promoted atom is a no-op", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, { type: "decision", title: "d", body: "b" });
		const result = demote(store, a.id);
		expect(result.atom.status).toBe("draft");
		expect(result.removedExport).toBeUndefined();
	});

	test("URL promoted_to clears fields without file ops", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, { type: "decision", title: "d", body: "b" });
		promote(store, a.id, "https://example.com/post");
		const result = demote(store, a.id);
		expect(result.atom.status).toBe("accepted");
		expect(result.atom.promoted_to).toBeNull();
		expect(result.removedExport).toBeUndefined();
	});

	test("throws on unknown id", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		expect(() => demote(store, "nope-0001")).toThrow(/not found/);
	});
});

describe("doctor v2", () => {
	test("flags empty bodies", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		createAtom(store, { type: "decision", title: "empty", body: "" });
		createAtom(store, { type: "decision", title: "full", body: "content" });
		const issues = runDoctor(store);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatchObject({ kind: "empty-body" });
	});

	test("flags orphan edges", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		createAtom(store, { type: "decision", title: "d", body: "d" });
		store.db.exec("PRAGMA foreign_keys = OFF;");
		store.db.exec(
			"INSERT INTO edges (from_id, to_id, kind, created_at) VALUES ('dec-0001', 'ghost', 'cited', 0)",
		);
		store.db.exec("PRAGMA foreign_keys = ON;");
		const issues = runDoctor(store);
		expect(issues.some((i) => i.kind === "orphan-edge")).toBe(true);
	});

	test("clean store passes; strict flags promoted decisions without sources", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "a",
			body: "a",
		});
		promote(store, a.id);
		expect(runDoctor(store)).toHaveLength(0);
		const strict = runDoctor(store, { strict: true });
		expect(strict).toHaveLength(1);
		expect(strict[0].kind).toBe("null-provenance");
		// clean case: promoted decision WITH sources passes strict
		const repo2 = makeRepo();
		const store2 = await openAtomStore(repo2);
		const b = createAtom(store2, {
			type: "decision",
			title: "b",
			body: "b",
			sources: ["https://example.com/x"],
		});
		promote(store2, b.id);
		expect(runDoctor(store2, { strict: true })).toHaveLength(0);
	});
});

describe("migration", () => {
	function buildLegacyRepo(): string {
		const repo = makeRepo();
		const knowledge = join(repo, ".pi", "knowledge");
		mkdirSync(join(knowledge, "nodes"), { recursive: true });
		const db = new DatabaseSync(join(knowledge, "kb.db"));
		db.exec(`
			CREATE TABLE IF NOT EXISTS nodes (
				id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
				status TEXT NOT NULL, scope TEXT, created_at INTEGER NOT NULL,
				promoted_to TEXT, github_issue TEXT, github_project TEXT, sources TEXT
			) STRICT;
			CREATE TABLE IF NOT EXISTS edges (
				from_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
				to_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
				kind TEXT NOT NULL, created_at INTEGER NOT NULL,
				PRIMARY KEY (from_id, to_id, kind)
			) STRICT;
			CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
		`);
		db.prepare(
			"INSERT INTO nodes (id, type, title, status, created_at, promoted_to) VALUES (?, ?, ?, ?, ?, ?)",
		).run(
			"dec-0001",
			"decision",
			"ADR One",
			"promoted",
			1,
			"docs/adr/ADR-001.md",
		);
		db.prepare(
			"INSERT INTO nodes (id, type, title, status, created_at, promoted_to) VALUES (?, ?, ?, ?, ?, ?)",
		).run("res-0001", "research", "Token research", "draft", 2, null);
		db.prepare(
			"INSERT INTO edges (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)",
		).run("res-0001", "dec-0001", "cited", 3);
		db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
			"init",
			"old",
		);
		db.close();
		writeFileSync(join(knowledge, "nodes", "dec-0001.md"), "Old ADR body\n");
		writeFileSync(join(knowledge, "nodes", "res-0001.md"), "Research body\n");
		return repo;
	}

	test("converter round-trips rows, bodies, edges; deletes legacy store", () => {
		const repo = buildLegacyRepo();
		const result = migrateLegacyStore(repo);
		expect(result).toEqual({ atoms: 2, edges: 1, exports: 1 });

		// legacy store deleted
		expect(existsSync(join(repo, ".pi", "knowledge", "kb.db"))).toBe(false);
		expect(existsSync(join(repo, ".pi", "knowledge", "nodes"))).toBe(false);

		// new store opens clean and keeps ids + bodies + edges
		let store: Awaited<ReturnType<typeof openAtomStore>> | undefined;
		return openAtomStore(repo).then((opened) => {
			store = opened;
			const dec = getAtom(store, "dec-0001");
			expect(dec?.body).toBe("Old ADR body\n");
			expect(dec?.status).toBe("promoted");
			// stale docs/adr target repointed to the export layout
			expect(dec?.promoted_to).toBe("docs/decisions/adr-one.md");
			expect(existsSync(join(repo, "docs", "decisions", "adr-one.md"))).toBe(
				true,
			);
			expect(
				readFileSync(join(repo, "docs", "decisions", "adr-one.md"), "utf8"),
			).toContain("Old ADR body");
			const res = getAtom(store, "res-0001");
			expect(res?.body).toBe("Research body\n");
			expect(res?.promoted_to).toBeNull(); // draft: untouched
			const edges = store.db
				.prepare("SELECT from_id, to_id, kind FROM edges")
				.all() as Array<{ from_id: string; to_id: string; kind: string }>;
			expect(edges).toEqual([
				{ from_id: "res-0001", to_id: "dec-0001", kind: "cited" },
			]);
		});
	});

	test("converter refuses when atoms.db already exists", () => {
		const repo = buildLegacyRepo();
		writeFileSync(join(repo, ".pi", "knowledge", "atoms.db"), "x");
		expect(() => migrateLegacyStore(repo)).toThrow(/already exists/);
	});
});

describe("init v2", () => {
	test("scaffold + workspace report + textconv hint, idempotent", async () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "packages", "x"), { recursive: true });
		mkdirSync(join(repo, "packages", "y"), { recursive: true });
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
		);
		writeFileSync(join(repo, "packages", "x", "package.json"), "{}");
		writeFileSync(join(repo, "packages", "y", "package.json"), "{}");
		const store = await openAtomStore(repo);
		const first = initAtom(store);
		expect(first.isMonorepo).toBe(true);
		expect(first.workspacePkgs).toBe(2);
		expect(first.workspaceKind).toBe("npm");
		expect(first.textconvHint).toContain("diff.sqlite3.textconv");
		const second = initAtom(store);
		expect(second.workspacePkgs).toBe(2);
	});

	test("AGENTS.md pointer created on first init and updated on second", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const first = initAtom(store);
		expect(first.agentsPointer).toBe("created");
		const file = join(repo, "AGENTS.md");
		expect(existsSync(file)).toBe(true);
		const createdContent = readFileSync(file, "utf8");
		expect(createdContent).toContain("<!-- grill-atom-kb -->");
		expect(createdContent).toContain("<!-- /grill-atom-kb -->");

		const second = initAtom(store);
		expect(second.agentsPointer).toBe("updated");
		const updatedContent = readFileSync(file, "utf8");
		const markerCount = (updatedContent.match(/<!-- grill-atom-kb -->/g) ?? [])
			.length;
		expect(markerCount).toBe(1);
		expect(updatedContent).toContain(
			"Knowledge canon lives in `.pi/knowledge/atoms.db`",
		);
	});

	test("AGENTS.md pointer skipped when file already mentions atoms.db", async () => {
		const repo = makeRepo();
		const path = join(repo, "AGENTS.md");
		writeFileSync(
			path,
			"# AGENTS.md\n\nCustom knowledge: see `.pi/knowledge/atoms.db`.\n",
		);
		const before = readFileSync(path, "utf8");
		const store = await openAtomStore(repo);
		const result = initAtom(store);
		expect(result.agentsPointer).toBe("skipped");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("AGENTS.md pointer updated when markers wrap a placeholder", async () => {
		const repo = makeRepo();
		const path = join(repo, "AGENTS.md");
		writeFileSync(
			path,
			"# AGENTS.md\n\n## Repo knowledge base\n<!-- grill-atom-kb -->\nold placeholder\n<!-- /grill-atom-kb -->\n",
		);
		const store = await openAtomStore(repo);
		const result = initAtom(store);
		expect(result.agentsPointer).toBe("updated");
		const content = readFileSync(path, "utf8");
		expect(content).toContain(
			"Knowledge canon lives in `.pi/knowledge/atoms.db`",
		);
		expect(content).not.toContain("old placeholder");
		expect(content).toContain("<!-- /grill-atom-kb -->");
	});
});

describe("updateAtom", () => {
	test("updates body, status, scope in place", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "t",
			body: "v1",
			scope: "old",
		});
		const updated = updateAtom(store, a.id, {
			body: "v2",
			status: "accepted",
			scope: "new",
		});
		expect(updated).toMatchObject({
			body: "v2",
			status: "accepted",
			scope: "new",
		});
		expect(readBody(store, a.id)).toBe("v2");
		expect(queryAtoms(store, { q: "v1" })).toHaveLength(0);
		expect(queryAtoms(store, { q: "v2" })).toHaveLength(1);
	});

	test("promoted-atom body edit regenerates export", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "single store",
			body: "original body",
		});
		const promoted = promote(store, a.id);
		const file = join(repo, promoted.promoted_to as string);
		expect(readFileSync(file, "utf8")).toContain("original body");
		updateAtom(store, a.id, { body: "revised body" });
		const md = readFileSync(file, "utf8");
		expect(md).toContain("revised body");
		expect(md).not.toContain("original body");
	});

	test("sources replacement and clear; promoted export regenerated", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const a = createAtom(store, {
			type: "decision",
			title: "no sources yet",
			body: "b",
		});
		const promoted = promote(store, a.id);
		const file = join(repo, promoted.promoted_to as string);
		expect(readFileSync(file, "utf8")).not.toContain("sources:");

		updateAtom(store, a.id, {
			sources: ["https://example.com/pr-1", "https://example.com/pr-2"],
		});
		expect((getAtom(store, a.id) as RowWithSources).sources).toBe(
			'["https://example.com/pr-1","https://example.com/pr-2"]',
		);
		expect(readFileSync(file, "utf8")).toContain("sources:");
		expect(readFileSync(file, "utf8")).toContain("pr-1");

		// empty array clears provenance (strict check stops flagging)
		updateAtom(store, a.id, { sources: [] });
		expect((getAtom(store, a.id) as RowWithSources).sources).toBeNull();
		expect(readFileSync(file, "utf8")).not.toContain("sources:");
	});

	test("throws on unknown id", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		expect(() => updateAtom(store, "nope-0001", { body: "x" })).toThrow(
			/not found/,
		);
	});
});

describe("digest", () => {
	test("renderDigest summarizes the store", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const d1 = createAtom(store, { type: "decision", title: "d1", body: "d1" });
		createAtom(store, { type: "decision", title: "d2", body: "d2" });
		const s = createAtom(store, { type: "session", title: "s", body: "s" });
		promote(store, s.id, "https://example.com/session");
		setStatus(store, d1.id, "accepted");
		const digest = renderDigest(store);
		expect(digest).toContain("# atom digest");
		expect(digest).toContain("decisions active");
		expect(digest).toContain("sessions");
		expect(digest).toContain("promoted");
	});

	test("task lens restricts to matching atoms and their edges", async () => {
		const repo = makeRepo();
		const store = await openAtomStore(repo);
		const auth = createAtom(store, {
			type: "decision",
			title: "auth token strategy",
			body: "auth",
		});
		const refresh = createAtom(store, {
			type: "decision",
			title: "token refresh rotation",
			body: "refresh tokens",
		});
		createAtom(store, { type: "plan", title: "unrelated plan", body: "plan" });
		addEdge(store, auth.id, refresh.id, "depends-on");
		const lens = renderDigest(store, { task: "token refresh" });
		expect(lens).toContain(refresh.id);
		expect(lens).not.toContain("unrelated plan");
		expect(lens).toContain("-[depends-on]->");
	});
});

describe("workspace", () => {
	test("detects pnpm-workspace.yaml", () => {
		const repo = makeRepo();
		mkdirSync(join(repo, "packages", "x"), { recursive: true });
		mkdirSync(join(repo, "packages", "y"), { recursive: true });
		writeFileSync(
			join(repo, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\n',
		);
		writeFileSync(join(repo, "packages", "x", "package.json"), "{}");
		writeFileSync(join(repo, "packages", "y", "package.json"), "{}");
		expect(detectWorkspace(repo)).toEqual({
			isMonorepo: true,
			workspacePkgs: 2,
			kind: "pnpm",
		});
	});
});
