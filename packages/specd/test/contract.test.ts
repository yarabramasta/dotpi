import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_TYPES, ITEM_KINDS, LINK_KINDS } from "../src/store/schema.js";

const VENDOR_TERMS = [
	"github",
	"linear",
	"jira",
	"notion",
	"trello",
	"clickup",
	"gitlab",
	"asana",
	"azure",
	"gitbutler",
];

// The pure core must never know a sink or vendor by name. Binding layers
// (commands.ts, tools.ts, backends/*) are the vendor-facing shell and are
// deliberately outside this scan.
const PURE_CORE_FILES = [
	"store/schema.ts",
	"store/store.ts",
	"store/doctor.ts",
	"pipeline/gates.ts",
];

describe("vendor-neutral core contract", () => {
	it("vocabularies contain no sink or vendor names", () => {
		const vocab = [...ITEM_KINDS, ...EVENT_TYPES, ...LINK_KINDS].map((v) =>
			v.toLowerCase(),
		);
		for (const term of VENDOR_TERMS) {
			expect(vocab).not.toContain(term);
		}
	});

	it("pure core modules never mention sinks, vendors, or import backends", () => {
		const root = join(import.meta.dirname, "..");
		for (const file of PURE_CORE_FILES) {
			const src = readFileSync(join(root, file), "utf8").toLowerCase();
			for (const term of VENDOR_TERMS) {
				expect(src, `${file} mentions vendor term "${term}"`).not.toContain(
					term,
				);
			}
			expect(src, `${file} imports the backends layer`).not.toContain(
				"backends",
			);
		}
	});

	it("new event types are additive and vocabulary stays event-sourced", () => {
		// M1 additions must exist (work.started, pr.created) without renaming
		// or removing any earlier event type.
		for (const required of ["work.started", "pr.created"]) {
			expect(EVENT_TYPES).toContain(required);
		}
		for (const stable of [
			"created",
			"spec.approved",
			"task.exported",
			"work.paused",
			"work.completed",
		]) {
			expect(EVENT_TYPES).toContain(stable);
		}
	});
});
