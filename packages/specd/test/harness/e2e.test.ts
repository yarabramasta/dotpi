import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_PROMPT } from "../../src/commands/prompts.js";
import {
	addLink,
	appendEvent,
	createItem,
	history,
	openStore,
} from "../../src/store/store.js";

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/** Phase-0 e2e layer (plan-0007, option a): replay the /spec run flow in a
 * throwaway fixture repo with REAL model calls — orchestrator plus its
 * worker/reviewer subagent spawns — and record turns + prompt tokens from
 * session.jsonl usage fields. The replay stops after the review verdict is
 * recorded (no specd_open_pr / work.completed): the fixture has no gh
 * remote, and the PR step is out of scope for this baseline.
 *
 * NOT part of CI: costs real tokens and minutes. Run deliberately:
 *   SPECD_E2E=1 npx vitest run test/harness/e2e.test.ts
 *   SPECD_E2E=1 SPECD_UPDATE_BASELINE=1 ... to re-seed the baseline.
 * The git diff of e2e-baseline.json at each phase boundary is the
 * before/after evidence (D8). */

const SKIP = process.env.SPECD_E2E !== "1";
const RUN_TIMEOUT_MS = 20 * 60_000;

const git = (cwd: string, ...args: string[]): string =>
	execFileSync(
		"git",
		["-c", "user.name=harness", "-c", "user.email=harness@fixture", ...args],
		{
			cwd,
			encoding: "utf8",
		},
	);

const SPEC_BODY = `## Intent
Add a trivial answer module as a scripted e2e replay fixture.

## Acceptance criteria
- src/answer.ts exists and exports a constant answer equal to 42.

## Out of scope
Anything else.`;

const TASK_BODY = `Acceptance criteria:
- src/answer.ts exists and exports a constant answer equal to 42.`;

export interface SessionUsage {
	file: string;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costTotal: number;
	models: string[];
}

function parseSession(file: string): SessionUsage {
	const usage: SessionUsage = {
		file,
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		costTotal: 0,
		models: [],
	};
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let o: {
			type?: string;
			message?: {
				role?: string;
				usage?: Record<string, number>;
				model?: string;
				modelID?: string;
			};
		};
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		if (o.type !== "message" || o.message?.role !== "assistant") continue;
		const u = o.message.usage as
			| {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					reasoning?: number;
					totalTokens?: number;
					cost?: { total?: number };
			  }
			| undefined;
		if (!u) continue;
		usage.turns++;
		usage.input += u.input ?? 0;
		usage.output += u.output ?? 0;
		usage.cacheRead += u.cacheRead ?? 0;
		usage.cacheWrite += u.cacheWrite ?? 0;
		usage.reasoning += u.reasoning ?? 0;
		usage.totalTokens += u.totalTokens ?? 0;
		usage.costTotal += u.cost?.total ?? 0;
		const model = o.message.model ?? o.message.modelID;
		if (model && !usage.models.includes(model)) usage.models.push(model);
	}
	return usage;
}

function collectSessionFiles(sessionsDir: string): {
	parents: string[];
	children: Array<{ file: string; role: string }>;
} {
	const parents: string[] = [];
	const children: Array<{ file: string; role: string }> = [];
	if (!existsSync(sessionsDir)) return { parents, children };
	// pi layout: parent sessions are .jsonl files DIRECTLY in the session
	// dir; subagent run sessions nest at <stem>/<run-id>/run-0/session.jsonl;
	// role transcripts land in sessions/subagent-artifacts/<uuid>_role_transcript.jsonl
	for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			parents.push(join(sessionsDir, entry.name));
		}
	}
	const walk = (dir: string, depth: number): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (entry.name === "subagent-artifacts") continue;
				if (depth < 6) walk(join(dir, entry.name), depth + 1);
			} else if (entry.name === "session.jsonl") {
				children.push({ file: join(dir, entry.name), role: "unknown" });
			}
		}
	};
	walk(sessionsDir, 0);
	// label children from their artifact transcripts
	const artifacts = join(sessionsDir, "subagent-artifacts");
	if (existsSync(artifacts)) {
		for (const child of children) {
			const runId = child.file.split("/").at(-3) ?? "";
			for (const t of readdirSync(artifacts)) {
				if (t.startsWith(runId) && t.includes("_worker_transcript")) {
					child.role = "worker";
				} else if (t.startsWith(runId) && t.includes("_reviewer_transcript")) {
					child.role = "reviewer";
				}
			}
		}
	}
	return { parents, children };
}

