export const DELEGATE_OPTIONS = [
	{
		value: "yes",
		label: "Delegate file writes to a writer subagent (Recommended)",
		description:
			"A write-capable subagent performs the approved file writes; the parent stays read-only for files and keeps CLI mutations (gh/git). The end-of-process reviewer pass runs after. Costs extra tokens.",
	},
	{
		value: "no",
		label: "Parent writes directly",
		description:
			"The parent agent writes the approved outputs itself (current behavior). Saves tokens; no subagent delegation.",
	},
];

export type OutputBackend = "atom" | "file" | "native";

export interface OutputDestination {
	label: string;
	value: string;
	backend: OutputBackend;
	description: string;
}

/**
 * The grill atom knowledge base (.pi/knowledge/ — folder-colocated with the
 * repo: SQLite kb.db + md node bodies in one folder) is the underlying backend
 * for atom-marked outputs. It is NOT a selectable destination: atom-marked
 * outputs land as typed atoms (revisions edit existing node bodies in place),
 * and promotion to repo-tree files is an explicit step (e.g. ADR →
 * docs/adr/NNN-slug.md). GitHub issues is the other native non-file
 * destination (created via API). file-marked destinations write repo-tree
 * files directly. Never spawn stray md files for knowledge-shaped outputs.
 */
export const KB_BACKEND_GUIDANCE =
	"The grill atom knowledge base (.pi/knowledge/ — folder-colocated: SQLite kb.db + md node bodies in the repo) is the underlying backend for atom-marked outputs, not a selectable option: those outputs land as typed atoms, revisions edit node bodies in place, and promotion to repo-tree files is an explicit step (e.g. ADR → docs/adr/NNN-slug.md). GitHub issues is the other native non-file destination (API-created). File-marked destinations write repo-tree files directly. Never spawn stray md files for knowledge-shaped outputs.";

export const OUTPUT_DESTINATION_OPTIONS: OutputDestination[] = [
	{
		label: "GitHub issues",
		value: "github-issues",
		backend: "native",
		description:
			"Issue titles/bodies/labels for implementation slices, research tasks, tutorial chapters, or milestones. Created via the GitHub API — no local files.",
	},
	{
		label: "Design doc",
		value: "design-doc",
		backend: "atom",
		description:
			"A structured design proposal with goals, constraints, architecture, tradeoffs, risks, and rollout. Stored as a design atom by default; promote to a repo-tree file only when the repo requires it.",
	},
	{
		label: "README.md",
		value: "readme",
		backend: "file",
		description:
			"A README or README update covering setup, usage, behavior, examples, and caveats. Writes the repo-tree README.md directly.",
	},
	{
		label: "ADR",
		value: "adr",
		backend: "atom",
		description:
			"Architecture Decision Record(s) documenting decision context, options, choice, and consequences. Stored as decision atoms by default; promotion to docs/adr/NNN-slug.md is an explicit step.",
	},
	{
		label: "PRD",
		value: "prd",
		backend: "atom",
		description:
			"Product requirements, user stories, scope, acceptance criteria, and non-goals. Stored as spec atoms by default; promote to a repo-tree file only when required.",
	},
	{
		label: "Implementation plan",
		value: "implementation-plan",
		backend: "atom",
		description:
			"Step-by-step engineering plan, milestones, sequencing, dependencies, and validation. Stored as plan atoms by default.",
	},
	{
		label: "Research brief",
		value: "research-brief",
		backend: "atom",
		description:
			"Open questions, investigation plan, evidence to gather, and decision criteria. Stored as research atoms with sources by default.",
	},
	{
		label: "Summary / decision memo",
		value: "summary",
		backend: "atom",
		description:
			"Concise summary of the checkpoint, decisions, assumptions, and next actions. Stored as a decision atom by default.",
	},
	{
		label: "Tutorial / content outline",
		value: "content-outline",
		backend: "atom",
		description:
			"Chapters, lesson flow, examples, exercises, or publishing outline. Stored as content atoms by default.",
	},
	{
		label: "Test plan / QA checklist",
		value: "test-plan",
		backend: "atom",
		description:
			"Acceptance tests, manual QA steps, edge cases, and regression coverage. Stored as validation atoms by default.",
	},
	{
		label: "Changelog / release notes",
		value: "release-notes",
		backend: "atom",
		description:
			"User-facing change summary, migration notes, and release caveats. Stored as release atoms by default; promote to a CHANGELOG file when the repo requires one.",
	},
];

export function outputDestinationOptionsMarkdown(): string {
	return OUTPUT_DESTINATION_OPTIONS.map(
		(option) =>
			`- ${option.label} (${option.value}) — backend: ${option.backend}: ${option.description}`,
	).join("\n");
}

export function outputDestinationOptionNames(): string {
	return OUTPUT_DESTINATION_OPTIONS.map((option) => option.label).join(", ");
}

export const GITHUB_REPO_PERMISSION_GUIDANCE =
	"If approved GitHub issue output has no repo/remote, ask to initialize, create, or select one before creating the previewed issues; use drafts only if the user chooses.";
