import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	estTokens,
	measurePayloads,
	measurePrompts,
	measureRefusals,
	measureTools,
} from "./collect.js";

/** Phase-0 baseline harness (plan-0007). Run once with
 * SPECD_UPDATE_BASELINE=1 to seed/refresh the committed baselines; every
 * other run compares against them:
 * - GATED (fail on drift): tool count, refusal ok-flags (behavioral
 *   baseline — gates must refuse what they refused before).
 * - REPORTED (expected to move in later phases): schema/prompt/payload
 *   byte + est-token numbers. The git diff of the baseline file after a
 *   deliberate re-baseline IS the before/after evidence. */

const BASELINE_PATH = join(import.meta.dirname, "static-baseline.json");

interface Baseline {
	tools: ReturnType<typeof measureTools>;
	prompts: Record<string, number>;
	payloads: Awaited<ReturnType<typeof measurePayloads>>;
	refusals: Awaited<ReturnType<typeof measureRefusals>>;
}

const refusalKey = (r: { gate: string; scenario: string; ok: boolean }) =>
	`${r.gate}/${r.scenario}=${r.ok}`;

describe("specd token-efficiency harness (static layer)", () => {
	it("measures the current surface against the committed baseline", async () => {
		const tools = measureTools();
		const prompts = measurePrompts();
		const payloads = await measurePayloads();
		const refusals = await measureRefusals();
		const current: Baseline = { tools, prompts, payloads, refusals };

		if (
			!existsSync(BASELINE_PATH) ||
			process.env.SPECD_UPDATE_BASELINE === "1"
		) {
			mkdirSync(dirname(BASELINE_PATH), { recursive: true });
			writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, "\t")}\n`);
			console.log(
				`harness: baseline ${existsSync(BASELINE_PATH) ? "updated" : "seeded"} at ${BASELINE_PATH}`,
			);
			return;
		}

		const baseline = JSON.parse(
			readFileSync(BASELINE_PATH, "utf8"),
		) as Baseline;

		// GATED: structural + behavioral drift fails the run.
		expect(tools.count).toBe(baseline.tools.count);
		expect(refusals.map(refusalKey)).toEqual(baseline.refusals.map(refusalKey));

		// REPORTED: byte deltas (expected to improve in later phases).
		const line = (label: string, before: number, after: number): string => {
			const delta = after - before;
			const pct = before === 0 ? 0 : Math.round((delta / before) * 100);
			return `${label.padEnd(28)} ${String(before).padStart(7)} -> ${String(after).padStart(7)} bytes  (${delta >= 0 ? "+" : ""}${delta}, ${pct}%) ~${estTokens(after)} tok`;
		};
		console.log("harness delta vs committed baseline:");
		console.log(
			line(
				"tool schemas (per turn)",
				baseline.tools.totalSchemaBytes,
				tools.totalSchemaBytes,
			),
		);
		console.log(
			line(
				"  description share",
				baseline.tools.totalDescriptionBytes,
				tools.totalDescriptionBytes,
			),
		);
		for (const t of tools.perTool) {
			const before =
				baseline.tools.perTool.find((b) => b.name === t.name)?.schemaBytes ?? 0;
			if (before !== t.schemaBytes) {
				console.log(line(`    ${t.name}`, before, t.schemaBytes));
			}
		}
		for (const [name, bytes] of Object.entries(prompts)) {
			const before = baseline.prompts[name] ?? 0;
			if (before !== bytes) {
				console.log(line(`prompt ${name}`, before, bytes));
			}
		}
		console.log(
			line(
				"show payload @5 events",
				baseline.payloads.show.events5,
				payloads.show.events5,
			),
		);
		console.log(
			line(
				"show payload @20 events",
				baseline.payloads.show.events20,
				payloads.show.events20,
			),
		);
		console.log(
			line(
				"show payload @40 events",
				baseline.payloads.show.events40,
				payloads.show.events40,
			),
		);
		console.log(
			line(
				"dashboard payload",
				baseline.payloads.dashboard,
				payloads.dashboard,
			),
		);
		console.log(
			line(
				"query insight payload",
				baseline.payloads.queryInsight,
				payloads.queryInsight,
			),
		);
	});
});
