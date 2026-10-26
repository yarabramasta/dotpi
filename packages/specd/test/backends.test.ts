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
			if (joined.startsWith("api graphql")) {
				return {
					stdout: JSON.stringify({
						data: {
							organization: {
								projectV2: {
									field: {
										name: "Status",
										id: "FIELD_ID_1",
										options: [
											{
												id: "OPT_TODO",
												name: "Todo",
												color: "GRAY",
												description: "",
											},
											{
												id: "OPT_MVP",
												name: "MVP",
												color: "GRAY",
												description: "",
											},
										],
									},
								},
							},
						},
					}),
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
			/Status option "Nope" not found/,
		);
	});

	it("refuses lane placement without configured project", async () => {
		const sink = createGithubAdapter("/repo", undefined, fakeRunner([]));
		await expect(requirePlaceInLane(sink)("42", "MVP")).rejects.toThrow(
			/needs a configured project/,
		);
	});

	it("lands the issue on the board in the mapped workflow state at export (D15)", async () => {
		const log: string[][] = [];
		const sink = createGithubAdapter(
			"/repo",
			{ owner: "acme", projectNumber: 7, statusMap: { exported: "MVP" } },
			fakeRunner(log),
		);
		const created = await sink.createTask(TASK);
		expect(created.externalRef).toBe("42");
		expect(log.find((a) => a[0] === "project" && a[1] === "item-add")).toBeDefined();
		const edit = log.find((a) => a[0] === "project" && a[1] === "item-edit");
		expect(edit?.join(" ")).toContain("OPT_MVP");
	});

	it("updateStatus maps specd states through the plan statusMap (D15)", async () => {
		const log: string[][] = [];
		const sink = createGithubAdapter(
			"/repo",
			{
				owner: "acme",
				projectNumber: 7,
				statusMap: { done: "MVP", "in-progress": "Todo" },
			},
			fakeRunner(log),
		);
		await sink.updateStatus?.("42", "done");
		expect(
			log.find((a) => a[0] === "project" && a[1] === "item-edit")?.join(" "),
		).toContain("OPT_MVP");
		log.length = 0;
		await sink.updateStatus?.("42", "in-progress");
		expect(
			log.find((a) => a[0] === "project" && a[1] === "item-edit")?.join(" "),
		).toContain("OPT_TODO");
		// unmapped state passes through as the option name → absent → plain error
		await expect(sink.updateStatus?.("42", "blocked")).rejects.toThrow(
			/Status option "blocked" not found/,
		);
	});
});

