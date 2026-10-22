import { describe, expect, it } from "vitest";
import { renderDashboard } from "../dashboard.js";

describe("renderDashboard", () => {
	it("shows a plain empty state", () => {
		const text = renderDashboard([], []);
		expect(text).toContain("No items yet");
		expect(text).toContain("current state");
	});

	it("lists items with kind, status, and counts", () => {
		const text = renderDashboard(
			[
				{
					id: "spec-0001",
					kind: "spec",
					title: "User authentication",
					status: "approved",
					body: "",
					path_scope: null,
					phase: null,
					parallel: 0,
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: "2026-01-02T00:00:00.000Z",
				},
			],
			[{ kind: "spec", status: "approved", n: 1 }],
		);
		expect(text).toContain("spec-0001");
		expect(text).toContain("User authentication");
		expect(text).toContain("approved");
		expect(text).toContain("spec/approved: 1");
	});

	it("marks paused items with their capsule state", () => {
		const text = renderDashboard(
			[
				{
					id: "task-0001",
					kind: "task",
					title: "Add login route",
					status: "in-progress",
					body: "",
					path_scope: "src/auth/**",
					phase: "story",
					parallel: 1,
					created_at: "2026-01-01T00:00:00.000Z",
					updated_at: "2026-01-02T00:00:00.000Z",
				},
			],
			[{ kind: "task", status: "in-progress", n: 1 }],
			["task-0001"],
		);
		expect(text).toContain("paused");
		expect(text).toContain("capsule ready");
	});
});
