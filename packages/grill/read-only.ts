function shellSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\n/) // pipelines are handled separately to avoid flagging read-only grep pipelines as mutating.
		.map((s) => s.trim())
		.filter(Boolean);
}

function isReadOnlyGit(args: string[]): boolean {
	const sub = args[1];
	return [
		"status",
		"log",
		"diff",
		"show",
		"branch",
		"grep",
		"ls-files",
		"remote",
		"rev-parse",
		"describe",
	].includes(sub);
}

function isReadOnlyGh(args: string[]): boolean {
	const sub = args[1];
	const sub2 = args[2];
	if (
		["status", "auth", "repo", "pr", "issue", "label", "milestone"].includes(
			sub,
		) === false
	)
		return false;
	if (sub === "repo") return [undefined, "view", "list"].includes(sub2);
	if (sub === "issue")
		return [undefined, "list", "view", "status"].includes(sub2);
	if (sub === "pr")
		return [undefined, "list", "view", "status", "diff", "checks"].includes(
			sub2,
		);
	if (sub === "label" || sub === "milestone")
		return [undefined, "list", "view"].includes(sub2);
	return true;
}

export function isProbablyReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;

	// Redirection and common write helpers are mutations even if the command itself is read-only.
	if (/(^|[^<])>(>|&)?\s*\S/.test(trimmed) || /\btee\b/.test(trimmed))
		return false;

	const definitelyMutating =
		/\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|sudo|kill|pkill|reboot|shutdown|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash))\b/;
	if (definitelyMutating.test(trimmed)) return false;

	const unsafePhrases = [
		"git add",
		"git commit",
		"git push",
		"git checkout",
		"git switch",
		"git reset",
		"git merge",
		"git rebase",
		"npm install",
		"npm i",
		"npm add",
		"pnpm install",
		"pnpm add",
		"yarn add",
		"yarn install",
		"pip install",
		"cargo install",
		"cargo add",
		"gh issue create",
		"gh issue edit",
		"gh issue close",
		"gh pr create",
		"gh pr edit",
	];
	const lower = trimmed.toLowerCase();
	if (unsafePhrases.some((phrase) => lower.includes(phrase))) return false;

	for (const segment of shellSegments(trimmed)) {
		const args = segment.split(/\s+/);
		const cmd = args[0];
		if (!cmd) continue;
		if (
			[
				"cat",
				"head",
				"tail",
				"less",
				"more",
				"grep",
				"rg",
				"find",
				"fd",
				"ls",
				"pwd",
				"tree",
				"wc",
				"sort",
				"uniq",
				"cut",
				"awk",
				"sed",
				"date",
				"whoami",
				"uname",
				"which",
				"where",
				"echo",
			].includes(cmd)
		) {
			continue;
		}
		if (["npm", "pnpm", "yarn"].includes(cmd)) {
			if (["list", "outdated", "view", "info", "why"].includes(args[1]))
				continue;
			return false;
		}
		if (cmd === "git") {
			if (isReadOnlyGit(args)) continue;
			return false;
		}
		if (cmd === "gh") {
			if (isReadOnlyGh(args)) continue;
			return false;
		}
		// Unknown commands may mutate; block in grill interview mode.
		return false;
	}
	return true;
}
