import { parseJsonLoose } from "../store/store.js";
import type {
	ProjectPlan,
	SinkAdapter,
	SinkVerify,
	TaskCreated,
	TaskExport,
} from "./contract.js";
import { type GhRunner, type GithubSinkConfig, realGhRunner } from "./gh.js";

interface StatusFieldRow {
	id?: string;
	name?: string;
	options?: Array<{
		id?: string;
		name?: string;
		color?: string;
		description?: string;
	}>;
}

type Gh = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

async function statusField(
	gh: Gh,
	owner: string,
	number: string,
): Promise<StatusFieldRow | undefined> {
	// GraphQL responses wrap everything in { data: ... }; navigating from
	// the root skips that wrapper is the most common statusField bug.
	const data = parseJsonLoose<{
		data?: { organization?: { projectV2?: { field?: StatusFieldRow } } };
	}>(
		(
			await gh([
				"api",
				"graphql",
				"-f",
				`query=${STATUS_FIELD_QUERY}`,
				"-f",
				`login=${owner}`,
				"-F",
				`number=${number}`,
			])
		).stdout,
	);
	return data?.data?.organization?.projectV2?.field;
}

async function projectIdFor(
	gh: Gh,
	owner: string,
	number: string,
): Promise<string> {
	const view = parseJsonLoose<{ id?: string }>(
		(
			await gh([
				"project",
				"view",
				number,
				"--owner",
				owner,
				"--format",
				"json",
			])
		).stdout,
	);
	if (!view?.id) {
		throw new Error(
			`Could not resolve project #${number} for owner ${owner}. Check the project config.`,
		);
	}
	return view.id;
}

/** Full Status-field options via GraphQL: gh project field-list CLI omits
 * color/description, but the mutation requires them. GraphQL is the only
 * authoritative source. */
const STATUS_FIELD_QUERY = `query($login: String!, $number: Int!) {
	organization(login: $login) {
		projectV2(number: $number) {
			field(name: "Status") {
				... on ProjectV2SingleSelectField { id name options { id name color description } }
			}
		}
	}
}`;

/** updateProjectV2Field replaces the whole options list — callers must pass
 * every existing option (with ids) plus the new ones. color is a GraphQL
 * ENUM (bare identifier, no quotes); description is a required String
 * (empty string is fine). Options are inlined as GraphQL input-object
 * literals because gh -F does not parse JSON arrays of objects and the
 * runner cannot pipe stdin. */
const OPTION_ENUM_FIELDS = new Set(["color"]);
function updateOptionsMutation(
	fieldId: string,
	options: Array<Record<string, unknown>>,
): string {
	const literal = (o: Record<string, unknown>): string => {
		const parts: string[] = [];
		for (const [k, v] of Object.entries(o)) {
			if (v === undefined) continue;
			// Drop empty values for enum fields (nonsense) but keep them
			// for required strings like description (empty is allowed).
			if (typeof v === "string" && v === "" && OPTION_ENUM_FIELDS.has(k))
				continue;
			parts.push(
				`${k}: ${OPTION_ENUM_FIELDS.has(k) ? String(v) : JSON.stringify(v)}`,
			);
		}
		return `{ ${parts.join(", ")} }`;
	};
	return `mutation {
	updateProjectV2Field(input: { fieldId: ${JSON.stringify(fieldId)}, singleSelectOptions: [${options
		.map(literal)
		.join(", ")}] }) {
		projectV2Field { ... on ProjectV2SingleSelectField { options { id name } } }
	}
}`;
}

/** Empty-kanban bootstrap: create the Status field with the plan's lanes
 * as options on a workspace that has none. Same option-literal rules as
 * updateOptionsMutation (color is a GraphQL enum, description a string). */
