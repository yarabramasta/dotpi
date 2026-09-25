import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	aliasTools,
	assessSupport,
	fetchContentTool,
	getSearchContentTool,
	normalizeQueries,
	sliceBounded,
	sourceCheckTool,
	webSearchTool,
} from "../aliases.js";

vi.mock("node:fs", () => ({
	readFileSync: vi.fn(() => {
		throw new Error("no auth");
	}),
	writeFileSync: vi.fn(),
}));

type TextResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

type MinimalCtx = { hasUI: false };

function textOf(result: TextResult): string {
	return result.content.map((item) => item.text).join("\n");
}

function asResult(value: unknown): TextResult {
	return value as TextResult;
}

function fakeCtx(): MinimalCtx {
	return { hasUI: false };
}

describe("normalizeQueries", () => {
	test("trims whitespace and drops empties", () => {
		expect(normalizeQueries(["  a  ", "", "b  "])).toEqual({
			queries: ["a", "b"],
			dropped: 1,
		});
	});

	test("dedupes case-insensitively while preserving first casing", () => {
		expect(normalizeQueries(["Foo", "foo", "FOO", "bar"])).toEqual({
			queries: ["Foo", "bar"],
			dropped: 2,
		});
	});

	test("caps at four queries and reports dropped", () => {
		const input = ["1", "2", "3", "4", "5"];
		expect(normalizeQueries(input)).toEqual({
			queries: ["1", "2", "3", "4"],
			dropped: 1,
		});
	});

	test("counts all dropped sources including cap, empties, and duplicates", () => {
		expect(
			normalizeQueries(["", "a", "  a  ", "b", "c", "d", "e", "f"]),
		).toEqual({
			queries: ["a", "b", "c", "d"],
			dropped: 4,
		});
	});
});

describe("sliceBounded", () => {
	test("slices at offset", () => {
		expect(sliceBounded("abcdefghijklmnopqrstuvwxyz", 2)).toBe(
			"cdefghijklmnopqrstuvwxyz",
		);
	});

	test("applies maxCharacters", () => {
		expect(sliceBounded("abcdefghijklmnopqrstuvwxyz", 0, 5)).toBe("abcde");
	});

	test("combines offset and maxCharacters", () => {
		expect(sliceBounded("abcdefghijklmnopqrstuvwxyz", 2, 5)).toBe("cdefg");
	});

	test("clamps negative offset to zero", () => {
		expect(sliceBounded("abc", -5, 2)).toBe("ab");
	});

	test("does not error when bounds exceed text length", () => {
		expect(sliceBounded("hi", 0, 1_000)).toBe("hi");
	});
});

describe("assessSupport", () => {
	test("returns missing-evidence for empty content", () => {
		const r = assessSupport("Rust is fast", "");
		expect(r.assessment).toBe("missing-evidence");
		expect(r.heuristic).toBe(true);
	});

	test("returns supported when most claim tokens appear", () => {
		const r = assessSupport("Rust is fast", "Benchmarks confirm Rust is fast.");
		expect(r.assessment).toBe("supported");
		expect(r.heuristic).toBe(true);
		expect(r.excerpt).toBeTruthy();
	});

	test("returns unclear when few tokens match", () => {
		const r = assessSupport(
			"Rust is fast",
			"Politics today is wild and unexpected.",
		);
		expect(r.assessment).toBe("unclear");
		expect(r.heuristic).toBe(true);
	});

	test("returns contradicted when negation appears near matched tokens", () => {
		const r = assessSupport(
			"Rust is fast",
			"Some say Rust is fast, but the team denies rust is fast.",
		);
		expect(r.assessment).toBe("contradicted");
		expect(r.heuristic).toBe(true);
		expect(r.excerpt.toLowerCase()).toContain("denies");
		expect(r.citations.length).toBeGreaterThan(0);
		for (const cite of r.citations) {
			expect(r.assessment).toBe("contradicted"); // sanity
			expect(cite.toLowerCase()).toContain("denies");
		}
	});

	test("populates citations with supporting sentences on supported path", () => {
		const content =
			"Benchmarks confirm Rust is fast. Many teams chose Rust because it is fast.";
		const r = assessSupport("Rust is fast", content);
		expect(r.assessment).toBe("supported");
		expect(r.citations.length).toBeGreaterThan(0);
		for (const cite of r.citations) {
			expect(content).toContain(cite);
		}
	});

	test("returns empty citations on missing-evidence", () => {
		const r = assessSupport("Rust is fast", "");
		expect(r.assessment).toBe("missing-evidence");
		expect(r.citations).toEqual([]);
	});

	test("unclear path includes the single most relevant sentence when any tokens match", () => {
		const content = "We discussed rust briefly, not politics.";
		const r = assessSupport("Rust is fast", content);
		expect(r.assessment).toBe("unclear");
		expect(r.citations).toEqual([content]);
	});

	test("does not throw for claim tokens containing regex metacharacters", () => {
		expect(() =>
			assessSupport("a.*b(c)[", "Nothing matches that."),
		).not.toThrow();
	});
});

