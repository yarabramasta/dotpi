import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const MARKER = ".specd-store.yaml";

export function createExternalStore(storePath: string, repoPath: string): void {
	mkdirSync(storePath, { recursive: true });

	const marker = `type: specd-store\nversion: 1\nrepo: ${basename(repoPath)}\n`;
	writeFileSync(join(storePath, MARKER), marker, "utf8");

	execSync("git init", { cwd: storePath, stdio: "ignore" });

	const gitignore = ["store.db-wal", "store.db-shm", ""].join("\n");
	writeFileSync(join(storePath, ".gitignore"), gitignore, "utf8");

	execSync('git add -A && git commit -m "init specd store"', {
		cwd: storePath,
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "specd",
			GIT_AUTHOR_EMAIL: "specd@localhost",
			GIT_COMMITTER_NAME: "specd",
			GIT_COMMITTER_EMAIL: "specd@localhost",
		},
	});
}

export function ensureExternalStore(storePath: string, repoPath: string): void {
	if (existsSync(join(storePath, MARKER))) return;
	createExternalStore(storePath, repoPath);
}
