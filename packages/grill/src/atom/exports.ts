import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AtomRow } from "./atoms.js";
import type { NodeType } from "./store.js";

/** Slug from title: lowercase, non-alphanumerics → dashes, trimmed. */
export function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "untitled"
	);
}

/** Promotion export layout: decisions → docs/decisions/, everything else → docs/atoms/. Filenames are {slug}.md (no id prefix), deduped with -2, -3… suffixes. */
export function exportRelPath(
	cwd: string,
	type: NodeType,
	title: string,
): string {
	const dir = type === "decision" ? "docs/decisions" : "docs/atoms";
	const slug = slugify(title);
	let n = 1;
	let candidate = `${dir}/${slug}.md`;
	while (existsSync(join(cwd, candidate))) {
		n++;
		candidate = `${dir}/${slug}-${n}.md`;
	}
	return candidate;
}

/**
 * Render a promotion export: YAML frontmatter (id, type, status, title,
 * scope?, sources?, promoted_to) + body. Scalar values are JSON.stringify'd —
 * valid YAML, no quoting edge cases.
 */
export function renderExport(atom: AtomRow): string {
	const lines = [
		"---",
		`id: ${atom.id}`,
		`type: ${atom.type}`,
		`status: ${atom.status}`,
		`title: ${JSON.stringify(atom.title)}`,
	];
	if (atom.scope) lines.push(`scope: ${JSON.stringify(atom.scope)}`);
	if (atom.sources) lines.push(`sources: ${atom.sources}`);
	if (atom.promoted_to) {
		lines.push(`promoted_to: ${JSON.stringify(atom.promoted_to)}`);
	}
	lines.push("---", "", atom.body, "");
	return lines.join("\n");
}

export function writeExport(cwd: string, relPath: string, atom: AtomRow): void {
	const abs = join(cwd, relPath);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, renderExport(atom), "utf8");
}

/** Remove a promotion export; returns true if a file existed. */
export function removeExport(cwd: string, relPath: string): boolean {
	const abs = join(cwd, relPath);
	if (!existsSync(abs)) return false;
	rmSync(abs);
	return true;
}
