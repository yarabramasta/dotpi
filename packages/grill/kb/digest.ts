import type { Kb } from "./db.js";
import { listNodes } from "./nodes.js";

function formatDate(ts: number): string {
	return new Date(ts).toISOString().slice(0, 10);
}

function truncateTitle(title: string): string {
	if (title.length <= 60) return title;
	return `${title.slice(0, 60)}…`;
}

export function renderDigest(kb: Kb): string {
	const nodes = listNodes(kb);
	const lines: string[] = ["# kb digest"];

	const typeCounts: Record<
		string,
		{ total: number; byStatus: Record<string, number> }
	> = {};
	let promoted = 0;
	const sessions: { id: string; title: string; created_at: number }[] = [];

	for (const node of nodes) {
		if (!typeCounts[node.type]) {
			typeCounts[node.type] = { total: 0, byStatus: {} };
		}
		typeCounts[node.type].total++;
		typeCounts[node.type].byStatus[node.status] =
			(typeCounts[node.type].byStatus[node.status] ?? 0) + 1;
		if (node.status === "promoted") promoted++;
		if (node.type === "session") {
			sessions.push({
				id: node.id,
				title: node.title,
				created_at: node.created_at,
			});
		}
	}

	if (nodes.length) {
		for (const type of Object.keys(typeCounts).sort()) {
			const { total, byStatus } = typeCounts[type];
			const statusParts = Object.entries(byStatus)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([status, count]) => `${count} ${status}`)
				.join(", ");
			lines.push(`- ${type}: ${total} (${statusParts})`);
		}
	}

	if (sessions.length) {
		const recent = sessions
			.sort((a, b) => b.created_at - a.created_at)
			.slice(0, 3)
			.map(
				(s) =>
					`${s.id} "${truncateTitle(s.title)}" (${formatDate(s.created_at)})`,
			)
			.join(", ");
		lines.push(`- sessions (last ${Math.min(sessions.length, 3)}): ${recent}`);
	}

	const activeDecisions = nodes
		.filter(
			(node) =>
				node.type === "decision" &&
				(node.status === "draft" || node.status === "accepted"),
		)
		.sort((a, b) => b.created_at - a.created_at)
		.slice(0, 5);

	if (activeDecisions.length) {
		const list = activeDecisions
			.map(
				(node) => `${node.id} "${truncateTitle(node.title)}" (${node.status})`,
			)
			.join(", ");
		lines.push(`- decisions active: ${list}`);
	}

	if (promoted) {
		lines.push(`- promoted: ${promoted} node${promoted === 1 ? "" : "s"}`);
	}

	// Skip empty sections: if there are no nodes at all, only the heading remains.
	if (lines.length === 1) return lines[0];
	return lines.join("\n");
}
