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
import { afterEach, describe, expect, test } from "vitest";
import { openKb } from "../db.ts";
import { renderDigest } from "../digest.ts";
import { fixDoctor, runDoctor } from "../doctor.ts";
import { initKb } from "../init.ts";
import {
	addEdge,
	type CreateNodeInput,
	createNode,
	getNode,
	linkGithub,
	listNodes,
	type NodeRow,
	promote,
	queryNodes,
	readBody,
	setStatus,
	supersede,
} from "../nodes.ts";
import { detectWorkspace } from "../workspace.ts";

type SourceInput = CreateNodeInput & { sources?: string[] };
type RowWithSources = NodeRow & { sources: string | null };
const repos: string[] = [];
function makeKbRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "grill-kb-"));
	process.chdir; // never chdir — pass repo as cwd everywhere
	repos.push(repo);
	return repo;
}
afterEach(() => {
	while (repos.length) {
		const repo = repos.pop();
		if (repo) rmSync(repo, { recursive: true, force: true });
	}
});

describe("db", () => {
	test("openKb creates gitignore, db, and nodes dir", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		expect(existsSync(kb.paths.dir)).toBe(true);
		expect(existsSync(kb.paths.dbPath)).toBe(true);
		expect(existsSync(kb.paths.nodesDir)).toBe(true);
		expect(readFileSync(kb.paths.gitignorePath, "utf8")).toBe("*\n");
	});

	test("openKb is idempotent", async () => {
		const repo = makeKbRepo();
		const kb1 = await openKb(repo);
		const kb2 = await openKb(repo);
		expect(kb2.db).toBeDefined();
		expect(existsSync(kb2.paths.dbPath)).toBe(true);
		expect(kb1.paths.dbPath).toBe(kb2.paths.dbPath);
	});

	test("edges reject dangling foreign keys", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		createNode(kb, { type: "decision", title: "d", body: "b" });
		expect(() =>
			kb.db.exec(
				"INSERT INTO edges (from_id, to_id, kind) VALUES ('dec-0001', 'no-such-id', 'cited')",
			),
		).toThrow();
	});

	test("duplicate node id insert throws", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		createNode(kb, { type: "decision", title: "d", body: "b" });
		expect(() =>
			kb.db.exec(
				"INSERT INTO nodes (id, type, title, status, scope, created_at, promoted_to, github_issue, github_project) VALUES ('dec-0001', 'decision', 'dup', 'draft', null, 0, null, null, null)",
			),
		).toThrow();
	});

	test("openKb preserves nodes across close/reopen", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		createNode(kb, {
			type: "decision",
			title: "d",
			body: "b1",
			sources: ["https://a.example"],
		} as SourceInput);
		createNode(kb, { type: "research", title: "r", body: "r" });
		kb.db.close();
		const kb2 = await openKb(repo);
		const row = getNode(kb2, "dec-0001") as RowWithSources;
		expect(JSON.parse(row.sources ?? "[]")).toEqual(["https://a.example"]);
		expect(readBody(kb2, "dec-0001")).toBe("b1");
		expect(
			kb2.db.prepare("SELECT COUNT(*) c FROM nodes").get() as { c: number },
		).toEqual({ c: 2 });
	});
});

