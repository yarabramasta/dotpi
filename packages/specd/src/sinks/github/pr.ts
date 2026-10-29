import { branchName, ccTitle, ccTypeOf } from "../../naming.js";
import { checkCanCompleteWork } from "../../pipeline/gates.js";
import {
	appendEvent,
	getItem,
	parseJsonLoose,
	type SpecdStore,
} from "../../store/store.js";
import { writeTempBody } from "./adapter.js";
import type { GhRunner } from "./runner.js";

/** PR capability for the github sink (plan-0006 slice 2): open a PR for a
 * task's convention branch and poll its checks. Sits beside the SinkAdapter
 * (board placement) — PRs are code-hosting concerns, so the frozen M1
 * contract is untouched (D2). All gh access runs through the injectable
 * runner so tests stay offline. */

function appendPrCompleted(
	store: SpecdStore,
	item: string,
	url: string,
	branch: string,
): void {
	appendEvent(store, {
		item,
		type: "pr.created",
		payload: { url, branch },
		actor: "agent",
	});
	appendEvent(store, {
		item,
		type: "work.completed",
		payload: { pr: url },
		actor: "agent",
	});
}

export interface OpenPrInput {
	/** Base branch override; default resolves via gh repo view. */
	base?: string;
	/** Plain-prose PR body (octocat: short, no ## sections); default is the
	 * task title one-liner. */
	summary?: string;
	taskId: string;
}

export interface OpenPrResult {
	branch: string;
	/** false when a PR already existed for the branch (idempotent re-open). */
	created: boolean;
	number: string;
	url: string;
}

export async function openPr(
	store: SpecdStore,
	run: GhRunner,
	cwd: string,
	input: OpenPrInput,
): Promise<OpenPrResult> {
	// The review gate IS the completion gate, reused verbatim (D4/F2): no
	// PR without a passing review, identical refusal wording.
	const gate = checkCanCompleteWork(store, input.taskId);
	if (!gate.ok) throw new Error(gate.reason);
	const task = getItem(store, input.taskId);
	if (!task) throw new Error(`Unknown item: ${input.taskId}.`);
	const gh = (args: string[]) => run(args, cwd);
	const branch = branchName(
		{ id: task.id, title: task.title },
		ccTypeOf(store, task.id),
	);
	const title = ccTitle(store, task.id, task.title);

	// Idempotency: an open PR for this branch wins over a duplicate.
	const listed = parseJsonLoose<Array<{ number?: number; url?: string }>>(
		(
			await gh([
				"pr",
				"list",
				"--head",
				branch,
				"--state",
				"open",
				"--json",
				"url,number",
				"--limit",
				"1",
			])
		).stdout,
	);
	const existing = (listed ?? [])[0];
	if (existing?.url && existing.number !== undefined) {
		appendPrCompleted(store, input.taskId, existing.url, branch);
		return {
			branch,
			created: false,
			number: String(existing.number),
			url: existing.url,
		};
	}

	let base = input.base;
	if (!base) {
		const view = parseJsonLoose<{ defaultBranchRef?: { name?: string } }>(
			(await gh(["repo", "view", "--json", "defaultBranchRef"])).stdout,
		);
		base = view?.defaultBranchRef?.name;
	}
	if (!base) {
		throw new Error(
			"Could not resolve the default branch (gh repo view). Pass base explicitly.",
		);
	}

	const body = await writeTempBody(input.summary ?? task.title);
	try {
		const created = await gh([
			"pr",
			"create",
			"--base",
			base,
			"--head",
			branch,
			"--title",
			title,
			"--body-file",
			body.file,
		]);
		const url = created.stdout.trim().split("\n").at(-1) ?? "";
		if (!url.startsWith("http")) {
			throw new Error(
				`gh pr create did not return a PR URL. Output: ${created.stdout} ${created.stderr}`,
			);
		}
		const number = url.split("/pull/").at(-1) ?? "";
		appendPrCompleted(store, input.taskId, url, branch);
		return { branch, created: true, number, url };
	} finally {
		await body.cleanup();
	}
}

export type CheckState = "passed" | "failed" | "pending";

export interface CheckReport {
	failing: string[];
	state: CheckState;
}

/** gh pr checks exit codes: 0 all passed, 1 at least one failed OR the
 * repo has no configured CI (gh prints "no checks reported"), 8 pending.
 * When exit 1 carries the "no checks reported" message, we map it to
 * pending — the task is not blocked, the agent can keep waiting/polling.
 * Real failing checks still exit 1 with check rows and map to failed.
 * JSON only names the failures (degrades to an empty list if the gh
 * version emits no parseable JSON). */
const CHECK_EXIT: Record<number, CheckState> = {
	0: "passed",
	1: "failed",
	8: "pending",
};
const NO_CHECKS_REPORTED = /no checks reported/i;

/** Single non-blocking poll (D3): one `gh pr checks <branch>` per call.
 * The agent re-invokes to re-poll; nothing here waits on CI. */
export async function watchChecks(
	store: SpecdStore,
	run: GhRunner,
	cwd: string,
	taskId: string,
): Promise<CheckReport> {
	const task = getItem(store, taskId);
	if (!task) throw new Error(`Unknown item: ${taskId}.`);
	const branch = branchName(
		{ id: task.id, title: task.title },
		ccTypeOf(store, task.id),
	);
	let code = 0;
	let stdout = "";
	try {
		({ stdout } = await run(
			["pr", "checks", branch, "--json", "name,bucket"],
			cwd,
		));
	} catch (err) {
		const e = err as {
			code?: number;
			message?: string;
			stderr?: string;
			stdout?: string;
		};
		code = typeof e.code === "number" ? e.code : 1;
		stdout = e.stdout ?? "";
		if (code === 1 && NO_CHECKS_REPORTED.test(stdout)) {
			return { failing: [], state: "pending" };
		}
		if (!(code in CHECK_EXIT)) {
			throw new Error(
				`gh pr checks failed (exit ${code}): ${(e.stderr ?? e.message ?? "").trim()}`,
			);
		}
	}
	const state = CHECK_EXIT[code] ?? "failed";
	const rows =
		parseJsonLoose<Array<{ bucket?: string; name?: string }>>(stdout);
	const failing = (rows ?? [])
		.filter((r) => r.bucket === "fail" && r.name)
		.map((r) => r.name as string);
	return { failing, state };
}
