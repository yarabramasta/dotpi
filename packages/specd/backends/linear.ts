import type { SpecdStore } from "../store/store.js";
import { readSinkConfig } from "./config.js";
import type {
	SinkSetup,
	SinkAdapter,
	SinkVerify,
	TaskCreated,
	TaskExport,
} from "./contract.js";
import { sinkCredentials } from "./credentials.js";
import {
	type HttpRunner,
	httpError,
	parseBody,
	realHttpRunner,
} from "./http.js";

export interface LinearSinkConfig {
	/** The Linear team whose workflow states and issues this sink uses. */
	teamId: string;
	/** specd item status → the sink's workflow state name (D15);
	 * updateStatus maps through it; unmapped states pass through. */
	statusMap?: Record<string, string>;
	/** Optional: the Linear project to assign created issues to. */
	projectId?: string;
}

const ENDPOINT = "https://api.linear.app/graphql";

/** The Linear adapter — GraphQL, single endpoint, API-key auth WITHOUT the
 * Bearer prefix (OAuth tokens take Bearer; API keys take the bare key).
 * Lanes = team workflow states, tags = issue labels. */
export function createLinearAdapter(
	config: LinearSinkConfig | undefined,
	run: HttpRunner = realHttpRunner,
): SinkAdapter {
	const creds = sinkCredentials("linear");
	const key = creds.present.key;

	async function gql<T>(
		query: string,
		variables?: Record<string, unknown>,
	): Promise<T> {
		const res = await run({
			method: "POST",
			url: ENDPOINT,
			headers: { Authorization: key },
			body: { query, variables },
		});
		if (res.status >= 400) throw httpError("Linear API request", res);
		// Linear (like GraphQL generally) can answer 200 with errors[].
		const parsed = parseBody<{
			data?: T;
			errors?: Array<{ message?: string }>;
		}>(res);
		if (parsed?.errors?.length) {
			throw new Error(
				`Linear API error: ${parsed.errors[0]?.message ?? "unknown"}`,
			);
		}
		return parsed?.data as T;
	}

	async function stateIdFor(lane: string): Promise<string> {
		const data = await gql<{
			workflowStates?: { nodes?: Array<{ id: string; name: string }> };
		}>(
			"query($team: ID!) { workflowStates(filter: { team: { id: { eq: $team } } }) { nodes { id name } } }",
			{ team: config?.teamId ?? "" },
		);
		const state = data?.workflowStates?.nodes?.find(
			(s) => s.name.toLowerCase() === lane.toLowerCase(),
		);
		if (!state) {
			throw new Error(
				`Linear workflow state "${lane}" not found on team ${config?.teamId}. Apply the sink setup (/spec sink) first.`,
			);
		}
		return state.id;
	}

	/** Linear: resolve label ids, creating any that don't exist yet — the
	 * github reference adapter ensures labels per export (spec:slug labels
	 * appear with the first export), so ports must too. */
	async function ensureLabelIds(labels: string[]): Promise<string[]> {
		if (labels.length === 0) return [];
		const data = await gql<{
			issueLabels?: { nodes?: Array<{ id: string; name: string }> };
		}>("query { issueLabels(first: 250) { nodes { id name } } }");
		const known = new Map(
			(data?.issueLabels?.nodes ?? []).map((l) => [l.name.toLowerCase(), l.id]),
		);
		for (const label of labels) {
			if (known.has(label.toLowerCase())) continue;
			const res = await gql<{ issueLabel?: { id?: string } }>(
				`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }`,
				{ input: { name: label, teamId: config?.teamId } },
			);
			if (res?.issueLabel?.id) {
				known.set(label.toLowerCase(), res.issueLabel.id);
			}
		}
		return labels
			.map((l) => known.get(l.toLowerCase()))
			.filter((id): id is string => Boolean(id));
	}

	return {
		id: "linear",

		isConfigured(): Promise<boolean> {
			return Promise.resolve(Boolean(key && config?.teamId));
		},

		async verify(): Promise<SinkVerify> {
			try {
				if (!key) {
					return {
						ok: false,
						detail:
							"LINEAR_API_KEY not set (env or ~/.pi/agent/auth.json) — /spec connect linear.",
					};
				}
				const data = await gql<{
					team?: { id?: string; name?: string };
				}>("query($id: String!) { team(id: $id) { id name } }", {
					id: config?.teamId ?? "",
				});
				return {
					ok: Boolean(data?.team?.id),
					detail: data?.team?.name
						? `API key works; team "${data.team.name}" reachable.`
						: `Team ${config?.teamId} not reachable with this key.`,
				};
			} catch (error) {
				return {
					ok: false,
					detail: `Linear is not reachable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async createTask(task: TaskExport): Promise<TaskCreated> {
			if (!config?.teamId) {
				throw new Error(
					"Linear sink needs a team id — set it in the sink setup (/spec sink).",
				);
			}
			const labelIds = await ensureLabelIds(task.labels);
			const data = await gql<{
				issueCreate?: {
					success?: boolean;
					issue?: { identifier?: string; url?: string };
				};
			}>(
				`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`,
				{
					input: {
						teamId: config.teamId,
						title: task.title,
						description: task.body,
						...(labelIds.length > 0 ? { labelIds } : {}),
						...(config.projectId ? { projectId: config.projectId } : {}),
					},
				},
			);
			const issue = data?.issueCreate?.issue;
			if (!data?.issueCreate?.success || !issue?.identifier || !issue.url) {
				throw new Error("Linear issueCreate did not return an issue.");
			}
			return { externalRef: issue.identifier, url: issue.url };
		},

		async readBack(externalRef: string): Promise<{ state: string }> {
			const data = await gql<{
				issue?: { state?: { type?: string; name?: string } };
			}>("query($id: String!) { issue(id: $id) { state { type name } } }", {
				id: externalRef,
			});
			const type = data?.issue?.state?.type;
			return {
				state: type === "completed" || type === "canceled" ? "closed" : "open",
			};
		},

		async placeInLane(externalRef: string, lane: string): Promise<void> {
			const stateId = await stateIdFor(lane);
			await gql(
				`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
				{ id: externalRef, input: { stateId } },
			);
		},

		async updateStatus(externalRef: string, state: string): Promise<void> {
			const mapped = config?.statusMap?.[state] ?? state;
			return this.placeInLane?.(externalRef, mapped);
		},

		async setTags(externalRef: string, tags: string[]): Promise<void> {
			const labelIds = await ensureLabelIds(tags);
			await gql(
				`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
				{ id: externalRef, input: { labelIds } },
			);
		},

		async previewPlan(plan: SinkSetup): Promise<string[]> {
			if (!config?.teamId) {
				throw new Error(
					"Linear sink needs a team id before planning — set it in the sink setup interview.",
				);
			}
			const [labels, states] = await Promise.all([
				gql<{ issueLabels?: { nodes?: Array<{ name: string }> } }>(
					"query { issueLabels(first: 250) { nodes { name } } }",
				),
				gql<{ workflowStates?: { nodes?: Array<{ name: string }> } }>(
					"query($team: ID!) { workflowStates(filter: { team: { id: { eq: $team } } }) { nodes { name } } }",
					{ team: config.teamId },
				),
			]);
			const haveLabels = new Set(
				(labels?.issueLabels?.nodes ?? []).map((l) => l.name.toLowerCase()),
			);
			const haveStates = new Set(
				(states?.workflowStates?.nodes ?? []).map((s) => s.name.toLowerCase()),
			);
			const changes: string[] = [];
			for (const label of plan.labels) {
				if (!haveLabels.has(label.toLowerCase()))
					changes.push(`create label "${label}"`);
			}
			for (const lane of plan.lanes) {
				if (!haveStates.has(lane.toLowerCase()))
					changes.push(`create workflow state "${lane}"`);
			}
			return changes;
		},

		async ensurePlan(plan: SinkSetup): Promise<string[]> {
			// Empty-kanban rule: a workspace without the structure is
			// bootstrapped, not refused.
			const changes: string[] = [];
			const before = await this.previewPlan?.(plan);
			for (const change of before ?? []) {
				const label = /create label "(.+)"/.exec(change)?.[1];
				const lane = /create workflow state "(.+)"/.exec(change)?.[1];
				if (label) {
					await gql(
						`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`,
						{ input: { name: label, teamId: config?.teamId } },
					);
					changes.push(`created label "${label}"`);
				} else if (lane) {
					await gql(
						`mutation($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success } }`,
						{
							input: { name: lane, teamId: config?.teamId, type: "unstarted", color: "#5e6ad2" },
						},
					);
					changes.push(`created workflow state "${lane}"`);
				}
			}
			return changes;
		},
	};
}

/** Build the Linear sink config from the stored sink setup / sink config. */
export function linearConfigFrom(
	store: SpecdStore,
): LinearSinkConfig | undefined {
	const raw = readSinkConfig(store, "sink.linear");
	if (!raw?.teamId) return undefined;
	return {
		teamId: String(raw.teamId),
		projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
	};
}
