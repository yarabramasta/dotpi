import type { ItemRow, KindStatusCount } from "./store/store.js";

/** Pure dashboard rendering so tests cover it without a pi runtime. */
export function renderDashboard(
	rows: ItemRow[],
	countRows: KindStatusCount[],
	pausedIds: string[] = [],
): string {
	const header = `# specd — current state\n`;
	if (rows.length === 0) {
		return `${header}\nNo items yet. Describe what to build and the cycle will create specs, plans, and tasks here.\n`;
	}
	const paused = new Set(pausedIds);
	const summary = countRows
		.map((c) => `${c.kind}/${c.status}: ${c.n}`)
		.join(" · ");
	const lines = rows.map((r) => {
		const flag = paused.has(r.id) ? " · ⏸ paused (capsule ready)" : "";
		return `- **${r.id}** (${r.kind}, ${r.status})${flag} ${r.title}`;
	});
	return `${header}\n${summary}\n\n${lines.join("\n")}\n`;
}
