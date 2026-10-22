import { parseJsonLoose } from "../store/store.js";
import type {
	SinkAdapter,
	SinkVerify,
	TaskCreated,
	TaskExport,
} from "./contract.js";
import { type GhRunner, type GithubSinkConfig, realGhRunner } from "./gh.js";

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
			// Project id (needed by item-edit).
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
			const projectId = view?.id ?? "";
			if (!projectId) {
				throw new Error(
					`Could not resolve project #${number} for owner ${owner}. Check the project config.`,
				);
			}
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
			// Map the lane name to the Status field's option id.
			const fields = parseJsonLoose<{
				fields?: Array<{
					name?: string;
					id?: string;
					options?: Array<{ id?: string; name?: string }>;
				}>;
			}>(
				(
					await gh([
						"project",
						"field-list",
						number,
						"--owner",
						owner,
						"--format",
						"json",
					])
				).stdout,
			);
			const statusField = (fields?.fields ?? []).find(
				(f) => f.name === "Status",
			);
			const option = statusField?.options?.find((o) => o.name === lane);
			if (!statusField?.id || !option?.id) {
				throw new Error(
					`Lane "${lane}" not found on the project's Status field. Available options: ${(
						statusField?.options ?? []
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
				statusField.id,
				"--single-select-option-id",
				option.id,
			]);
		},
	};
}