describe("nodes", () => {
	test("createNode assigns per-type ids and writes body files", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const a = createNode(kb, { type: "decision", title: "A", body: "body-a" });
		const b = createNode(kb, { type: "decision", title: "B", body: "body-b" });
		const c = createNode(kb, {
			type: "decision",
			title: "C",
			body: "body-c",
			sources: ["https://x"],
		} as SourceInput);
		expect(a.id).toBe("dec-0001");
		expect(b.id).toBe("dec-0002");
		expect(c.id).toBe("dec-0003");
		expect(existsSync(join(kb.paths.nodesDir, "dec-0001.md"))).toBe(true);
		expect(readBody(kb, "dec-0001")).toBe("body-a");
		expect((getNode(kb, c.id) as RowWithSources).sources).toBe('["https://x"]');
		expect((getNode(kb, a.id) as RowWithSources).sources).toBeNull();
	});

	test("createNode links persist as edges", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const r = createNode(kb, { type: "research", title: "R", body: "r" });
		const d = createNode(kb, {
			type: "decision",
			title: "D",
			body: "d",
			links: [{ to: r.id, kind: "cited" }],
		});
		expect(getNode(kb, r.id)?.title).toBe("R");
		const edges = kb.db.prepare("SELECT * FROM edges").all() as Array<{
			from_id: string;
			to_id: string;
			kind: string;
		}>;
		expect(edges).toHaveLength(1);
		expect(edges[0].from_id).toBe(d.id);
		expect(edges[0].to_id).toBe(r.id);
		expect(edges[0].kind).toBe("cited");
	});

	test("addEdge rejects dangling target", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		createNode(kb, { type: "decision", title: "d", body: "d" });
		expect(() => addEdge(kb, "dec-0001", "missing", "cited")).toThrow();
	});

	test("promote sets status and promoted_to", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const d = createNode(kb, { type: "decision", title: "d", body: "d" });
		promote(kb, d.id, "docs/adr/dec-0001.md");
		const row = getNode(kb, d.id);
		expect(row?.status).toBe("promoted");
		expect(row?.promoted_to).toBe("docs/adr/dec-0001.md");
	});

	test("linkGithub sets issue and project", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const d = createNode(kb, { type: "decision", title: "d", body: "d" });
		linkGithub(kb, d.id, { issue: "1", project: "p" });
		const row = getNode(kb, d.id);
		expect(row?.github_issue).toBe("1");
		expect(row?.github_project).toBe("p");
	});

	test("supersede marks old superseded and adds edge", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const oldId = createNode(kb, {
			type: "decision",
			title: "old",
			body: "o",
		}).id;
		const newId = createNode(kb, {
			type: "decision",
			title: "new",
			body: "n",
		}).id;
		supersede(kb, oldId, newId);
		expect(getNode(kb, oldId)?.status).toBe("superseded");
		const edge = kb.db
			.prepare("SELECT kind FROM edges WHERE from_id = ? AND to_id = ?")
			.get(newId, oldId) as { kind: string } | undefined;
		expect(edge?.kind).toBe("supersedes");
	});

	test("queryNodes filters by type, status, scope, and q", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		createNode(kb, { type: "decision", title: "Auth", body: "signing tokens" });
		createNode(kb, {
			type: "decision",
			title: "Cache",
			body: "ttl",
			scope: "packages/api",
		});
		createNode(kb, { type: "research", title: "Notes", body: "notes" });
		expect(queryNodes(kb, { type: "decision" })).toHaveLength(2);
		expect(queryNodes(kb, { status: "draft" })).toHaveLength(3);
		expect(queryNodes(kb, { scope: "packages/api" })).toHaveLength(1);
		expect(queryNodes(kb, { q: "Auth" })).toHaveLength(1);
		expect(queryNodes(kb, { q: "signing" })).toHaveLength(1);
	});
});

describe("doctor", () => {
	test("flags and recreates missing body", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const d = createNode(kb, { type: "decision", title: "d", body: "d" });
		rmSync(join(kb.paths.nodesDir, `${d.id}.md`));
		const issues = runDoctor(kb);
		expect(issues).toHaveLength(1);
		expect(issues[0].kind).toBe("missing-body");
		expect(issues[0].id).toBe(d.id);
		const fixed = fixDoctor(kb, issues);
		expect(fixed).toBe(1);
		const body = readFileSync(join(kb.paths.nodesDir, `${d.id}.md`), "utf8");
		expect(body).toContain("recovered");
	});

	test("flags orphan body files", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		writeFileSync(join(kb.paths.nodesDir, "zzz.md"), "orphan");
		const issues = runDoctor(kb);
		expect(issues).toHaveLength(1);
		expect(issues[0].kind).toBe("orphan-body");
	});

	test("flags broken promoted path and accepts existing path", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const d = createNode(kb, { type: "decision", title: "d", body: "d" });
		const loose = createNode(kb, { type: "decision", title: "l", body: "l" });
		const good = createNode(kb, { type: "decision", title: "g", body: "g" });
		mkdirSync(join(repo, "docs", "adr"), { recursive: true });
		writeFileSync(join(repo, "docs", "adr", "real.md"), "x");
		promote(kb, d.id, "docs/adr/nope.md");
		promote(kb, loose.id, "loose.md");
		promote(kb, good.id, "docs/adr/real.md");
		const issues = runDoctor(kb);
		expect(issues).toHaveLength(2);
		expect(
			issues
				.filter((i) => i.kind === "broken-promoted-path")
				.map((i) => i.id)
				.sort(),
		).toEqual([d.id, loose.id].sort());
	});
});

