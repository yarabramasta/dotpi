import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Kb } from "./db.js";
import { createNode, listNodes, promote } from "./nodes.js";

export interface InitResult {
	scannedAdrs: number;
	workspacePkgs: number;
	created: string[];
	isMonorepo: boolean;
}

function parsePackageJson(raw: string): {
	workspaces?: string[] | { packages: string[] };
} {
	try {
		return JSON.parse(raw) as {
			workspaces?: string[] | { packages: string[] };
		};
	} catch {
		return {};
	}
}

function scanAdrs(kb: Kb): string[] {
	const adrDir = join(kb.cwd, "docs/adr");
	let entries: string[];
	try {
		entries = readdirSync(adrDir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith(".md"))
			.map((e) => `docs/adr/${e.name}`)
			.sort();
	} catch {
		return [];
	}
	return entries.slice(0, 50);
}

function readHeading(filePath: string): string | undefined {
	try {
		const raw = readFileSync(filePath, "utf8");
		const match = /^#\s+(.+)$/m.exec(raw);
		return match?.[1]?.trim();
	} catch {
		return undefined;
	}
}

export function initKb(kb: Kb): InitResult {
	const pkgPath = join(kb.cwd, "package.json");
	let isMonorepo = false;
	let workspacePkgs = 0;
	try {
		const pkg = parsePackageJson(readFileSync(pkgPath, "utf8"));
		if (pkg.workspaces !== undefined) {
			isMonorepo = true;
			workspacePkgs = Array.isArray(pkg.workspaces)
				? pkg.workspaces.length
				: (pkg.workspaces.packages?.length ?? 0);
		}
	} catch {
		// ignore missing/unparseable package.json
	}

	const adrs = scanAdrs(kb);
	const scannedAdrs = adrs.length;

	const existingPaths = new Set(
		listNodes(kb)
			.map((n) => n.promoted_to)
			.filter((p): p is string => p !== null),
	);
	const created: string[] = [];

	for (const relPath of adrs) {
		if (existingPaths.has(relPath)) {
			continue;
		}
		const filePath = join(kb.cwd, relPath);
		const heading = readHeading(filePath);
		const name = basename(relPath, ".md");
		const title = heading ?? name;
		const body = `${heading ?? `# ${name}`}\n\n(canon ref — full record lives at the path above)`;

		const node = createNode(kb, { type: "decision", title, body });
		promote(kb, node.id, relPath);
		created.push(node.id);
	}

	try {
		const stmt = kb.db.prepare(
			"INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
		);
		stmt.run("init", new Date().toISOString());
	} catch {
		// ignore meta write failures
	}

	return { scannedAdrs, workspacePkgs, created, isMonorepo };
}
