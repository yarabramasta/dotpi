import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Kb } from "./db.js";
import { getNode, listNodes } from "./nodes.js";

export type DoctorIssueKind =
	| "missing-body"
	| "orphan-body"
	| "broken-promoted-path";

export interface DoctorIssue {
	kind: DoctorIssueKind;
	id?: string;
	detail: string;
}

export function runDoctor(kb: Kb): DoctorIssue[] {
	const issues: DoctorIssue[] = [];

	const nodes = listNodes(kb);
	for (const node of nodes) {
		const bodyPath = `${kb.paths.nodesDir}/${node.id}.md`;
		if (!existsSync(bodyPath)) {
			issues.push({
				kind: "missing-body",
				id: node.id,
				detail: `body file missing: nodes/${node.id}.md`,
			});
		}
	}

	const entries = readdirSync(kb.paths.nodesDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) {
			continue;
		}
		const name = entry.name.slice(0, -3);
		if (!getNode(kb, name)) {
			issues.push({
				kind: "orphan-body",
				detail: `orphan body file: nodes/${name} (no node row)`,
			});
		}
	}

	for (const node of nodes) {
		const target = node.promoted_to;
		if (!target) {
			continue;
		}
		if (target.startsWith("http://") || target.startsWith("https://")) {
			continue;
		}
		const resolved = resolve(kb.cwd, target);
		if (!existsSync(resolved)) {
			issues.push({
				kind: "broken-promoted-path",
				id: node.id,
				detail: `promoted path missing: ${target} (node ${node.id})`,
			});
		}
	}

	return issues;
}

export function fixDoctor(kb: Kb, issues: DoctorIssue[]): number {
	let fixed = 0;
	for (const issue of issues) {
		if (issue.kind !== "missing-body" || !issue.id) {
			continue;
		}
		writeFileSync(
			`${kb.paths.nodesDir}/${issue.id}.md`,
			"<!-- recovered by kb doctor -->\n",
		);
		fixed++;
	}
	return fixed;
}
