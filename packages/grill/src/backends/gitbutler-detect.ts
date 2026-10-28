import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GitbutlerDetectResult {
	isGitbutlerMode: boolean;
	reasons: string[];
}

const GITBUTLER_REFS = new Set([
	"refs/heads/gitbutler/workspace",
	"refs/heads/gitbutler/target",
]);

type GitDirPath =
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "dir"; readonly path: string };

function readGitPointer(repoRoot: string): GitDirPath | undefined {
	const gitPath = join(repoRoot, ".git");
	if (!existsSync(gitPath)) return undefined;

	try {
		const stat = statSync(gitPath);
		if (stat.isDirectory()) return { kind: "dir", path: gitPath };
		if (!stat.isFile()) return undefined;

		const content = readFileSync(gitPath, "utf8");
		for (const raw of content.split(/\r?\n/)) {
			const line = raw.trim();
			if (line.startsWith("gitdir:")) {
				const target = line.slice("gitdir:".length).trim();
				if (!target) continue;
				const absolute = resolve(repoRoot, target);
				if (existsSync(absolute)) return { kind: "file", path: absolute };
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function hasGitbutlerRefs(gitDir: string): boolean {
	const headsDir = join(gitDir, "refs", "heads", "gitbutler");
	try {
		if (existsSync(headsDir) && statSync(headsDir).isDirectory()) {
			const entries = readdirSync(headsDir, { withFileTypes: true });
			if (entries.length > 0) return true;
		}
	} catch {
		// fall through to packed-refs check
	}

	const packedPath = join(gitDir, "packed-refs");
	try {
		if (!existsSync(packedPath)) return false;
		const text = readFileSync(packedPath, "utf8");
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) continue;
			const ref = line.split(/\s+/).pop();
			if (ref && GITBUTLER_REFS.has(ref)) return true;
		}
	} catch {
		return false;
	}
	return false;
}

function hasGitbutlerStateDir(gitDir: string): boolean {
	const stateDir = join(gitDir, "gitbutler");
	try {
		return existsSync(stateDir) && statSync(stateDir).isDirectory();
	} catch {
		return false;
	}
}

function hasGitbutlerConfig(gitDir: string): boolean {
	const configPath = join(gitDir, "config");
	try {
		if (!existsSync(configPath)) return false;
		const text = readFileSync(configPath, "utf8");
		return /^\s*\[gitbutler\s+"project"\]\s*$/m.test(text);
	} catch {
		return false;
	}
}

/** Detect gitbutler mode using only read-only filesystem/git plumbing probes.
 * Never invokes external commands. Returns the aggregate result plus human-
 * readable reasons for each matched signal. */
export function detectGitbutlerMode(repoRoot: string): GitbutlerDetectResult {
	const reasons: string[] = [];
	if (!repoRoot || repoRoot.trim().length === 0) {
		return { isGitbutlerMode: false, reasons };
	}

	const pointer = readGitPointer(repoRoot);
	if (!pointer) {
		return { isGitbutlerMode: false, reasons };
	}

	if (hasGitbutlerRefs(pointer.path)) {
		reasons.push("gitbutler refs present");
	}
	if (hasGitbutlerStateDir(pointer.path)) {
		reasons.push("gitbutler state directory present");
	}
	if (hasGitbutlerConfig(pointer.path)) {
		reasons.push("gitbutler project config section present");
	}

	return {
		isGitbutlerMode: reasons.length > 0,
		reasons,
	};
}

/** Check whether the `but` binary is on PATH.
 *
 * ponytail: only call after mode detection passes; `but` prompts interactively
 * in uninitialized repos, so this must never be invoked blindly. */
export function isButBinaryPresent(): boolean {
	try {
		const result = spawnSync("but", ["--version"], {
			timeout: 3000,
			encoding: "utf8",
			windowsHide: true,
		});
		return result.status === 0;
	} catch {
		return false;
	}
}