describe("init", () => {
	test("imports ADRs and detects non-monorepo", async () => {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "docs", "adr"), { recursive: true });
		writeFileSync(
			join(repo, "docs", "adr", "ADR-001.md"),
			"# Title here\n\nbody",
		);
		writeFileSync(join(repo, "docs", "adr", "ADR-002.md"), "# Other\n\nbody");
		writeFileSync(join(repo, "package.json"), "{}", "utf8");
		const kb = await openKb(repo);
		const result = initKb(kb);
		expect(result.scannedAdrs).toBe(2);
		expect(result.isMonorepo).toBe(false);
		expect(result.created).toHaveLength(2);
		const row = getNode(kb, "dec-0001");
		expect(row?.status).toBe("promoted");
		expect(row?.promoted_to).toBe("docs/adr/ADR-001.md");
		expect(readBody(kb, "dec-0001")).toContain("(canon ref");
	});

	test("initKb is idempotent", async () => {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "docs", "adr"), { recursive: true });
		writeFileSync(join(repo, "docs", "adr", "ADR-001.md"), "# A\n\nb");
		writeFileSync(join(repo, "package.json"), "{}", "utf8");
		const kb = await openKb(repo);
		initKb(kb);
		const second = initKb(kb);
		expect(second.created).toHaveLength(0);
	});

	test("detects monorepo from package.json workspaces", async () => {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "docs", "adr"), { recursive: true });
		mkdirSync(join(repo, "packages", "x"), { recursive: true });
		mkdirSync(join(repo, "packages", "y"), { recursive: true });
		writeFileSync(join(repo, "docs", "adr", "ADR-001.md"), "# A\n\nb");
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
			"utf8",
		);
		writeFileSync(join(repo, "packages", "x", "package.json"), "{}", "utf8");
		writeFileSync(join(repo, "packages", "y", "package.json"), "{}", "utf8");
		const kb = await openKb(repo);
		const result = initKb(kb);
		expect(result.isMonorepo).toBe(true);
		expect(result.workspacePkgs).toBe(2);
		expect(result.workspaceKind).toBe("npm");
	});

	test("workspaces glob matching one real package is not a monorepo", () => {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "packages", "x"), { recursive: true });
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ workspaces: ["packages/*", "apps/*"] }),
			"utf8",
		);
		writeFileSync(join(repo, "packages", "x", "package.json"), "{}", "utf8");
		expect(detectWorkspace(repo)).toEqual({
			isMonorepo: false,
			workspacePkgs: 1,
			kind: "npm",
		});
	});

	test("detects pnpm-workspace.yaml without package.json workspaces", () => {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "packages", "x"), { recursive: true });
		mkdirSync(join(repo, "packages", "y"), { recursive: true });
		writeFileSync(
			join(repo, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\nallowBuilds:\n  esbuild: true\ncatalog:\n  zod: "4"\n',
			"utf8",
		);
		writeFileSync(join(repo, "packages", "x", "package.json"), "{}", "utf8");
		writeFileSync(join(repo, "packages", "y", "package.json"), "{}", "utf8");
		expect(detectWorkspace(repo)).toEqual({
			isMonorepo: true,
			workspacePkgs: 2,
			kind: "pnpm",
		});
	});

	test("detects gradle multi-project and kmp", () => {
		const repo = makeKbRepo();
		writeFileSync(
			join(repo, "settings.gradle.kts"),
			'include(":apps:member")\ninclude(":core:ui")\n',
			"utf8",
		);
		expect(detectWorkspace(repo)).toEqual({
			isMonorepo: true,
			workspacePkgs: 2,
			kind: "gradle",
		});
		writeFileSync(
			join(repo, "build.gradle.kts"),
			'plugins { kotlin("multiplatform") }',
			"utf8",
		);
		expect(detectWorkspace(repo).kind).toBe("kmp");
	});

	test("single-module gradle is not a monorepo", () => {
		const repo = makeKbRepo();
		writeFileSync(
			join(repo, "settings.gradle.kts"),
			'include(":app")\n',
			"utf8",
		);
		expect(detectWorkspace(repo)).toEqual({
			isMonorepo: false,
			workspacePkgs: 1,
			kind: "gradle",
		});
	});

	test("bun.lock reports kind bun", () => {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "packages", "x"), { recursive: true });
		mkdirSync(join(repo, "packages", "y"), { recursive: true });
		writeFileSync(join(repo, "bun.lock"), "", "utf8");
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ workspaces: ["packages/*"] }),
			"utf8",
		);
		writeFileSync(join(repo, "packages", "x", "package.json"), "{}", "utf8");
		writeFileSync(join(repo, "packages", "y", "package.json"), "{}", "utf8");
		expect(detectWorkspace(repo)).toEqual({
			isMonorepo: true,
			workspacePkgs: 2,
			kind: "bun",
		});
	});

	test("nx.json flips js workspace kind to nx", () => {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "apps", "web"), { recursive: true });
		mkdirSync(join(repo, "apps", "api"), { recursive: true });
		writeFileSync(join(repo, "nx.json"), "{}", "utf8");
		writeFileSync(
			join(repo, "package.json"),
			JSON.stringify({ workspaces: ["apps/*"] }),
			"utf8",
		);
		writeFileSync(join(repo, "apps", "web", "package.json"), "{}", "utf8");
		writeFileSync(join(repo, "apps", "api", "project.json"), "{}", "utf8");
		expect(detectWorkspace(repo)).toEqual({
			isMonorepo: true,
			workspacePkgs: 2,
			kind: "nx",
		});
	});
});