describe.skipIf(SKIP)("specd e2e replay harness (option a)", () => {
	it(
		"replays /spec run through the review verdict and records token usage",
		async () => {
			const TS = Date.now();
			const fixture = join(tmpdir(), `specd-e2e-${TS}`);
			const sessionsDir = join(fixture, "sessions");
			mkdirSync(sessionsDir, { recursive: true });

			// --- fixture repo with a local bare remote (push works, no gh) ---
			execFileSync("git", ["init", "-q", "-b", "main", fixture]);
			execFileSync("git", [
				"init",
				"-q",
				"--bare",
				join(fixture, "remote.git"),
			]);
			execFileSync("git", ["remote", "add", "origin", "./remote.git"], {
				cwd: fixture,
			});
			writeFileSync(join(fixture, "README.md"), "# specd e2e fixture\n");
			mkdirSync(join(fixture, "src"), { recursive: true });
			writeFileSync(
				join(fixture, "src", "index.js"),
				'console.log("fixture");\n',
			);
			git(fixture, "add", "-A");
			git(fixture, "commit", "-q", "-m", "chore: fixture seed");

			// --- seed the store at the fixture root (store.db resolution
			// matches what specd tools do with ctx.cwd) ---
			const store = await openStore(fixture);
			const cycle = createItem(store, {
				kind: "cycle",
				title: "Answer module slice",
				body: "Fixture cycle.",
				actor: "harness",
			});
			appendEvent(store, {
				item: cycle.id,
				type: "explore.decided",
				actor: "harness",
				payload: { decision: "go", reason: "scripted fixture" },
			});
			const spec = createItem(store, {
				kind: "spec",
				title: "Answer module",
				body: SPEC_BODY,
				actor: "harness",
			});
			addLink(store, spec.id, cycle.id, "part-of");
			appendEvent(store, {
				item: spec.id,
				type: "spec.approved",
				actor: "harness",
			});
			const plan = createItem(store, {
				kind: "plan",
				title: "Answer module plan",
				body: "One module, one export.",
				actor: "harness",
			});
			addLink(store, plan.id, spec.id, "part-of");
			const task = createItem(store, {
				kind: "task",
				title: "Add answer module",
				body: TASK_BODY,
				pathScope: "src/**",
				actor: "harness",
			});
			addLink(store, task.id, spec.id, "part-of");
			const taskId = task.id;
			store.db.close();

			// --- run pi non-interactively through the RUN_PROMPT flow,
			// truncated at the review verdict (option a) ---
			const prompt = `${RUN_PROMPT(taskId)}

HARNESS SCOPE (baseline replay): after step 4 records the review verdict, STOP. Do not run step 5 (specd_open_pr) — this fixture has a local bare remote and no gh; the PR step is out of scope for this measurement. Report the recorded verdict and stop.`;

			let stdout = "";
			try {
				stdout = execFileSync(
					process.env.PI_BIN ?? "pi",
					[
						"--print",
						"--session-dir",
						sessionsDir,
						"--name",
						"specd-e2e-baseline",
						"--",
						prompt,
					],
					{ cwd: fixture, timeout: RUN_TIMEOUT_MS, encoding: "utf8" },
				);
			} catch (err) {
				const e = err as { stdout?: string; stderr?: string; message?: string };
				throw new Error(
					`pi replay failed: ${e.message}\n--- stdout tail ---\n${(e.stdout ?? "").slice(-2000)}\n--- stderr tail ---\n${(e.stderr ?? "").slice(-2000)}`,
				);
			}

			// --- parse usage from parent + child sessions ---
			const { parents, children } = collectSessionFiles(sessionsDir);
			expect(parents.length, "one parent session expected").toBe(1);
			const parent = parseSession(parents[0]);
			const childUsages = children.map((c) => ({
				...parseSession(c.file),
				role: c.role,
			}));

			// --- behavioral assertions on the store after the replay ---
			const check = await openStore(fixture);
			const events = history(check, taskId);
			const started = events.some((e) => e.type === "work.started");
			const review = events.filter((e) => e.type === "review.completed").at(-1);
			const reviewPayload = review
				? (JSON.parse(review.payload ?? "{}") as { passed?: boolean })
				: undefined;
			check.db.close();

			expect(started, "work.started must be recorded").toBe(true);
			expect(review, "a review verdict must be recorded").toBeDefined();
			const branches = git(fixture, "branch", "--list", "specd/*");
			expect(branches.trim().length > 0, "a specd/* branch must exist").toBe(
				true,
			);

			const totals = childUsages.reduce(
				(acc, c) => ({
					turns: acc.turns + c.turns,
					input: acc.input + c.input,
					output: acc.output + c.output,
					totalTokens: acc.totalTokens + c.totalTokens,
					costTotal: acc.costTotal + c.costTotal,
				}),
				{ turns: 0, input: 0, output: 0, totalTokens: 0, costTotal: 0 },
			);

			const result = {
				stoppedAfter: "review-verdict (option a)",
				promptBytes: utf8Bytes(prompt),
				reviewVerdictPassed: reviewPayload?.passed ?? null,
				branches,
				parent,
				children: childUsages,
				childrenTotals: totals,
				grandTotalTokens: parent.totalTokens + totals.totalTokens,
				grandTotalCost: Number(
					(parent.costTotal + totals.costTotal).toFixed(4),
				),
				stdoutTail: stdout.slice(-600),
			};

			const outPath = join(import.meta.dirname, "e2e-baseline.json");
			const priorExists = existsSync(outPath);
			if (!priorExists || process.env.SPECD_UPDATE_BASELINE === "1") {
				writeFileSync(outPath, `${JSON.stringify(result, null, "\t")}\n`);
				console.log(
					`harness: e2e baseline ${priorExists ? "updated" : "seeded"} at ${outPath}`,
				);
			} else {
				const prior = JSON.parse(
					readFileSync(outPath, "utf8"),
				) as typeof result;
				console.log("e2e delta vs baseline:");
				console.log(
					`  parent turns: ${prior.parent.turns} -> ${parent.turns} | grand tokens: ${prior.grandTotalTokens} -> ${result.grandTotalTokens} | cost: $${prior.grandTotalCost} -> $${result.grandTotalCost}`,
				);
				console.log(
					`  children: ${prior.children.length} -> ${childUsages.length}`,
				);
			}
			console.log(
				`e2e replay: ${parent.turns} orchestrator turns, ${childUsages.length} child contexts, grand total ${result.grandTotalTokens} tokens ($${result.grandTotalCost}), review passed=${reviewPayload?.passed}`,
			);

			// cleanup the fixture (keep nothing; the baseline JSON is the artifact).
			// the task worktree is created as a SIBLING dir of the fixture root
			// (specd-e2e-<ts>-specd-<task>-<slug>), so remove the whole family.
			for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name.startsWith(`specd-e2e-${TS}`)) {
					rmSync(join(tmpdir(), entry.name), { recursive: true, force: true });
				}
			}
		},
		RUN_TIMEOUT_MS + 60_000,
	);
});