describe("github project plan (preview + idempotent apply)", () => {
	/** A fake runner that simulates a workspace with one existing label
	 * ("specd") and two existing lanes ("Todo", "MVP") — so a plan with
	 * extra labels and lanes reports/creates only the missing ones. */
	function planRunner(state: {
		labelList: string[];
		options: Array<{
			id: string;
			name: string;
			color: string;
			description: string;
		}>;
		/** false simulates a not-onboarded (empty) workspace with no Status
		 * field at all — the empty-kanban bootstrap path. */
		hasStatusField?: boolean;
		/** Projects can be org- or user-owned; the status lookup must find
		 * the field under either owner kind. */
		ownerType?: "organization" | "user";
		graphqlCalls: string[];
	}): GhRunner {
		return async (args) => {
			const joined = args.join(" ");
			if (joined.startsWith("label list")) {
				return {
					stdout: JSON.stringify(state.labelList.map((name) => ({ name }))),
					stderr: "",
				};
			}
			if (joined.startsWith("label create")) {
				const name = args[2];
				state.labelList.push(name);
				return { stdout: "", stderr: "" };
			}
			if (joined.startsWith("project view")) {
				return { stdout: '{"id":"PROJECT_ID_1"}', stderr: "" };
			}
			// Discriminator: STATUS_FIELD_QUERY starts with "query($login:" —
			// mutations (update/create field) must NOT match this branch.
			if (
				joined.startsWith("api graphql") &&
				joined.includes("query($login:")
			) {
				const field =
					state.hasStatusField === false
						? null
						: {
								name: "Status",
								id: "FIELD_ID_1",
								options: state.options,
							};
				const ownerPath = state.ownerType === "user" ? "user" : "organization";
				return {
					stdout: JSON.stringify({
						data: { [ownerPath]: { projectV2: { field } } },
					}),
					stderr: "",
				};
			}
			if (
				joined.startsWith("api graphql") &&
				joined.includes("createProjectV2Field")
			) {
				state.graphqlCalls.push(args.join(" "));
				const queryArg = args.find((a) => a.startsWith("query="));
				const optionsBlock = queryArg?.match(
					/singleSelectOptions: \[([\s\S]*)\]/,
				);
				if (optionsBlock) {
					for (const m of optionsBlock[1].matchAll(/name: "([^"]+)"/g)) {
						const name = m[1];
						if (!state.options.some((o) => o.name === name)) {
							state.options.push({
								id: `OPT_${name}`,
								name,
								color: "GRAY",
								description: "",
							});
						}
					}
				}
				// The workspace now HAS the field — like real GitHub after the
				// mutation, so the next apply converges.
				state.hasStatusField = true;
				return { stdout: "{}", stderr: "" };
			}
			if (joined.startsWith("api graphql")) {
				state.graphqlCalls.push(args.join(" "));
				const queryArg = args.find((a) => a.startsWith("query="));
				const optionsBlock = queryArg?.match(
					/singleSelectOptions: \[([\s\S]*)\]/,
				);
				if (optionsBlock) {
					for (const m of optionsBlock[1].matchAll(/name: "([^"]+)"/g)) {
						const name = m[1];
						if (!state.options.some((o) => o.name === name)) {
							state.options.push({
								id: `OPT_${name}`,
								name,
								color: "GRAY",
								description: "",
							});
						}
					}
				}
				return { stdout: "{}", stderr: "" };
			}
			return { stdout: "{}", stderr: "" };
		};
	}

	const PLAN = {
		ref: "plan",
		title: "P",
		body: "",
		workspace: { owner: "acme", projectNumber: 7 },
		lanes: ["MVP", "V1", "maintenance"],
		labels: ["specd", "priority:high"],
		naming: "specd/{ref} {title}",
	};

	function requirePreview(sink: {
		previewPlan?: (plan: typeof PLAN) => Promise<string[]>;
	}) {
		if (!sink.previewPlan) throw new Error("no previewPlan");
		return sink.previewPlan;
	}
	function requireEnsure(sink: {
		ensurePlan?: (plan: typeof PLAN) => Promise<string[]>;
	}) {
		if (!sink.ensurePlan) throw new Error("no ensurePlan");
		return sink.ensurePlan;
	}

	it("previews missing labels and lanes without writing", async () => {
		const state = {
			labelList: ["specd"],
			options: [
				{ id: "OPT_TODO", name: "Todo", color: "GRAY", description: "" },
				{ id: "OPT_MVP", name: "MVP", color: "GRAY", description: "" },
			],
			graphqlCalls: [],
		};
		const sink = createGithubAdapter("/repo", undefined, planRunner(state));
		const changes = await requirePreview(sink)(PLAN);
		expect(changes).toContain('create label "priority:high"');
		expect(changes).toContain('add Status option "V1"');
		expect(changes).toContain('add Status option "maintenance"');
		expect(state.labelList).toEqual(["specd"]);
		expect(state.options).toHaveLength(2);
		expect(state.graphqlCalls).toHaveLength(0);
	});

	it("applies missing labels and lanes, then re-apply is idempotent", async () => {
		const state = {
			labelList: ["specd"],
			options: [
				{ id: "OPT_TODO", name: "Todo", color: "GRAY", description: "" },
				{ id: "OPT_MVP", name: "MVP", color: "GRAY", description: "" },
			],
			graphqlCalls: [],
		};
		const sink = createGithubAdapter("/repo", undefined, planRunner(state));
		const first = await requireEnsure(sink)(PLAN);
		expect(first).toContain('created label "priority:high"');
		expect(first).toContain('added Status option "V1"');
		expect(first).toContain('added Status option "maintenance"');
		expect(state.labelList).toContain("priority:high");
		expect(state.options.map((o) => o.name)).toContain("V1");
		expect(state.graphqlCalls).toHaveLength(1);

		const second = await requireEnsure(sink)(PLAN);
		expect(second).toEqual([]);
		expect(state.graphqlCalls).toHaveLength(1);
	});

	it("finds the Status field on user-owned projects too (no duplicate bootstrap)", async () => {
		const state = {
			labelList: ["specd"],
			options: [{ id: "OPT_MVP", name: "MVP", color: "GRAY", description: "" }],
			ownerType: "user" as const,
			graphqlCalls: [] as string[],
		};
		const sink = createGithubAdapter("/repo", undefined, planRunner(state));
		// The field IS found via the user branch — only the genuinely missing
		// lanes are reported, never a duplicate Status-field creation.
		const changes = await requirePreview(sink)(PLAN);
		expect(changes).not.toContain("create Status field");
		expect(changes).toContain('add Status option "V1"');
		expect(await requireEnsure(sink)(PLAN)).toContain(
			'added Status option "V1"',
		);
	});

	it("parses the surviving leg when gh exits 1 on GraphQL errors (found live, P1.c)", async () => {
		// gh api graphql exits 1 whenever the response carries GraphQL errors
		// — one alias leg always misses — while the other leg's data is on
		// stdout. The runner rejects; statusField must still parse stdout.
		const state = {
			labelList: ["specd"],
			options: [
				{ id: "OPT_MVP", name: "MVP", color: "GRAY", description: "" },
			],
			ownerType: "organization" as const,
			graphqlCalls: [] as string[],
		};
		const base = planRunner(state);
		const exitOneRunner: GhRunner = async (args, cwd) => {
			const joined = args.join(" ");
			if (joined.startsWith("api graphql") && joined.includes("query($login:")) {
				const res = await base(args, cwd);
				const err = Object.assign(
					new Error(
						"Command failed: gh api graphql (GraphQL errors: NOT_FOUND on the user leg)",
					),
					{ stdout: res.stdout, code: 1 },
				);
				throw err;
			}
			return base(args, cwd);
		};
		const sink = createGithubAdapter("/repo", undefined, exitOneRunner);
		const changes = await requirePreview(sink)(PLAN);
		expect(changes).toContain('add Status option "V1"');
		expect(changes).not.toContain("create Status field");
	});

	it("degrades to the bootstrap path when BOTH owner legs miss", async () => {
		const state = {
			labelList: [],
			options: [],
			hasStatusField: false,
			ownerType: "user" as const,
			graphqlCalls: [] as string[],
		};
		const base = planRunner(state);
		const exitOneRunner: GhRunner = async (args, cwd) => {
			const joined = args.join(" ");
			if (joined.startsWith("api graphql") && joined.includes("query($login:")) {
				const err = Object.assign(
					new Error("Command failed: gh api graphql"),
					{ stdout: '{"data":{"organization":null,"user":null},"errors":[{"message":"NOT_FOUND"}]}', code: 1 },
				);
				throw err;
			}
			return base(args, cwd);
		};
		const sink = createGithubAdapter("/repo", undefined, exitOneRunner);
		const changes = await requirePreview(sink)(PLAN);
		expect(changes).toContain("create Status field with lanes: MVP, V1, maintenance");
	});

	it("bootstraps an empty workspace — creates the Status field with the plan lanes (empty-kanban rule)", async () => {
		const state = {
			labelList: [],
			options: [],
			hasStatusField: false,
			graphqlCalls: [] as string[],
		};
		const sink = createGithubAdapter("/repo", undefined, planRunner(state));

		// Preview reports the creation instead of punting to a web UI.
		expect(await requirePreview(sink)(PLAN)).toContain(
			"create Status field with lanes: MVP, V1, maintenance",
		);

		// Apply creates the field (no throw), then re-apply converges.
		const first = await requireEnsure(sink)(PLAN);
		expect(first).toContain(
			"created Status field with lanes: MVP, V1, maintenance",
		);
		const createCall = state.graphqlCalls.find((c) =>
			c.includes("createProjectV2Field"),
		);
		expect(createCall).toContain("MVP");
		expect(createCall).toContain("maintenance");
		expect(await requireEnsure(sink)(PLAN)).toEqual([]);
	});

	it("preserves existing option color/description on idempotent re-apply", async () => {
		const state = {
			labelList: ["specd"],
			options: [
				{ id: "OPT_TODO", name: "Todo", color: "BLUE", description: "kept" },
				{
					id: "OPT_MVP",
					name: "MVP",
					color: "PURPLE",
					description: "also kept",
				},
			],
			graphqlCalls: [],
		};
		const sink = createGithubAdapter("/repo", undefined, planRunner(state));
		await requireEnsure(sink)(PLAN);
		expect(state.options[0]?.color).toBe("BLUE");
		expect(state.options[0]?.description).toBe("kept");
		expect(state.options[1]?.color).toBe("PURPLE");
		expect(state.options[1]?.description).toBe("also kept");
	});

	it("null sink plan is always converged", async () => {
		const sink = createNullSink();
		expect(await sink.previewPlan?.(PLAN)).toEqual([]);
		expect(await sink.ensurePlan?.(PLAN)).toEqual([]);
	});
});