describe("digest", () => {
	test("renderDigest summarizes knowledge base", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const d1 = createNode(kb, { type: "decision", title: "d1", body: "d1" });
		createNode(kb, { type: "decision", title: "d2", body: "d2" });
		createNode(kb, { type: "plan", title: "p", body: "p" });
		const s = createNode(kb, { type: "session", title: "s", body: "s" });
		promote(kb, s.id, "https://example.com/session");
		setStatus(kb, d1.id, "accepted");
		const digest = renderDigest(kb);
		expect(digest).toContain("# atom digest");
		expect(digest).toContain("decision");
		expect(digest).toContain("decisions active");
		expect(digest).toContain(d1.id);
		expect(digest).toContain("dec-0002");
		expect(digest).toContain("sessions");
		expect(digest).toContain(s.id);
		expect(digest).toContain("promoted");
		expect(digest.length).toBeLessThan(1200);
	});

	test("task lens restricts digest to matching atoms and their edges", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		const auth = createNode(kb, {
			type: "decision",
			title: "auth token strategy",
			body: "auth",
		});
		const refresh = createNode(kb, {
			type: "decision",
			title: "token refresh rotation",
			body: "refresh tokens",
		});
		createNode(kb, { type: "plan", title: "unrelated plan", body: "plan" });
		addEdge(kb, auth.id, refresh.id, "depends-on");
		const lens = renderDigest(kb, { task: "token refresh" });
		expect(lens).toContain("task lens: token refresh");
		expect(lens).toContain(refresh.id);
		expect(lens).not.toContain("unrelated plan");
		expect(lens).toContain("-[depends-on]->");
	});
});

