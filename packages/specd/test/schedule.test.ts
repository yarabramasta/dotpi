import { describe, expect, it } from "vitest";
import { pathScopesOverlap, planWaves } from "../pipeline/schedule.js";
import type { ItemRow } from "../store/store.js";

function task(
	id: string,
	opts: {
		phase?: string | null;
		parallel?: boolean;
		pathScope?: string | null;
		title?: string;
	} = {},
): ItemRow {
	return {
		id,
		kind: "task",
		title: opts.title ?? id,
		status: "exported",
		body: "",
		path_scope: opts.pathScope ?? null,
		phase: opts.phase ?? null,
		parallel: opts.parallel === true ? 1 : 0,
		created_at: "",
		updated_at: "",
	} as ItemRow;
}

const ids = (waves: ReturnType<typeof planWaves>["waves"]) =>
	waves.map((w) => w.tasks.map((t) => t.id));

describe("path scope overlap", () => {
	it("overlaps on exact match, containment, and wildcards", () => {
		expect(pathScopesOverlap("src/auth", "src/auth")).toBe(true);
		expect(pathScopesOverlap("src/auth", "src/auth/login.ts")).toBe(true);
		expect(pathScopesOverlap("src/auth/**", "src/auth/login.ts")).toBe(true);
		expect(pathScopesOverlap("src/*", "src/auth")).toBe(true);
		// siblings are disjoint
		expect(pathScopesOverlap("src/auth/**", "src/api/**")).toBe(false);
		// unscoped overlaps everything
		expect(pathScopesOverlap(null, "src")).toBe(true);
		expect(pathScopesOverlap("src", undefined)).toBe(true);
	});
});

describe("wave scheduling", () => {
	it("orders waves by phase and runs unphased tasks last", () => {
		const result = planWaves([
			task("task-0003", { phase: "polish" }),
			task("task-0001", { phase: "setup" }),
			task("task-0002", { phase: "foundational" }),
			task("task-0004"),
		]);
		expect(ids(result.waves)).toEqual([
			["task-0001"],
			["task-0002"],
			["task-0003"],
			["task-0004"],
		]);
	});

	it("runs [P] tasks with disjoint scopes concurrently in one wave", () => {
		const result = planWaves([
			task("task-0001", {
				phase: "story",
				parallel: true,
				pathScope: "src/auth/**",
			}),
			task("task-0002", {
				phase: "story",
				parallel: true,
				pathScope: "src/api/**",
			}),
		]);
		expect(result.waves).toHaveLength(1);
		expect(ids(result.waves)[0]).toEqual(["task-0001", "task-0002"]);
		expect(result.serialized).toEqual([]);
	});

	it("serializes scope collisions into later waves with a stated reason", () => {
		const result = planWaves([
			task("task-0001", {
				phase: "story",
				parallel: true,
				pathScope: "src/auth/**",
			}),
			task("task-0002", {
				phase: "story",
				parallel: true,
				pathScope: "src/auth/login.ts",
			}),
		]);
		expect(ids(result.waves)).toEqual([["task-0001"], ["task-0002"]]);
		expect(result.serialized).toEqual([
			{
				a: "task-0001",
				b: "task-0002",
				reason: "path scopes overlap (src/auth/** vs src/auth/login.ts)",
			},
		]);
	});

	it("never shares a wave with non-[P] or unscoped tasks", () => {
		const result = planWaves([
			task("task-0001", {
				phase: "story",
				parallel: true,
				pathScope: "src/auth/**",
			}),
			task("task-0002", { phase: "story" }), // no [P]
			task("task-0003", { phase: "story", parallel: true }), // unscoped
		]);
		expect(ids(result.waves)).toEqual([
			["task-0001"],
			["task-0002"],
			["task-0003"],
		]);
		// task-0002 runs alone anyway, so task-0003 had nobody to collide
		// with — serialization is only recorded when a wave split happened.
		expect(result.serialized).toEqual([]);
	});

	it("serializes an unscoped [P] task against a scoped one", () => {
		const result = planWaves([
			task("task-0001", {
				phase: "story",
				parallel: true,
				pathScope: "src/auth/**",
			}),
			task("task-0003", { phase: "story", parallel: true }),
		]);
		expect(ids(result.waves)).toEqual([["task-0001"], ["task-0003"]]);
		expect(result.serialized).toEqual([
			{
				a: "task-0001",
				b: "task-0003",
				reason: "unscoped task cannot prove disjointness",
			},
		]);
	});

	it("returns one wave per task and no serialization for a single task", () => {
		const result = planWaves([task("task-0001")]);
		expect(ids(result.waves)).toEqual([["task-0001"]]);
		expect(result.serialized).toEqual([]);
	});
});
