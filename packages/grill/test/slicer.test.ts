import { describe, expect, test } from "vitest";
import { parsePlanPaths, sliceApprovedPaths } from "../slicer.ts";

describe("parsePlanPaths", () => {
	test("extracts repo paths and filters noise", () => {
		const plan = `
# Heading

Look at packages/grill/slicer.ts and packages/grill/test/slicer.test.ts
Also https://example/remote.ts and ssh://host/path/file.ts are out
Grab bacon.txt README and yaml/front.yml too. Duplicate bacon.txt appears twice
`;
		const paths = parsePlanPaths(plan);
		expect(paths).toEqual([
			"packages/grill/slicer.ts",
			"packages/grill/test/slicer.test.ts",
			"bacon.txt",
			"yaml/front.yml",
		]);
	});

	test("undefined returns empty array", () => {
		expect(parsePlanPaths(undefined)).toEqual([]);
	});
});

describe("sliceApprovedPaths", () => {
	test("empty returns empty", () => {
		expect(sliceApprovedPaths([])).toEqual([]);
	});

	test("single path returns one slice", () => {
		expect(sliceApprovedPaths(["a.ts"])).toEqual([{ paths: ["a.ts"] }]);
	});

	test("five paths default to three balanced slices", () => {
		const slices = sliceApprovedPaths(["a", "b", "c", "d", "e"]);
		expect(slices).toHaveLength(3);
		expect(slices.map((s) => s.paths.length)).toEqual([2, 2, 1]);
	});

	test("five paths with maxWriters 5 make five slices", () => {
		const slices = sliceApprovedPaths(["a", "b", "c", "d", "e"], 5);
		expect(slices).toHaveLength(5);
		expect(slices.map((s) => s.paths.length)).toEqual([1, 1, 1, 1, 1]);
	});

	test("seven paths with maxWriters 5 stays balanced", () => {
		const paths = ["a", "b", "c", "d", "e", "f", "g"];
		const slices = sliceApprovedPaths(paths, 5);
		const sizes = slices.map((s) => s.paths.length);
		expect(slices.length).toBeLessThanOrEqual(5);
		expect(sizes.reduce((a, b) => a + b, 0)).toBe(7);
		expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
	});

	test("two paths become two slices", () => {
		const slices = sliceApprovedPaths(["x.ts", "y.ts"]);
		expect(slices.map((s) => s.paths)).toEqual([["x.ts"], ["y.ts"]]);
	});

	test("duplicates are deduplicated and not shared", () => {
		const slices = sliceApprovedPaths(["a", "a", "a", "b"]);
		const flat = slices.flatMap((s) => s.paths);
		expect(new Set(flat).size).toBe(flat.length);
		expect(flat).toContain("a");
		expect(flat).toContain("b");
	});

	test("maxWriters larger than path count caps to path count", () => {
		const slices = sliceApprovedPaths(["a", "b", "c", "d"], 10);
		expect(slices).toHaveLength(4);
	});

	test("every path is in exactly one slice", () => {
		const paths = ["a", "b", "c", "d", "e", "f"];
		const slices = sliceApprovedPaths(paths, 3);
		const flat = slices.flatMap((s) => s.paths);
		expect(flat.length).toBe(paths.length);
		expect([...new Set(flat)].sort()).toEqual([...paths].sort());
	});
});
