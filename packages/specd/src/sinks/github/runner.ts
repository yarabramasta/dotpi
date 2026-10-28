import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Runs the gh CLI in the given cwd. Injectable so contract tests can run
 * offline with canned outputs. */
export type GhRunner = (
	args: string[],
	cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

export const realGhRunner: GhRunner = async (args, cwd) =>
	exec("gh", args, { cwd, maxBuffer: 10 * 1024 * 1024 });

export interface GithubSinkConfig {
	/** GitHub owner (user or org) that hosts the Projects v2 board. */
	owner: string;
	/** Projects v2 project number (from the board URL). */
	projectNumber: number;
	/** specd item status → the board's own Status option (D15). Used by
	 * updateStatus; unmapped states pass through as the option name. */
	statusMap?: Record<string, string>;
}

/** Tolerant JSON parse for gh CLI output lives in ../store/store.js
 * (parseJsonLoose) — the pure-core helper, shared with the pipeline. */
