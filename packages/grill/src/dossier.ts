import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** First-class grounding dossier: one compact repo-context snapshot built once
 * at grill start and injected into the session guidance. Cymbal structure for
 * the code inventory, git status/log for open work. Best-effort — any failure
 * degrades to no dossier, never blocks the session. */

export interface DossierParts {
	structure?: string;
	gitStatus?: string;
	gitLog?: string;
}

const MAX_STRUCTURE_LINES = 24;
const MAX_GIT_STATUS_LINES = 6;
const MAX_GIT_LOG_LINES = 3;
const MAX_DOSSIER_CHARS = 2200;

function headLines(text: string, maxLines: number): string {
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	return lines.slice(0, maxLines).join("\n");
}

/** Pure composition so the size caps are unit-testable without exec. */
export function composeDossier(parts: DossierParts): string {
	const sections: string[] = [];
	if (parts.structure?.trim()) {
		sections.push(
			`Repo structure (cymbal):\n${headLines(parts.structure, MAX_STRUCTURE_LINES)}`,
		);
	}
	if (parts.gitStatus?.trim()) {
		sections.push(
			`Git status (first ${MAX_GIT_STATUS_LINES}):\n${headLines(parts.gitStatus, MAX_GIT_STATUS_LINES)}`,
		);
	}
	if (parts.gitLog?.trim()) {
		sections.push(
			`Recent commits:\n${headLines(parts.gitLog, MAX_GIT_LOG_LINES)}`,
		);
	}
	const joined = sections.join("\n\n");
	return joined.length > MAX_DOSSIER_CHARS
		? `${joined.slice(0, MAX_DOSSIER_CHARS)}\n… (truncated)`
		: joined;
}

interface ExecResult {
	stdout?: string | Buffer;
	stderr?: string | Buffer;
	code?: number;
}

async function run(
	pi: ExtensionAPI,
	cmd: string,
	args: string[],
): Promise<string | undefined> {
	try {
		const result = (await pi.exec(cmd, args, { timeout: 8000 })) as ExecResult;
		if (result.code !== 0) return undefined;
		const out = result.stdout;
		if (typeof out === "string") return out;
		return out ? out.toString() : undefined;
	} catch {
		return undefined;
	}
}

/** Build the dossier via cymbal + git. Returns undefined when nothing usable. */
export async function buildDossier(
	pi: ExtensionAPI,
	cwd: string,
): Promise<string | undefined> {
	const [structure, gitStatus, gitLog] = await Promise.all([
		run(pi, "cymbal", ["structure"]),
		run(pi, "git", ["-C", cwd, "status", "-sb"]),
		run(pi, "git", ["-C", cwd, "log", "--oneline", "-3"]),
	]);
	const composed = composeDossier({ structure, gitStatus, gitLog });
	return composed || undefined;
}
