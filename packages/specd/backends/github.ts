import { parseJsonLoose } from "../store/store.js";
import type {
	SinkSetup,
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
	// The query aliases both owner kinds (projects can be org- or
	// user-owned). gh api graphql EXITS 1 whenever the response carries
	// GraphQL errors — and one leg always misses (an org owner nulls the
	// user leg and vice versa) — even though the other leg's data is on
	// stdout. So: parse stdout regardless of the runner's exit code; only
	// when BOTH legs come back null does this degrade to "no Status
	// field", where the callers raise their plain-language errors.
	let stdout = "";
	try {
		({ stdout } = await gh([
			"api",
			"graphql",
			"-f",
			`query=${STATUS_FIELD_QUERY}`,
			"-f",
			`login=${owner}`,
			"-F",
			`number=${number}`,
		]));
	} catch (err) {
		// exec/execFile attach the child's captured stdout to the rejection.
		stdout = (err as { stdout?: string }).stdout ?? "";
	}
	const data = parseJsonLoose<{
		data?: {
			organization?: { projectV2?: { field?: StatusFieldRow } };
			user?: { projectV2?: { field?: StatusFieldRow } };
		};
	}>(stdout);
	return (
		data?.data?.organization?.projectV2?.field ??
		data?.data?.user?.projectV2?.field
	);
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
	user(login: $login) {
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
/** The template gate: a project created from a github template has
 * these fields and views. ensurePlan refuses if any are missing —
 * the owner should create the project from a template in the UI first
 * (dec-0016). */
const TEMPLATE_FIELDS = new Set([
	"Estimate",
	"Priority",
	"Size",
	"Start date",
	"Target date",
]);
const TEMPLATE_VIEWS = new Set([
	"Backlog",
	"Priority board",
	"Team items",
	"Roadmap",
	"My items",
]);

/** The 6 layer status options (dec-0016) — matching the platform board. */
const LAYER_STATUS_OPTIONS = [
	{ name: "Backlog", color: "GREEN", description: "This item hasn't been started" },
	{ name: "Ready", color: "BLUE", description: "This is ready to be picked up" },
	{ name: "In progress", color: "YELLOW", description: "This is actively being worked on" },
	{ name: "In review", color: "PURPLE", description: "This item is in review" },
	{ name: "Done", color: "ORANGE", description: "This has been completed" },
	{ name: "Blocked", color: "GRAY", description: "" },
] as const;

/** Validate the template gate: query the project's fields and views and
 * report any missing template pieces. Returns a list of missing items
 * (empty = the gate passes). */
async function templateGate(
	gh: Gh,
	owner: string,
	number: string,
): Promise<string[]> {
	const data = parseJsonLoose<{
		data?: {
			organization?: {
				projectV2?: {
					fields?: { nodes?: Array<{ name?: string; __typename?: string }> };
					views?: { nodes?: Array<{ name?: string }> };
				};
			};
		};
	}>(
		(
			await gh([
				"api",
				"graphql",
				"-f",
				`query=${QUERY_PROJECT_STRUCTURE}`,
				"-f",
				`login=${owner}`,
				"-F",
				`number=${number}`,
			])
		).stdout,
	);
	const project = data?.data?.organization?.projectV2;
	const fieldNames = new Set(
		(project?.fields?.nodes ?? [])
			.filter((f) => f?.name)
			.map((f) => f.name as string),
	);
	const viewNames = new Set(
		(project?.views?.nodes ?? []).filter((v) => v?.name).map((v) => v.name as string),
	);
	const missing: string[] = [];
	for (const f of TEMPLATE_FIELDS) {
		if (!fieldNames.has(f)) missing.push(`field "${f}"`);
	}
	for (const v of TEMPLATE_VIEWS) {
		if (!viewNames.has(v)) missing.push(`view "${v}"`);
	}
	return missing;
}

const QUERY_PROJECT_STRUCTURE = `query($login: String!, $number: Int!) {
	organization(login: $login) {
		projectV2(number: $number) {
			fields(first: 30) { nodes { ... on ProjectV2FieldCommon { name __typename } ... on ProjectV2SingleSelectField { name __typename } ... on ProjectV2Field { name __typename } } }
			views(first: 10) { nodes { name } }
		}
	}
}`;

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

	/** Attach the issue to the project board (idempotent per content) and
	 * return the project item id. */
	async function ensureInProject(externalRef: string): Promise<string> {
		if (!config?.owner || !config.projectNumber) {
			throw new Error(
				"GitHub Projects placement needs a configured project (owner + project number). Run the export setup first.",
			);
		}
		const number = String(config.projectNumber);
		const projectId = await projectIdFor(gh, config.owner, number);
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
					config.owner,
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
		return itemId;
	}

	/** Set the project item's Status field to the named option — the
	 * board's OWN workflow option (D15); case-insensitive match. */
	async function setWorkflowStatus(
		externalRef: string,
		optionName: string,
	): Promise<void> {
		if (!config?.owner || !config.projectNumber) {
			throw new Error(
				"GitHub Projects placement needs a configured project (owner + project number). Run the export setup first.",
			);
		}
		const number = String(config.projectNumber);
		const projectId = await projectIdFor(gh, config.owner, number);
		const itemId = await ensureInProject(externalRef);
		const status = await statusField(gh, config.owner, number);
		const option = status?.options?.find(
			(o) => (o.name ?? "").toLowerCase() === optionName.toLowerCase(),
		);
		if (!status?.id || !option?.id) {
			throw new Error(
				`Status option "${optionName}" not found on the project. Available: ${(
					status?.options ?? []
				)
					.map((o) => o.name ?? "")
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
			if (!externalRef) {
				throw new Error("gh issue create did not return an issue number.");
			}
			// Land the issue on the board in the mapped workflow state (D15);
			// lanes are the board's own columns and arrive via placeInLane.
			if (config?.projectNumber) {
				await ensureInProject(externalRef);
				const exportedAs = config.statusMap?.exported;
				if (exportedAs) await setWorkflowStatus(externalRef, exportedAs);
			}
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
			// Lanes are the board's workflow columns (Model B): the Status
			// option IS the lane.
			await setWorkflowStatus(externalRef, lane);
		},

		async updateStatus(externalRef: string, state: string): Promise<void> {
			const mapped = config?.statusMap?.[state] ?? state;
			await setWorkflowStatus(externalRef, mapped);
		},

		async previewPlan(plan: SinkSetup): Promise<string[]> {
			const owner = String(plan.workspace.owner ?? "");
			const number = String(plan.workspace.projectNumber ?? "");
			if (!owner || !number) {
				throw new Error(
					"The sink setup needs a workspace (owner + project number) to preview against.",
				);
			}
			// Template gate (dec-0016): refuse non-template projects.
			const gateMisses = await templateGate(gh, owner, number);
			if (gateMisses.length > 0) {
				throw new Error(
					`This project doesn't look like it was created from a github template — missing: ${gateMisses.join(", ")}. Create it from the GitHub UI first (New project → Choose the Kanban template), then re-run /spec sink.`,
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
			// statusMap targets (D15): verified against the board's own
			// options — never created.
			for (const [state, option] of Object.entries(plan.statusMap ?? {})) {
				if (!options.has(option))
					changes.push(
						`statusMap: option "${option}" (for ${state}) is missing on the board`,
					);
			}
			return changes;
		},

		async ensurePlan(plan: SinkSetup): Promise<string[]> {
			const owner = String(plan.workspace.owner ?? "");
			const number = String(plan.workspace.projectNumber ?? "");
			if (!owner || !number) {
				throw new Error(
					"The sink setup needs a workspace (owner + project number) to apply against.",
				);
			}
			// Template gate (dec-0016): refuse non-template projects.
			const gateMisses = await templateGate(gh, owner, number);
			if (gateMisses.length > 0) {
				throw new Error(
					`This project doesn't look like it was created from a github template — missing: ${gateMisses.join(", ")}. Create it from the GitHub UI first (New project → Choose the Kanban template), then re-run /spec sink.`,
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
			// Status customization (dec-0016): converge the 6 layer options
			// with the platform board's colors and descriptions.
			const options = LAYER_STATUS_OPTIONS.map((opt) => {
				const existingOpt = (status.options ?? []).find(
					(o) => o.name?.toLowerCase() === opt.name.toLowerCase(),
				);
				return {
					id: existingOpt?.id ?? "",
					name: opt.name,
					color: opt.color,
					description: opt.description,
				};
			});
			const needsUpdate = options.some(
				(opt) =>
					!(status.options ?? []).some(
						(o) =>
							o.name?.toLowerCase() === opt.name.toLowerCase() &&
							o.color === opt.color &&
							o.description === opt.description,
					),
				);
			if (needsUpdate) {
				await gh([
					"api",
					"graphql",
					"-f",
					`query=${updateOptionsMutation(status.id, options)}`,
				]);
				changes.push(
					`customized Status field options to the 6 layer options (colors + descriptions)`,
				);
			}
			return changes;
		},
	};
}
