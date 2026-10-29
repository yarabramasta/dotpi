import { describe, expect, it } from "vitest";
import { boardOption, pendingMergeBranch } from "../src/sinks/sync.js";

const ev = (type: string, payload = "{}") => ({ type, payload });
const MAP = {
	exported: "Ready",
	"in-progress": "In progress",
	done: "Done",
};

describe("boardOption (done + open PR sits in the review lane)", () => {
	it("maps statuses through the statusMap", () => {
		expect(boardOption("in-progress", [ev("work.started")], MAP)).toBe(
			"In progress",
		);
	});

	it("done without a PR maps to the done lane", () => {
		expect(boardOption("done", [ev("work.completed")], MAP)).toBe("Done");
	});

	it("done with an open PR maps to the review lane", () => {
		expect(
			boardOption(
				"done",
				[ev("pr.created", '{"branch":"b"}'), ev("work.completed")],
				MAP,
			),
		).toBe("In review");
	});

	it("pr.merged ends the review detour — done maps normally", () => {
		expect(
			boardOption(
				"done",
				[ev("pr.created"), ev("work.completed"), ev("pr.merged")],
				MAP,
			),
		).toBe("Done");
	});

	it("honors the in-review override", () => {
		expect(
			boardOption("done", [ev("pr.created"), ev("work.completed")], {
				...MAP,
				"in-review": "CR",
			}),
		).toBe("CR");
	});

	it("unmapped statuses pass through as the option name", () => {
		expect(boardOption("draft", [], MAP)).toBe("draft");
	});
});

describe("pendingMergeBranch (merge reconcile trigger)", () => {
	it("returns the branch for a done task with an open PR", () => {
		const events = [
			ev("pr.created", '{"branch":"specd/task/task-0001-fix"}'),
			ev("work.completed"),
		];
		expect(pendingMergeBranch(events)).toBe("specd/task/task-0001-fix");
	});

	it("returns undefined before completion", () => {
		expect(
			pendingMergeBranch([ev("pr.created", '{"branch":"b"}')]),
		).toBeUndefined();
	});

	it("returns undefined once pr.merged is recorded (poll-stop marker)", () => {
		expect(
			pendingMergeBranch([
				ev("pr.created", '{"branch":"b"}'),
				ev("work.completed"),
				ev("pr.merged"),
			]),
		).toBeUndefined();
	});

	it("returns undefined without a PR or a branch in the payload", () => {
		expect(pendingMergeBranch([ev("work.completed")])).toBeUndefined();
		expect(
			pendingMergeBranch([ev("pr.created"), ev("work.completed")]),
		).toBeUndefined();
	});
});
