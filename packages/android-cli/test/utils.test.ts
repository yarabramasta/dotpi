import { describe, expect, test } from "vitest";
import { formatExecResult, tryParseJson } from "../utils.ts";

describe("formatExecResult", () => {
	test("stdout only", () => {
		expect(
			formatExecResult({ stdout: "ok\n", stderr: "", code: 0, killed: false }),
		).toBe("ok");
	});

	test("stderr and nonzero exit", () => {
		expect(
			formatExecResult({ stdout: "", stderr: "boom", code: 1, killed: false }),
		).toBe("stderr: boom\nexit code: 1");
	});

	test("no output", () => {
		expect(
			formatExecResult({ stdout: "", stderr: "", code: 0, killed: false }),
		).toBe("(no output)");
	});
});

describe("tryParseJson", () => {
	test("parses valid json with surrounding whitespace", () => {
		expect(tryParseJson('  {"a": 1}  ')).toEqual({ a: 1 });
	});

	test("returns null for invalid json", () => {
		expect(tryParseJson("not json")).toBeNull();
	});
});