describe("graph absorb", () => {
	function makeGraphRepo(): string {
		const repo = makeKbRepo();
		mkdirSync(join(repo, "docs", "adr"), { recursive: true });
		mkdirSync(join(repo, "docs", "reference", "graph"), { recursive: true });
		writeFileSync(
			join(repo, "docs", "adr", "ADR-001.md"),
			"# First decision\n\nold body",
		);
		writeFileSync(
			join(repo, "docs", "adr", "ADR-002.md"),
			"# Second decision\n\nnew body",
		);
		writeFileSync(
			join(repo, "docs", "reference", "graph", "structure.yaml"),
			[
				"schema: test-graph",
				"nodes:",
				"  - id: ADR-001",
				"    type: adr",
				"    label: First decision",
				"  - id: ADR-002",
				"    type: adr",
				"    label: Second decision",
				"  - id: FR-ONB-01",
				"    type: fr",
				"    label: Structured onboarding",
				"    phase: mvp",
				"    content: |",
				"      Capture context at onboarding.",
				"  - id: entity-session",
				"    type: entity",
				"    label: Session entity",
				"  - id: SPIKE-A",
				"    type: spike",
				"    label: Extraction spike",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(repo, "docs", "reference", "graph", "index.yaml"),
			[
				"schema: test-graph",
				"nodes: []",
				"edges:",
				"  - from: ADR-001",
				"    to: ADR-002",
				"    type: superseded-by",
				"  - from: FR-ONB-01",
				"    to: entity-session",
				"    type: depends-on",
				"",
			].join("\n"),
			"utf8",
		);
		return repo;
	}

	test("absorb maps types, links ADR canon nodes, flips supersede direction", async () => {
		const repo = makeGraphRepo();
		const kb = await openKb(repo);
		const result = initKb(kb);
		expect(result.scannedAdrs).toBe(2);
		expect(result.adrLinked).toBe(2);
		expect(result.graphNodes).toBe(3); // fr → requirement, entity → concept, spike → spike
		expect(result.graphEdges).toBe(2);
		const req = listNodes(kb, { type: "requirement" })[0];
		expect(req?.id).toMatch(/^req-/);
		expect(req?.scope).toBe("mvp");
		const spike = listNodes(kb, { type: "spike" })[0];
		expect(spike?.id).toMatch(/^spk-/);
		const dec2 = listNodes(kb, { type: "decision" }).find((n) =>
			n.promoted_to?.endsWith("ADR-002.md"),
		);
		const dec1 = listNodes(kb, { type: "decision" }).find((n) =>
			n.promoted_to?.endsWith("ADR-001.md"),
		);
		const rows = kb.db
			.prepare(
				"SELECT from_id, to_id, kind FROM edges WHERE kind = 'supersedes'",
			)
			.all() as Array<{ from_id: string; to_id: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].from_id).toBe(dec2?.id); // newer → older
		expect(rows[0].to_id).toBe(dec1?.id);
	});

	test("absorb is idempotent across re-init", async () => {
		const repo = makeGraphRepo();
		const kb = await openKb(repo);
		initKb(kb);
		const second = initKb(kb);
		expect(second.created).toHaveLength(0);
		expect(second.graphNodes).toBe(0);
		expect(second.graphEdges).toBe(0);
		expect(second.adrLinked).toBe(2);
	});
});

describe("doctor strict provenance", () => {
	test("non-strict ignores NULL provenance; strict flags promoted decisions", async () => {
		const repo = makeKbRepo();
		const kb = await openKb(repo);
		mkdirSync(join(repo, "docs", "adr"), { recursive: true });
		writeFileSync(join(repo, "docs", "adr", "ADR-001.md"), "# A");
		const node = createNode(kb, { type: "decision", title: "a", body: "a" });
		promote(kb, node.id, "docs/adr/ADR-001.md");
		expect(runDoctor(kb)).toHaveLength(0);
		const strict = runDoctor(kb, { strict: true });
		expect(strict).toHaveLength(1);
		expect(strict[0].kind).toBe("null-provenance");
		expect(strict[0].id).toBe(node.id);
		linkGithub(kb, node.id, { issue: "r#1" });
		expect(runDoctor(kb, { strict: true })).toHaveLength(0);
	});
});
