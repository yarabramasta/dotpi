export interface ScoutAgent {
	name: string;
	description?: string;
	executable?: boolean;
	source?: string;
	runner?: { type?: string };
	tools?: {
		ambient?: boolean;
		names?: string[];
		mutationTools?: string[];
	};
	mutationTools?: string[];
}

const PREFERRED_NAMES = ["scout", "researcher", "oracle", "delegate"];
const READ_ONLY_DESCRIPTION =
	/read[- ]only|scout|research|inspect|analy[sz]|recon/i;
const MUTATING_TOOL =
	/(^|:|\/)(edit|write|apply_patch|ast_grep_replace|rm|mv|cp|mkdir|touch|chmod|chown)(:|\/|$)/i;
const MAX_SCOUTS = 20;

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function isMutating(candidate: ScoutAgent): boolean {
	const tools = [
		...stringList(candidate.tools?.names),
		...stringList(candidate.tools?.mutationTools),
		...stringList(candidate.mutationTools),
	];
	return (
		tools.some((tool) => MUTATING_TOOL.test(tool)) ||
		candidate.runner?.type === "external-cli" ||
		candidate.runner?.type === "external-job"
	);
}

function normalizeCandidate(
	value: ScoutAgent | string,
): ScoutAgent | undefined {
	if (typeof value === "string") {
		const name = value.trim();
		return name ? { name } : undefined;
	}
	const name = typeof value.name === "string" ? value.name.trim() : "";
	return name ? { ...value, name } : undefined;
}

/** Select executable, read-only recon agents from the live subagent list. */
export function eligibleScouts(
	values: readonly (ScoutAgent | string)[],
): ScoutAgent[] {
	const seen = new Set<string>();
	const selected: ScoutAgent[] = [];
	for (const value of values) {
		const candidate = normalizeCandidate(value);
		if (!candidate || seen.has(candidate.name) || candidate.executable === false)
			continue;
		seen.add(candidate.name);
		const name = candidate.name.toLowerCase();
		if (/(^|[-_])(writer|worker)([-_]|$)|cli[-_]?writer/.test(name)) continue;
		if (isMutating(candidate)) continue;
		const known = PREFERRED_NAMES.includes(name);
		if (!known && !READ_ONLY_DESCRIPTION.test(candidate.description ?? ""))
			continue;
		selected.push(candidate);
	}
	return selected
		.sort((a, b) => {
			const ai = PREFERRED_NAMES.indexOf(a.name.toLowerCase());
			const bi = PREFERRED_NAMES.indexOf(b.name.toLowerCase());
			if (ai !== -1 || bi !== -1)
				return (
					(ai === -1 ? PREFERRED_NAMES.length : ai) -
					(bi === -1 ? PREFERRED_NAMES.length : bi)
				);
			return a.name.localeCompare(b.name);
		})
		.slice(0, MAX_SCOUTS);
}
