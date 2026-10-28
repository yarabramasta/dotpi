import { describe, expect, it } from "vitest";
import { renderSessionReport, sessionReportFilename } from "../report.js";
import { addLink, appendEvent, createItem } from "../src/store/store.js";
import { makeStore, type TestStore } from "./helpers.js";

describe("session report", () => {
	it("filename is deterministic per timestamp and html-safe", () => {
		const name = sessionReportFilename(new Date("2026-10-25T01:02:03Z"));
		expect(name).toMatch(/^specd-session-2026-10-25T01-02-03\.html$/);
	});

	it("renders items, timelines, links, doctor verdict — escaped", async () => {
		let t: TestStore | undefined;
		try {
			t = await makeStore();
			const spec = createItem(t.store, {
				kind: "spec",
				title: 'Login <script>alert("xss")</script>',
				body: "## Intent\nUsers can log in.",
				actor: "test",
			});
			const task = createItem(t.store, {
				kind: "task",
				title: "Add login route",
				body: "POST /login",
				pathScope: "src/auth/**",
				actor: "test",
			});
			addLink(t.store, task.id, spec.id, "part-of");
			appendEvent(t.store, {
				item: spec.id,
				type: "spec.approved",
				actor: "user",
			});
			appendEvent(t.store, {
				item: task.id,
				type: "task.exported",
				payload: { sink: "null", externalRef: "task-0001" },
				actor: "agent",
			});

			const html = renderSessionReport(t.store);

			// items + statuses + timeline events present
			expect(html).toContain("spec-0001");
			expect(html).toContain("task-0001");
			expect(html).toContain("spec.approved");
			expect(html).toContain("task.exported");
			expect(html).toContain("part-of");
			expect(html).toContain("src/auth/**");
			// doctor verdict
			expect(html).toContain("clean — the store matches its event history.");
			// XSS escaped: the raw tag must not survive; the escaped form
			// is assembled from parts so no named entity is written literally.
			const escapedTag = ["&", "lt;", "script", "&", "gt;", "alert"].join("");
			expect(html).not.toContain("<script>alert");
			expect(html).toContain(escapedTag);
			// handoff hint present
			expect(html).toContain("conversation transcript");
		} finally {
			t?.cleanup();
		}
	});

	it("renders doctor findings when the store is unhealthy", async () => {
		let t: TestStore | undefined;
		try {
			t = await makeStore();
			// orphan event: simulate corruption — the schema's FK constraint
			// normally prevents this, so suspend it for the insert only.
			t.store.db.exec("PRAGMA foreign_keys = OFF");
			t.store.db
				.prepare(
					"INSERT INTO events (item, type, payload, at, actor) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					"task-9999",
					"body.updated",
					"{}",
					new Date().toISOString(),
					"test",
				);
			t.store.db.exec("PRAGMA foreign_keys = ON");
			const html = renderSessionReport(t.store);
			expect(html).toContain("orphan-event");
			expect(html).not.toContain("clean — the store matches");
		} finally {
			t?.cleanup();
		}
	});
});
