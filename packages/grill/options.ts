export const DELEGATE_OPTIONS = [
	{
		value: "yes",
		label: "Delegate file writes to a writer subagent (Recommended)",
		description:
			"A write-capable subagent performs the approved file writes; the parent stays read-only for files and keeps CLI mutations (gh/git). The advisory audit runs after. Costs extra tokens.",
	},
	{
		value: "no",
		label: "Parent writes directly",
		description:
			"The parent agent writes the approved outputs itself (current behavior). Saves tokens; no subagent delegation.",
	},
];

export const OUTPUT_DESTINATION_OPTIONS = [
	{
		label: "GitHub issues",
		value: "github-issues",
		description:
			"Issue titles/bodies/labels for implementation slices, research tasks, tutorial chapters, or milestones.",
	},
	{
		label: "Design doc",
		value: "design-doc",
		description:
			"A structured design proposal with goals, constraints, architecture, tradeoffs, risks, and rollout.",
	},
	{
		label: "README.md",
		value: "readme",
		description:
			"A README or README update covering setup, usage, behavior, examples, and caveats.",
	},
	{
		label: "ADR",
		value: "adr",
		description:
			"Architecture Decision Record(s) documenting decision context, options, choice, and consequences.",
	},
	{
		label: "PRD",
		value: "prd",
		description:
			"Product requirements, user stories, scope, acceptance criteria, and non-goals.",
	},
	{
		label: "Implementation plan",
		value: "implementation-plan",
		description:
			"Step-by-step engineering plan, milestones, sequencing, dependencies, and validation.",
	},
	{
		label: "Research brief",
		value: "research-brief",
		description:
			"Open questions, investigation plan, evidence to gather, and decision criteria.",
	},
	{
		label: "Summary / decision memo",
		value: "summary",
		description:
			"Concise summary of the checkpoint, decisions, assumptions, and next actions.",
	},
	{
		label: "Tutorial / content outline",
		value: "content-outline",
		description:
			"Chapters, lesson flow, examples, exercises, or publishing outline.",
	},
	{
		label: "Test plan / QA checklist",
		value: "test-plan",
		description:
			"Acceptance tests, manual QA steps, edge cases, and regression coverage.",
	},
	{
		label: "Changelog / release notes",
		value: "release-notes",
		description:
			"User-facing change summary, migration notes, and release caveats.",
	},
] as const;

export const GITHUB_REPO_PERMISSION_GUIDANCE =
	"If approved GitHub issue output has no repo/remote, ask to initialize, create, or select one before creating the previewed issues; use drafts only if the user chooses.";

export function outputDestinationOptionsMarkdown(): string {
	return OUTPUT_DESTINATION_OPTIONS.map(
		(option) => `- ${option.label} (${option.value}): ${option.description}`,
	).join("\n");
}

export function outputDestinationOptionNames(): string {
	return OUTPUT_DESTINATION_OPTIONS.map((option) => option.label).join(", ");
}
