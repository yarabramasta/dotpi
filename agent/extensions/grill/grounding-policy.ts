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

const SCOUT_PREFERRED_NAMES = ["scout", "researcher", "oracle", "delegate"];
const SCOUT_READ_ONLY_DESCRIPTION =
	/read[- ]only|scout|research|inspect|analy[sz]|recon/i;
const AUDITOR_PREFERRED_NAMES = [
	"reviewer",
	"evidence-auditor",
	"auditor",
	"verifier",
	"oracle",
];
const AUDITOR_READ_ONLY_DESCRIPTION =
	/read[- ]only|review|audit|evidence|verif|inspect|analy[sz]|recon/i;
const WRITER_NAME = /(^|[-_])(writer|worker)([-_]|$)|cli[-_]?writer/;
const MUTATING_TOOL =
	/(^|:|\/)(edit|write|apply_patch|ast_grep_replace|rm|mv|cp|mkdir|touch|chmod|chown)(:|\/|$)/i;
const MAX_ELIGIBLE = 20;

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

/** Shared read-only recon/audit selector. Preferred names rank first, then
 * description match. Writer-named and mutating agents are always excluded. */
function selectEligible(
	values: readonly (ScoutAgent | string)[],
	preferredNames: readonly string[],
	descriptionRegex: RegExp,
): ScoutAgent[] {
	const seen = new Set<string>();
	const selected: ScoutAgent[] = [];
	for (const value of values) {
		const candidate = normalizeCandidate(value);
		if (!candidate || seen.has(candidate.name) || candidate.executable === false)
			continue;
		seen.add(candidate.name);
		const name = candidate.name.toLowerCase();
		if (WRITER_NAME.test(name)) continue;
		if (isMutating(candidate)) continue;
		const known = preferredNames.includes(name);
		if (!known && !descriptionRegex.test(candidate.description ?? "")) continue;
		selected.push(candidate);
	}
	return selected
		.sort((a, b) => {
			const ai = preferredNames.indexOf(a.name.toLowerCase());
			const bi = preferredNames.indexOf(b.name.toLowerCase());
			if (ai !== -1 || bi !== -1)
				return (
					(ai === -1 ? preferredNames.length : ai) -
					(bi === -1 ? preferredNames.length : bi)
				);
			return a.name.localeCompare(b.name);
		})
		.slice(0, MAX_ELIGIBLE);
}

/** Select executable, read-only recon agents from the live subagent list. */
export function eligibleScouts(
	values: readonly (ScoutAgent | string)[],
): ScoutAgent[] {
	return selectEligible(
		values,
		SCOUT_PREFERRED_NAMES,
		SCOUT_READ_ONLY_DESCRIPTION,
	);
}

/** Select executable, read-only audit/review agents for the output-audit phase.
 * Recognizes review/audit/evidence/verifier agents (e.g. reviewer,
 * evidence-auditor, oracle) while keeping the read-only guarantee. */
export function eligibleAuditors(
	values: readonly (ScoutAgent | string)[],
): ScoutAgent[] {
	return selectEligible(
		values,
		AUDITOR_PREFERRED_NAMES,
		AUDITOR_READ_ONLY_DESCRIPTION,
	);
}
