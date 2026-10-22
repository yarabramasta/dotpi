import { describe, expect, it } from "vitest";
import type { TaskExport } from "../backends/contract.js";
import type { GhRunner } from "../backends/gh.js";
import { createGithubAdapter } from "../backends/github.js";
import { createNullSink } from "../backends/null.js";

const TASK: TaskExport = {
	ref: "task-0001",
	title: "Add login route",
	body: "## Task\n\nPOST /login returns a session.\n\n## Spec reference\n\nspec-0001 — Auth",
	labels: ["specd", "spec:auth"],
};

/** The github adapter must implement the optional contract methods; this
 * narrows the optional member once instead of asserting at each call site. */
function requirePlaceInLane(sink: {
	placeInLane?: (externalRef: string, lane: string) => Promise<void>;
}): (externalRef: string, lane: string) => Promise<void> {
	if (!sink.placeInLane) {
		throw new Error("adapter does not implement placeInLane");
	}
	return sink.placeInLane;
}

describe("null sink (vendor-neutral floor)", () => {
	it("exports natively with the task id as ref", async () => {
		const sink = createNullSink();
		expect(await sink.isConfigured()).toBe(true);
		const created = await sink.createTask(TASK);
		expect(created.externalRef).toBe("task-0001");
		expect(created.url).toBe("");
		expect((await sink.readBack("task-0001")).state).toBe("native");
	});
});

describe("github reference adapter (contract freeze)", () => {
	function fakeRunner(log: string[][]): GhRunner {
		return async (args) => {
			log.push([...args]);
			const joined = args.join(" ");
			if (joined.startsWith("issue create")) {
				return {
					stdout: "https://github.com/acme/app/issues/42\n",
					stderr: "",
				};
			}
			if (joined.startsWith("issue view") && joined.includes("state")) {
				return { stdout: '{"state":"closed"}', stderr: "" };
			}
			if (joined.startsWith("issue view") && joined.includes("url")) {
				return {
					stdout: '{"url":"https://github.com/acme/app/issues/42"}',
					stderr: "",
				};
			}
			if (joined.startsWith("project view")) {
				return { stdout: '{"id":"PROJECT_ID_1"}', stderr: "" };
			}
			if (joined.startsWith("project item-add")) {
				return { stdout: '{"id":"ITEM_ID_1"}', stderr: "" };
			}
			if (joined.startsWith("project field-list")) {
				return {
					stdout:
						'{"fields":[{"name":"Status","id":"FIELD_ID_1","options":[{"id":"OPT_TODO","name":"Todo"},{"id":"OPT_MVP","name":"MVP"}]}]}',
					stderr: "",
				};
			}
			return { stdout: "{}", stderr: "" };
		};
	}

	it("creates an issue with title, body, and idempotent labels", async () => {
		const log: string[][] = [];
		const sink = createGithubAdapter("/repo", undefined, fakeRunner(log));
		const created = await sink.createTask(TASK);
		expect(created).toEqual({
			externalRef: "42",
			url: "https://github.com/acme/app/issues/42",
		});
		const labelCalls = log.filter((a) => a[0] === "label");
		expect(labelCalls.map((a) => a[2])).toEqual(["specd", "spec:auth"]);
		const createCall = log.find((a) => a[0] === "issue");
		expect(createCall).toContain("--title");
		expect(createCall).toContain("Add login route");
		expect(createCall?.includes("--label")).toBe(true);
	});

	it("surfaces a plain error when issue create returns no URL", async () => {
		const sink = createGithubAdapter("/repo", undefined, async () => ({
			stdout: "nothing useful",
			stderr: "",
		}));
		await expect(sink.createTask(TASK)).rejects.toThrow(
			/did not return an issue URL/,
		);
	});

	it("maps read-back state from gh json", async () => {
		const sink = createGithubAdapter("/repo", undefined, fakeRunner([]));
		expect((await sink.readBack("42")).state).toBe("closed");
	});

	it("places an issue in a lane via the project status field", async () => {
		const log: string[][] = [];
		const sink = createGithubAdapter(
			"/repo",
			{ owner: "acme", projectNumber: 7 },
			fakeRunner(log),
		);
		await requirePlaceInLane(sink)("42", "MVP");
		const edit = log.find((a) => a[0] === "project" && a[1] === "item-edit");
		expect(edit).toContain("PROJECT_ID_1");
		expect(edit).toContain("FIELD_ID_1");
		expect(edit).toContain("OPT_MVP");
	});

	it("refuses lane placement with a plain error when the lane is unknown", async () => {
		const sink = createGithubAdapter(
			"/repo",
			{ owner: "acme", projectNumber: 7 },
			fakeRunner([]),
		);
		await expect(requirePlaceInLane(sink)("42", "Nope")).rejects.toThrow(
			/Lane "Nope" not found/,
		);
	});

	it("refuses lane placement without configured project", async () => {
		const sink = createGithubAdapter("/repo", undefined, fakeRunner([]));
		await expect(requirePlaceInLane(sink)("42", "MVP")).rejects.toThrow(
			/needs a configured project/,
		);
	});
});