describe("web_search execute", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	function lastBody(index = 0): Record<string, unknown> {
		const init = fetchMock.mock.calls[index][1] as { body: string };
		return JSON.parse(init.body);
	}

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubEnv("JINA_API_KEY", "test-key");
		fetchMock = vi.fn(() =>
			Promise.resolve(new Response("mock result", { status: 200 })),
		);
		vi.stubGlobal("fetch", fetchMock);
	});

	test("errors when key is missing", async () => {
		vi.stubEnv("JINA_API_KEY", undefined);
		const res = asResult(
			await webSearchTool.execute(
				"c1",
				{ queries: ["foo"] },
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toBe("Jina search requires JINA_API_KEY.");
	});

	test("fetches once per normalized query", async () => {
		const res = asResult(
			await webSearchTool.execute(
				"c1",
				{ queries: ["q1", "  q2  ", ""] },
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(lastBody(0)).toEqual({ q: "q1" });
		expect(lastBody(1)).toEqual({ q: "q2" });
		expect(textOf(res)).toContain("## q1");
		expect(textOf(res)).toContain("## q2");
		expect(textOf(res)).toContain("note: dropped 1 extra queries (max 4)");
	});

	test("passes site and maxResults through, ignores workflow", async () => {
		await webSearchTool.execute(
			"c1",
			{
				queries: ["x"],
				site: "example.com",
				maxResults: 7,
				workflow: "ignored",
			},
			undefined,
			undefined,
			fakeCtx() as never,
		);

		expect(lastBody(0)).toEqual({
			q: "x",
			site: "example.com",
			max_num_results: 7,
		});
	});
});

describe("fetch_content execute", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubEnv("JINA_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					new Response("abcdefghijklmnopqrstuvwxyz", { status: 200 }),
				),
			),
		);
	});

	test("errors on invalid url", async () => {
		const res = asResult(
			await fetchContentTool.execute(
				"c1",
				{ url: "not-a-url" },
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toContain("Invalid URL");
	});

	test("applies offset and maxCharacters slicing", async () => {
		const res = asResult(
			await fetchContentTool.execute(
				"c1",
				{ url: "https://example.com/page", offset: 2, maxCharacters: 5 },
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);

		expect(textOf(res)).toBe("cdefg");
	});
});

describe("get_search_content execute", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubEnv("JINA_API_KEY", "test-key");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("short", { status: 200 }))),
		);
	});

	test("errors on non-url id with hint", async () => {
		const res = asResult(
			await getSearchContentTool.execute(
				"c1",
				{ url: "some-result-id" },
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);
		expect(res.isError).toBe(true);
		expect(textOf(res)).toBe(
			"get_search_content takes a source URL; pass the URL of the stored result",
		);
	});
});

describe("source_check execute", () => {
	test("supported path from content", async () => {
		const res = asResult(
			await sourceCheckTool.execute(
				"c1",
				{
					claim: "Rust is fast",
					content: "Benchmarks confirm Rust is fast.",
				},
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);
		expect(textOf(res)).toContain("Assessment: supported");
		expect(textOf(res)).toContain("heuristic: true");
	});

	test("unclear path when content does not match", async () => {
		const res = asResult(
			await sourceCheckTool.execute(
				"c1",
				{
					claim: "Rust is fast",
					content: "Today in politics: surprises everywhere.",
				},
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);
		expect(textOf(res)).toContain("Assessment: unclear");
	});

	test("missing-evidence when neither url nor content provided", async () => {
		const res = asResult(
			await sourceCheckTool.execute(
				"c1",
				{ claim: "Something happened" },
				undefined,
				undefined,
				fakeCtx() as never,
			),
		);
		expect(textOf(res)).toContain("Assessment: missing-evidence");
	});
});

describe("aliasTools export", () => {
	test("contains all four convention tools", () => {
		expect(aliasTools.map((t) => t.name)).toEqual([
			"web_search",
			"fetch_content",
			"get_search_content",
			"source_check",
		]);
	});
});
