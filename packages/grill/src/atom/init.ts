import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AtomStore } from "./store.js";
import { detectWorkspace, type WorkspaceKind } from "./workspace.js";

export interface InitResult {
	isMonorepo: boolean;
	workspacePkgs: number;
	workspaceKind: WorkspaceKind;
	textconvHint: string;
	agentsPointer: ReturnType<typeof ensureAgentsPointer>;
}

/** Optional textconv makes atoms.db diffs human-readable (.dump); merges stay binary — single-writer model is the mitigation. */
const TEXTCONV_HINT = `git config diff.sqlite3.textconv "sh -c 'sqlite3 $0 .dump'"`;

const POINTER_START = "<!-- grill-atom-kb -->";
const POINTER_END = "<!-- /grill-atom-kb -->";
const POINTER_BLOCK = `## Repo knowledge base
${POINTER_START}
Knowledge canon lives in \`.pi/knowledge/atoms.db\` (grill atom store - SQLite, bodies in-db, FTS5 search). The store is the single source of truth; promoted atoms export to \`docs/\` on demand (\`atom_promote\`), demotion deletes the export only.
- In pi: tools \`atom_query\` (\`id=<id>\` returns the full atom), \`atom_digest\`, \`atom_link\`, \`atom_backfill\`, \`atom_create\`, \`atom_update\`, \`atom_promote\`, \`atom_demote\`.
- Without pi: \`sqlite3 .pi/knowledge/atoms.db "SELECT id,title FROM atoms_fts WHERE atoms_fts MATCH 'kw*'"\`
${POINTER_END}`;

export function ensureAgentsPointer(
	cwd: string,
): "updated" | "skipped" | "created" | "written" {
	const target = join(cwd, "AGENTS.md");

	if (!existsSync(target)) {
		writeFileSync(target, `# AGENTS.md\n\n${POINTER_BLOCK}`, "utf8");
		return "created";
	}

	const content = readFileSync(target, "utf8");
	const startIdx = content.indexOf(POINTER_START);
	const endIdx = content.indexOf(POINTER_END);
	if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
		writeFileSync(
			target,
			`${content.slice(0, startIdx)}${POINTER_BLOCK}${content.slice(
				endIdx + POINTER_END.length,
			)}`,
			"utf8",
		);
		return "updated";
	}

	if (content.includes("atoms.db")) {
		return "skipped";
	}

	writeFileSync(target, `${content}\n\n${POINTER_BLOCK}`, "utf8");
	return "written";
}

/**
 * init v2: scaffold happens in openAtomStore (atoms.db + .gitignore +
 * .gitattributes); init records the timestamp and reports workspace shape.
 */
export function initAtom(store: AtomStore): InitResult {
	const {
		isMonorepo,
		workspacePkgs,
		kind: workspaceKind,
	} = detectWorkspace(store.cwd);

	try {
		store.db
			.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
			.run("init", new Date().toISOString());
	} catch {
		// ignore meta write failures
	}

	return {
		isMonorepo,
		workspacePkgs,
		workspaceKind,
		textconvHint: TEXTCONV_HINT,
		agentsPointer: ensureAgentsPointer(store.cwd),
	};
}