function createStatusFieldMutation(projectId: string, lanes: string[]): string {
	const options = lanes
		.map((name) => {
			const parts = Object.entries({
				name,
				color: DEFAULT_OPTION.color,
				description: DEFAULT_OPTION.description,
			})
				.map(
					([k, v]) =>
						`${k}: ${OPTION_ENUM_FIELDS.has(k) ? String(v) : JSON.stringify(v)}`,
				)
				.join(", ");
			return `{ ${parts} }`;
		})
		.join(", ");
	return `mutation {
	createProjectV2Field(input: { projectId: ${JSON.stringify(projectId)}, dataType: SINGLE_SELECT, name: "Status", singleSelectOptions: [${options}] }) {
		projectV2Field { ... on ProjectV2SingleSelectField { id name options { name } } }
	}
}`;
}

/** Default color/description for a brand-new option; existing options keep
 * the values GraphQL returned for them. */
const DEFAULT_OPTION = { color: "GRAY", description: "" } as const;

/** The GitHub reference adapter — the implementation that freezes the sink
 * contract (M1). Everything runs through the gh CLI: issues via the REST
 * surface, Projects v2 placement via gh's project commands, read-back via
 * issue state. The runner is injectable so contract tests run offline. */
export function createGithubAdapter(
	cwd: string,
	config: GithubSinkConfig | undefined,
	run: GhRunner = realGhRunner,
): SinkAdapter {
	const gh = (args: string[]) => run(args, cwd);

	async function ensureLabels(labels: string[]): Promise<void> {
		for (const label of labels) {
			try {
				await gh(["label", "create", label]);
			} catch {
				// label likely exists already — idempotent by intent
			}
		}
	}

	return {
		id: "github",

		async isConfigured(): Promise<boolean> {
			try {
				await gh(["auth", "status"]);
				return true;
			} catch {
				return false;
			}
		},

		async verify(): Promise<SinkVerify> {
			try {
				await gh(["auth", "status"]);
				const repo = parseJsonLoose<{ name?: string }>(
					(await gh(["repo", "view", "--json", "name"])).stdout,
				);
				return {
					ok: true,
					detail: `gh authenticated; repo ${repo?.name ?? "resolved"} reachable.`,
				};
			} catch (error) {
				return {
					ok: false,
					detail: `GitHub is not reachable: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},

		async createTask(task: TaskExport): Promise<TaskCreated> {
			await ensureLabels(task.labels);
			const args = [
				"issue",
				"create",
				"--title",
				task.title,
				"--body",
				task.body,
			];
			for (const label of task.labels) {
				args.push("--label", label);
			}
			const result = await gh(args);
			const url = result.stdout.trim().split("\n").at(-1) ?? "";
			if (!url.startsWith("http")) {
				throw new Error(
					`gh issue create did not return an issue URL. Output: ${result.stdout} ${result.stderr}`,
				);
			}
			const externalRef = url.split("/issues/").at(-1) ?? "";
			return { externalRef, url };
		},

		async readBack(externalRef: string): Promise<{ state: string }> {
			const result = await gh([
				"issue",
				"view",
				externalRef,
				"--json",
				"state",
			]);
			const parsed = parseJsonLoose<{ state?: string }>(result.stdout);
			return { state: parsed?.state ?? "unknown" };
		},

		async placeInLane(externalRef: string, lane: string): Promise<void> {
			if (!config?.owner || !config.projectNumber) {
				throw new Error(
					"GitHub Projects placement needs a configured project (owner + project number). Run the export setup first.",
				);
			}
			const owner = config.owner;
			const number = String(config.projectNumber);
			const projectId = await projectIdFor(gh, owner, number);
			// Attach the issue to the project.
			const issueView = parseJsonLoose<{ url?: string }>(
				(await gh(["issue", "view", externalRef, "--json", "url"])).stdout,
			);
			const issueUrl = issueView?.url ?? "";
			if (!issueUrl) {
				throw new Error(`Could not resolve the issue URL for ${externalRef}.`);
			}
			const added = parseJsonLoose<{ id?: string }>(
				(
					await gh([
						"project",
						"item-add",
						number,
						"--owner",
						owner,
						"--url",
						issueUrl,
						"--format",
						"json",
					])
				).stdout,
			);
			const itemId = added?.id ?? "";
			if (!itemId) {
				throw new Error(
					`Could not attach ${externalRef} to project #${number}.`,
				);
			}
			const status = await statusField(gh, owner, number);
			const option = status?.options?.find((o) => o.name === lane);
			if (!status?.id || !option?.id) {
				throw new Error(
					`Lane "${lane}" not found on the project's Status field. Available options: ${(
						status?.options ?? []
					)
						.map((o) => o.name)
						.join(", ")}.`,
				);
			}
			await gh([
				"project",
				"item-edit",
				"--id",
				itemId,
				"--project-id",
				projectId,
				"--field-id",
				status.id,
				"--single-select-option-id",
				option.id,
			]);
		},

		async previewPlan(plan: ProjectPlan): Promise<string[]> {
			const owner = String(plan.workspace.owner ?? "");
			const number = String(plan.workspace.projectNumber ?? "");
			if (!owner || !number) {
				throw new Error(
					"The project plan needs a workspace (owner + project number) to preview against.",
				);
			}
			const changes: string[] = [];
			const listed = parseJsonLoose<Array<{ name?: string }>>(
				(await gh(["label", "list", "--json", "name", "--limit", "500"]))
					.stdout,
			);
			const have = new Set((listed ?? []).map((l) => l.name));
			for (const label of plan.labels) {
				if (!have.has(label)) changes.push(`create label "${label}"`);
			}
			const status = await statusField(gh, owner, number);
			if (!status?.id) {
				// Empty-kanban rule: a workspace without the structure is
				// bootstrapped, not refused.
				changes.push(
					`create Status field with lanes: ${plan.lanes.join(", ")}`,
				);
				return changes;
			}
			const options = new Set((status.options ?? []).map((o) => o.name));
			for (const lane of plan.lanes) {
				if (!options.has(lane)) changes.push(`add Status option "${lane}"`);
			}
			return changes;
		},

		async ensurePlan(plan: ProjectPlan): Promise<string[]> {
			const owner = String(plan.workspace.owner ?? "");
			const number = String(plan.workspace.projectNumber ?? "");
			if (!owner || !number) {
				throw new Error(
					"The project plan needs a workspace (owner + project number) to apply against.",
				);
			}
			const changes: string[] = [];
			// Labels: list once, create only the missing ones.
			const listed = parseJsonLoose<Array<{ name?: string }>>(
				(await gh(["label", "list", "--json", "name", "--limit", "500"]))
					.stdout,
			);
			const have = new Set((listed ?? []).map((l) => l.name));
			for (const label of plan.labels) {
				if (!have.has(label)) {
					await gh(["label", "create", label]);
					changes.push(`created label "${label}"`);
				}
			}
			// Lanes: Status field options, read-modify-write via GraphQL.
			const status = await statusField(gh, owner, number);
			if (!status?.id) {
				// Empty-kanban rule: a workspace without the structure is
				// bootstrapped, not refused — create Status with the lanes.
				const projectId = await projectIdFor(gh, owner, number);
				await gh([
					"api",
					"graphql",
					"-f",
					`query=${createStatusFieldMutation(projectId, plan.lanes)}`,
				]);
				changes.push(
					`created Status field with lanes: ${plan.lanes.join(", ")}`,
				);
				return changes;
			}
			const existing = (status.options ?? []).map((o) => ({
				id: o.id,
				name: o.name,
				color: o.color ?? DEFAULT_OPTION.color,
				description: o.description ?? DEFAULT_OPTION.description,
			}));
			const names = new Set(existing.map((o) => o.name));
			const missing = plan.lanes
				.filter((lane) => !names.has(lane))
				.map((name) => ({ name, ...DEFAULT_OPTION }));
			const options = [...existing, ...missing];
			if (missing.length > 0) {
				await gh([
					"api",
					"graphql",
					"-f",
					`query=${updateOptionsMutation(status.id, options)}`,
				]);
				for (const { name } of missing)
					changes.push(`added Status option "${name}"`);
			}
			return changes;
		},
	};
}
