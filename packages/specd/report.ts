import { runDoctor } from "./src/store/doctor.js";
import {
	counts,
	history,
	type ItemRow,
	listItems,
	parseJsonLoose,
	type SpecdStore,
} from "./src/store/store.js";

/** Self-contained HTML session report: the specd side of a work session —
 * dashboard summary, every item with its full event timeline, links, and
 * the doctor verdict — written next to the pi conversation export for
 * handoff to another agent or person. Pure renderer; no dependencies. */

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function sessionReportFilename(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
	return `specd-session-${stamp}.html`;
}

function payloadSummary(payload: string): string {
	const parsed = parseJsonLoose<unknown>(payload);
	const text =
		parsed === undefined ? payload : JSON.stringify(parsed, null, 1) || "{}";
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > 320 ? `${one.slice(0, 320)}…` : one;
}

const STYLE = `
body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; color: #1a1a2e; }
h1 { border-bottom: 2px solid #4a4ae8; padding-bottom: .3rem; }
h2 { margin-top: 2rem; font-size: 1.1rem; }
table { border-collapse: collapse; width: 100%; font-size: .85rem; }
th, td { border: 1px solid #ddd; padding: .25rem .5rem; text-align: left; vertical-align: top; }
th { background: #f4f4fb; }
code, pre { font-family: ui-monospace, Menlo, monospace; font-size: .8rem; }
.meta { color: #555; font-size: .85rem; }
.status-approved, .status-done { color: #0a7d33; font-weight: 600; }
.status-exported, .status-in-progress { color: #b06a00; font-weight: 600; }
.finding { color: #b00020; }
.clean { color: #0a7d33; font-weight: 600; }
.hint { margin-top: 2rem; padding: .6rem 1rem; background: #f4f4fb; border-left: 3px solid #4a4ae8; font-size: .85rem; }
`;

export function renderSessionReport(
	store: SpecdStore,
	now: Date = new Date(),
): string {
	const items = listItems(store, { limit: 10000 });
	const doctor = runDoctor(store);
	const summary = counts(store)
		.map((c) => `${c.kind}/${c.status}: ${c.n}`)
		.join(" · ");

	// Links: one static read; grouped for display.
	// SAFETY: three-column rows (from_item, to_item, kind) matching the
	// destructure below.
	const linkRows = store.db
		.prepare(
			"SELECT from_item, to_item, kind FROM links ORDER BY from_item, to_item",
		)
		.all() as unknown as Array<{
		from_item: string;
		to_item: string;
		kind: string;
	}>;
	const linkHtml = (() => {
		if (linkRows.length === 0) return "<p>No links.</p>";
		const rows = linkRows
			.map(
				(l) =>
					`<tr><td><code>${esc(l.from_item)}</code></td><td>${esc(l.kind)}</td><td><code>${esc(l.to_item)}</code></td></tr>`,
			)
			.join("\n");
		return `<table><tr><th>from</th><th>kind</th><th>to</th></tr>${rows}</table>`;
	})();

	const itemHtml = items
		.map((item: ItemRow) => {
			const events = history(store, item.id)
				.map(
					(e) =>
						`<tr><td>${esc(e.at)}</td><td><code>${esc(e.type)}</code></td><td>${esc(e.actor)}</td><td><code>${esc(payloadSummary(e.payload))}</code></td></tr>`,
				)
				.join("\n");
			const scope = item.path_scope
				? ` · scope: <code>${esc(item.path_scope)}</code>`
				: "";
			const phase = item.phase ? ` · phase: ${esc(item.phase)}` : "";
			const parallel = item.parallel === 1 ? " · [P]" : "";
			return `<h2><code>${esc(item.id)}</code> — ${esc(item.title)}</h2>
<p class="meta">${esc(item.kind)} · <span class="status-${esc(item.status)}">${esc(item.status)}</span>${scope}${phase}${parallel}</p>
<table><tr><th>at</th><th>event</th><th>actor</th><th>payload</th></tr>${events}</table>`;
		})
		.join("\n");

	const doctorHtml =
		doctor.length === 0
			? '<span class="clean">clean — the store matches its event history.</span>'
			: doctor
					.map(
						(f) =>
							`<div class="finding">- ${esc(f.kind)}: ${esc(f.detail)}</div>`,
					)
					.join("\n");

	return `<!doctype html>
<html><head><meta charset="utf-8"><title>specd session report</title><style>${STYLE}</style></head>
<body>
<h1>specd session report</h1>
<p class="meta">generated ${esc(now.toISOString())} · repo ${esc(store.cwd)}</p>
<p><strong>Summary:</strong> ${esc(summary) || "empty store"}</p>
<h2>Doctor</h2>
<p>${doctorHtml}</p>
<h2>Items (${items.length})</h2>
${itemHtml || "<p>No items.</p>"}
<h2>Links (${linkRows.length})</h2>
${linkHtml}
<div class="hint">This report covers the <strong>specd side</strong> (store state and event history). The conversation transcript is pi's own session export — run that from the session as well when handing both to another agent.</div>
</body></html>`;
}
