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
const WRITER_PREFERRED_NAMES = [
	"writer",
	"worker",
	"codex-writer",
	"implementer",
];
// External CLI/job runners (e.g. external-cli:codex, external-job:foo) can mutate
// the workspace. isMutating only matches the exact "external-cli"/"external-job"
// type, so this prefix check closes the gap for suffixed runner types.
const WRITER_RUNNER = /^external-(cli|job)\b/i;
const MUTATING_TOOL =
	/(^|:|\/)(edit|write|apply_patch|ast_grep_replace|rm|mv|cp|mkdir|touch|chmod|chown)(:|\/|$)/i;
const MAX_ELIGIBLE = 20;

/** A write-capable agent: the inverse of the read-only scout/auditor guarantee.
 * Keeps agents that CAN mutate — mutating tools, an external CLI/job runner, or
 * a writer/worker name. Read-only agents are excluded. isMutating now uses the
 * same prefix runner predicate as the read-only exclusion, so suffixed runners
 * (external-cli:codex) cannot appear in both pools. */
function isWriteCapable(candidate: ScoutAgent): boolean {
	if (isMutating(candidate)) return true;
	return WRITER_NAME.test(candidate.name.toLowerCase());
}

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
	const runnerType = candidate.runner?.type;
	return (
		tools.some((tool) => MUTATING_TOOL.test(tool)) ||
		(typeof runnerType === "string" && WRITER_RUNNER.test(runnerType))
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
		if (
			!candidate ||
			seen.has(candidate.name) ||
			candidate.executable === false
		)
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

/** Select executable, write-capable agents for delegating approved-output file
 * writes. Inverse of the read-only scout/auditor selectors: keeps mutating,
 * external CLI/job, or writer-named agents; ranks writer/worker names first. */
export function eligibleWriters(
	values: readonly (ScoutAgent | string)[],
): ScoutAgent[] {
	const seen = new Set<string>();
	const selected: ScoutAgent[] = [];
	for (const value of values) {
		const candidate = normalizeCandidate(value);
		if (
			!candidate ||
			seen.has(candidate.name) ||
			candidate.executable === false
		)
			continue;
		seen.add(candidate.name);
		if (!isWriteCapable(candidate)) continue;
		selected.push(candidate);
	}
	return selected
		.sort((a, b) => {
			const ai = WRITER_PREFERRED_NAMES.indexOf(a.name.toLowerCase());
			const bi = WRITER_PREFERRED_NAMES.indexOf(b.name.toLowerCase());
			if (ai !== -1 || bi !== -1)
				return (
					(ai === -1 ? WRITER_PREFERRED_NAMES.length : ai) -
					(bi === -1 ? WRITER_PREFERRED_NAMES.length : bi)
				);
			return a.name.localeCompare(b.name);
		})
		.slice(0, MAX_ELIGIBLE);
}
