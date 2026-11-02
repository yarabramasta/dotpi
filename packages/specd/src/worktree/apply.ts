import { execFileSync as defaultExecFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	type DepManager,
	type DepRow,
	IGNORED_DIRS,
	planDepActions,
	planResumeConversion,
} from "./deps.js";

type ExecFileSync = typeof defaultExecFileSync;

export interface DedupOptions {
	ci?: boolean;
	execFileSync?: ExecFileSync;
}

function rowInIgnoredDir(dir: string, worktreeDir: string): boolean {
	let cursor = dir;
	while (cursor !== worktreeDir && cursor.length > worktreeDir.length) {
		if (IGNORED_DIRS.includes(basename(cursor))) return true;
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return false;
}

function linkableDepDir(manager: DepManager): string | undefined {
	switch (manager) {
		case "npm/yarn/bun":
			return "node_modules";
		case "composer":
			return "vendor";
		case "cocoapods":
			return "Pods";
		default:
			return undefined;
	}
}

export function resolvePrimaryWorktree(
	cwd: string,
	exec: ExecFileSync = defaultExecFileSync,
): string {
	const out = exec("git", ["worktree", "list", "--porcelain"], {
		cwd,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	const first = out
		.toString()
		.split("\n")
		.find((line) => line.startsWith("worktree "));
	if (!first) throw new Error(`No worktree entries found in ${cwd}`);
	return resolve(cwd, first.slice("worktree ".length));
}

function commandFor(manager: DepManager, dir: string): [string, string[]] {
	switch (manager) {
		case "npm/yarn/bun": {
			if (existsSync(join(dir, "yarn.lock"))) {
				return ["yarn", ["--immutable"]];
			}
			if (existsSync(join(dir, "bun.lockb"))) {
				return ["bun", ["install"]];
			}
			if (existsSync(join(dir, "package-lock.json"))) {
				return ["npm", ["ci"]];
			}
			return ["npm", ["install"]];
		}
		case "pnpm":
			return ["pnpm", ["install", "--frozen-lockfile"]];
		case "composer":
			return ["composer", ["install", "--no-interaction"]];
		case "cocoapods":
			return ["pod", ["install"]];
		default:
			throw new Error(`No install command for ${manager}`);
	}
}

function relativeSymlinkTarget(linkPath: string, target: string): string {
	const rel = relative(resolve(linkPath, ".."), target);
	return rel || ".";
}

function createRelativeSymlink(linkPath: string, target: string): void {
	mkdirSync(resolve(linkPath, ".."), { recursive: true });
	const rel = relativeSymlinkTarget(linkPath, target);
	symlinkSync(rel, linkPath);
}

function symlinkResolves(linkPath: string, expectedTarget: string): boolean {
	try {
		const st = lstatSync(linkPath, { throwIfNoEntry: false });
		if (!st?.isSymbolicLink()) return false;
		return (
			resolve(linkPath, "..", readlinkSync(linkPath)) ===
			resolve(expectedTarget)
		);
	} catch {
		return false;
	}
}

function convertDuplicatedDirToSymlink(linkPath: string, target: string): void {
	const dir = dirname(linkPath);
	const stamp = Date.now();
	const backup = join(dir, `.${basename(linkPath)}.dedup-${stamp}`);
	renameSync(linkPath, backup);
	try {
		createRelativeSymlink(linkPath, target);
		if (!existsSync(linkPath)) {
			throw new Error(
				`created symlink does not resolve: ${linkPath} -> ${target}`,
			);
		}
		rmSync(backup, { recursive: true, force: true });
	} catch (e) {
		if (existsSync(linkPath)) rmSync(linkPath, { force: true });
		if (existsSync(backup)) renameSync(backup, linkPath);
		throw e;
	}
}

function installLine(
	manager: DepManager,
	dir: string,
	reason: string,
	exec: ExecFileSync,
): string {
	const [cmd, args] = commandFor(manager, dir);
	exec(cmd, args, { cwd: dir, stdio: "pipe" });
	return `installed — ${reason} (${cmd} ${args.join(" ")})`;
}

function applyRow(
	row: DepRow,
	primaryDir: string,
	worktreeDir: string,
	options: DedupOptions & { execFileSync: ExecFileSync },
): { line: string; error?: Error } {
	if (row.action === "skip") {
		return { line: `${row.manager}: skipped — ${row.reason}` };
	}

	if (rowInIgnoredDir(row.dir, worktreeDir)) {
		return {
			line: `${row.manager}: skipped — refused: row dir is inside an ignored directory`,
		};
	}

	const depDir = linkableDepDir(row.manager);
	if (!depDir) {
		// pnpm: always install, no linkable dependency directory.
		return {
			line: `${row.manager}: ${installLine(row.manager, row.dir, row.reason, options.execFileSync)}`,
		};
	}

	const rel = relative(worktreeDir, row.dir);
	const primaryHitDir = join(primaryDir, rel);
	const target = join(primaryHitDir, depDir);
	const linkPath = join(row.dir, depDir);

	// Resume conversion: turn an already-duplicated real directory into a
	// symlink when the guard passes. planResumeConversion already checks CI,
	// lockfile match, eligibility, and directory existence.
	const resume = planResumeConversion(
		row.manager,
		primaryHitDir,
		row.dir,
		options,
	);
	if (resume.action === "link") {
		try {
			convertDuplicatedDirToSymlink(linkPath, target);
			return { line: `${row.manager}: linked — ${resume.reason}` };
		} catch (e) {
			return {
				line: `${row.manager}: ${installLine(row.manager, row.dir, "resume conversion failed; running install", options.execFileSync)}`,
				error: e instanceof Error ? e : new Error(String(e)),
			};
		}
	}

	const linkStat = lstatSync(linkPath, { throwIfNoEntry: false });
	const primaryReady = existsSync(target);

	if (row.action === "link") {
		if (!primaryReady) {
			return {
				line: `${row.manager}: ${installLine(row.manager, row.dir, `primary ${depDir} missing; running install`, options.execFileSync)}`,
			};
		}

		if (!linkStat) {
			createRelativeSymlink(linkPath, target);
			if (!existsSync(linkPath)) {
				return {
					line: `${row.manager}: ${installLine(row.manager, row.dir, "created symlink does not resolve; running install", options.execFileSync)}`,
				};
			}
			return { line: `${row.manager}: linked — ${row.reason}` };
		}

		if (linkStat.isSymbolicLink()) {
			if (symlinkResolves(linkPath, target)) {
				return { line: `${row.manager}: linked — ${row.reason}` };
			}
			// Broken or wrong symlink: replace with real install so the
			// worktree is never left with a dangling link.
			rmSync(linkPath, { force: true });
			return {
				line: `${row.manager}: ${installLine(row.manager, row.dir, "broken symlink; running install", options.execFileSync)}`,
				error: new Error(`${linkPath} did not resolve to ${target}`),
			};
		}

		if (linkStat.isDirectory()) {
			try {
				convertDuplicatedDirToSymlink(linkPath, target);
				return { line: `${row.manager}: linked — ${row.reason}` };
			} catch (e) {
				return {
					line: `${row.manager}: ${installLine(row.manager, row.dir, "conversion failed; running install", options.execFileSync)}`,
					error: e instanceof Error ? e : new Error(String(e)),
				};
			}
		}

		// File or other non-directory in the way: remove and symlink.
		rmSync(linkPath, { force: true });
		createRelativeSymlink(linkPath, target);
		if (!existsSync(linkPath)) {
			return {
				line: `${row.manager}: ${installLine(row.manager, row.dir, "created symlink does not resolve; running install", options.execFileSync)}`,
			};
		}
		return { line: `${row.manager}: linked — ${row.reason}` };
	}

	// action === "install"
	if (linkStat?.isSymbolicLink()) {
		// Remove a broken/wrong pre-existing link before installing so we
		// never leave a dangling symlink at tool return.
		rmSync(linkPath, { force: true });
	}
	return {
		line: `${row.manager}: ${installLine(row.manager, row.dir, row.reason, options.execFileSync)}`,
	};
}

/**
 * Resolve dependencies for a worktree relative to the primary checkout.
 * Creates relative symlinks where safe, runs frozen installs where required,
 * and safely converts duplicated directories on resume. Returns one
 * human-readable line per ecosystem.
 */
export function dedupDependencies(
	primaryDir: string,
	worktreeDir: string,
	options?: DedupOptions,
): { summary: string; errors: Error[]; changed: boolean } {
	const exec = options?.execFileSync ?? defaultExecFileSync;
	const rows = planDepActions(primaryDir, worktreeDir, {
		ci: options?.ci ?? false,
	});

	// pnpm workspaces: once a pnpm root is detected, sub-package node_modules
	// are managed by the root pnpm install; skip child npm/yarn/bun rows so
	// we do not run conflicting installs under nested package.json dirs.
	const pnpmRoots = rows.filter((r) => r.manager === "pnpm").map((r) => r.dir);
	const filteredRows = rows.filter((row) => {
		if (row.manager !== "npm/yarn/bun") return true;
		for (const root of pnpmRoots) {
			const rel = relative(root, row.dir);
			if (rel && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel)) {
				return false;
			}
		}
		return true;
	});

	if (filteredRows.length === 0) {
		return {
			summary: "no dependency ecosystems detected",
			errors: [],
			changed: false,
		};
	}

	const lines: string[] = [];
	const errors: Error[] = [];
	let changed = false;

	for (const row of filteredRows) {
		const result = applyRow(row, primaryDir, worktreeDir, {
			...options,
			execFileSync: exec,
		});
		lines.push(result.line);
		if (result.error) errors.push(result.error);
		if (
			result.line.includes(": linked —") ||
			result.line.includes(": installed —")
		) {
			changed = true;
		}
	}

	return { summary: lines.join("\n"), errors, changed };
}
