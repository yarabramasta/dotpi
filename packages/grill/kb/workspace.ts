import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type WorkspaceKind =
	| "npm"
	| "pnpm"
	| "nx"
	| "bun"
	| "gradle"
	| "kmp"
	| null;

export interface WorkspaceInfo {
	isMonorepo: boolean;
	workspacePkgs: number;
	kind: WorkspaceKind;
}

function isNpmPkg(dir: string): boolean {
	return (
		existsSync(join(dir, "package.json")) ||
		existsSync(join(dir, "project.json"))
	);
}

// ponytail: one-level `prefix/*` globs + exact paths; nested `**` globs when a repo needs them
function expandGlobs(cwd: string, patterns: string[]): number {
	const found = new Set<string>();
	for (const raw of patterns) {
		const pattern = raw.replace(/^\.\//, "").replace(/\/+$/, "");
		const star = pattern.indexOf("/*");
		if (star === -1 || star + 2 !== pattern.length) {
			if (isNpmPkg(join(cwd, pattern))) found.add(pattern);
			continue;
		}
		const prefix = pattern.slice(0, star);
		let children: string[];
		try {
			children = readdirSync(join(cwd, prefix || "."), {
				withFileTypes: true,
			}).flatMap((e) => (e.isDirectory() ? [e.name] : []));
		} catch {
			continue;
		}
		for (const name of children) {
			if (isNpmPkg(join(cwd, prefix, name))) found.add(`${prefix}/${name}`);
		}
	}
	return found.size;
}

function npmWorkspaces(cwd: string): string[] | null {
	let pkg: { workspaces?: string[] | { packages?: string[] } };
	try {
		pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	} catch {
		return null;
	}
	if (pkg.workspaces === undefined) return null;
	return Array.isArray(pkg.workspaces)
		? pkg.workspaces
		: (pkg.workspaces.packages ?? []);
}

function pnpmWorkspaces(cwd: string): string[] | null {
	let raw: string;
	try {
		raw = readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8");
	} catch {
		return null;
	}
	const globs: string[] = [];
	let inPackages = false;
	for (const line of raw.split("\n")) {
		if (inPackages) {
			const item = /^\s+-\s*["']?([^#"'].*?)["']?\s*$/.exec(line);
			if (item) {
				globs.push(item[1]);
				continue;
			}
			if (line.trim() === "") continue;
			inPackages = false; // next top-level key — packages block ended
		}
		if (/^packages:/.test(line)) inPackages = true;
	}
	return globs;
}

function gradleWorkspace(cwd: string): WorkspaceInfo {
	const settings = ["settings.gradle.kts", "settings.gradle"].find((f) =>
		existsSync(join(cwd, f)),
	);
	if (!settings) return { isMonorepo: false, workspacePkgs: 0, kind: null };
	const raw = readFileSync(join(cwd, settings), "utf8");
	const modules = (raw.match(/(?:^|\s)include\(/g) ?? []).length;
	const kmpFiles = [settings, "build.gradle.kts", "gradle/libs.versions.toml"];
	const isKmp = kmpFiles.some((f) => {
		try {
			return readFileSync(join(cwd, f), "utf8").includes("multiplatform");
		} catch {
			return false;
		}
	});
	return {
		isMonorepo: modules >= 2,
		workspacePkgs: modules,
		kind: isKmp ? "kmp" : "gradle",
	};
}

export function detectWorkspace(cwd: string): WorkspaceInfo {
	let jsKind: "npm" | "pnpm" | null = null;
	if (npmWorkspaces(cwd)) jsKind = "npm";
	else if (pnpmWorkspaces(cwd)) jsKind = "pnpm";
	if (jsKind) {
		const patterns =
			jsKind === "npm" ? npmWorkspaces(cwd) : pnpmWorkspaces(cwd);
		const pkgs = expandGlobs(cwd, patterns ?? []);
		if (pkgs === 0) return { isMonorepo: false, workspacePkgs: 0, kind: null };
		if (existsSync(join(cwd, "nx.json")))
			return { isMonorepo: pkgs >= 2, workspacePkgs: pkgs, kind: "nx" };
		if (existsSync(join(cwd, "bun.lock")))
			return { isMonorepo: pkgs >= 2, workspacePkgs: pkgs, kind: "bun" };
		return { isMonorepo: pkgs >= 2, workspacePkgs: pkgs, kind: jsKind };
	}
	return gradleWorkspace(cwd);
}
