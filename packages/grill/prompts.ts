import type { GroundingView } from "./grounding.js";
import {
	GITHUB_REPO_PERMISSION_GUIDANCE,
	outputDestinationOptionsMarkdown,
} from "./options.js";
import { currentPhase, type GrillState, type ResearchMode } from "./state.js";

export function describeOutputPreference(state: GrillState): string {
	const preference =
		typeof state.outputPreference === "string"
			? state.outputPreference.trim()
			: "";
	return (
		preference ||
		"(none set; explicitly ask for one or more outputs before production)"
	);
}

export function phaseLabel(state: GrillState): string {
	const phase = currentPhase(state);
	if (phase === "output")
		return "output production; approved mutations allowed";
	if (phase === "output-selection")
		return "mandatory output selection; choose final outputs/continue/stop";
	return "interview; read-only enforcement active";
}

export function initialCheckpoint(topic: string, state: GrillState): string {
	return `# Shared Understanding

## Topic

${topic}

## Current Understanding

We are starting a grill-me session to reach shared understanding before producing outputs or implementation work.

## Working Configuration

- Intent: ${state.intent}
- Grilling style: thorough Socratic interview
- Research mode: ${state.researchMode}
- Grounding: first-class (auto dossier at start; cymbal spot-checks + read-only scouts as needed)
- Eligible grounding scouts: ${state.availableScouts.length ? state.availableScouts.map((scout) => scout.name).join(", ") : "none discovered"}
- Eligible write delegates: ${state.availableWriters.length ? state.availableWriters.map((w) => w.name).join(", ") : "none discovered"}
- Output preference: ${describeOutputPreference(state)}

## Decisions

- Grill mode uses a single thorough default style.
- Grill mode should adapt to the subject rather than force hardcoded interview phases.
- A hardcoded output-selection phase is mandatory at the end of the interview before output production or stopping.
- Grill mode must not assume a default output. The assistant must explicitly ask which output(s) to produce.

## Assumptions

- The checkpoint should evolve as meaningful understanding changes.
- The assistant should ask enough follow-up questions to resolve the decision tree instead of rushing to readiness.

## Risks / Unknowns

- The user's desired outcome mode and output set may still be ambiguous.
- Some branches may need to be explicitly deferred if they are not worth resolving now.

## Coverage Checklist

Use this as an adaptive checklist, not a rigid phase order. Mark each branch resolved, intentionally deferred, or still open.

- [ ] Desired outcome and success criteria
- [ ] Scope boundaries and non-goals
- [ ] User/audience/stakeholder context
- [ ] Constraints, dependencies, and available resources
- [ ] Alternatives, tradeoffs, and decision criteria
- [ ] Risks, failure modes, edge cases, and open unknowns
- [ ] Validation, testing, or evidence plan
- [ ] Rollout/next steps and ownership
- [ ] Output artifact selection (only in the mandatory terminal phase)

## Decision Branches

- Root: clarify the user's desired outcome and success criteria, then follow dependent branches one at a time.

## Open Questions

- What outcome is the user ultimately trying to achieve with this topic?
- What constraints or risks should shape the next branch of questioning?
- Which output artifact(s) should be produced, if any, once shared understanding is sufficient?

## Explicit Output Destination Options

${outputDestinationOptionsMarkdown()}
`;
}

export function statusMarkdown(state: GrillState): string {
	return `# Grill Status

- Active: ${state.active ? "yes" : "no"}
- Topic: ${state.topic || "(none)"}
- Intent: ${state.intent}
- Style: thorough default
- Research: ${state.researchMode}
- Phase: ${phaseLabel(state)}
- Output preference: ${describeOutputPreference(state)}
- Subagent integration: ${state.subagents === false ? "off (/grill subagents on to re-enable)" : "on (/grill subagents off to disable)"}
${
	state.outputSelection
		? `- Output selection rationale: ${state.outputSelection.readinessRationale}
- Recommended outputs: ${state.outputSelection.recommendedOutputs}
- Recommended strategy: ${state.outputSelection.recommendedStrategy}
`
		: ""
}${
	state.approvedOutputPlan
		? `- Approved output plan: ${state.approvedOutputPlan}
`
		: ""
}- Current question: ${state.currentQuestion || "(none)"}
- Picker alternatives: ${state.alternatives.length ? state.alternatives.map((a) => a.label).join(" | ") : "(none set)"}
- Checkpoint last updated: ${state.updatedAt ? new Date(state.updatedAt).toLocaleString() : "never"}
${
	state.grounding
		? `- Last grounding: ${state.grounding.skippedReason ? `skipped — ${state.grounding.skippedReason}` : (state.grounding.source ?? "summary shown")}
`
		: ""
}${
	state.reviewer
		? `- Last reviewer: ${state.reviewer.skippedReason ? `skipped — ${state.reviewer.skippedReason}` : (state.reviewer.source ?? "recorded")} (rounds: ${state.reviewerRounds}/2)\n`
		: ""
}${
	state.lastChangeSummary
		? `- Last checkpoint change: ${state.lastChangeSummary}
`
		: ""
}`;
}

export function appendCheckpointNote(
	checkpoint: string,
	note: string,
	heading = "## Grounding Notes",
): string {
	return checkpoint.includes(heading)
		? `${checkpoint.trimEnd()}
- ${note}
`
		: `${checkpoint.trimEnd()}\n\n${heading}\n\n- ${note}\n`;
}

export function reviewerStatusText(view: GroundingView): string {
	if (view.skippedReason)
		return `⚠ reviewer skipped: ${view.skippedReason}`.slice(0, 100);
	const source = view.source ? ` · ${view.source}` : "";
	return `✓ reviewer${source}`.slice(0, 100);
}

export function reviewerResultText(view: GroundingView): string {
	if (view.skippedReason) return `Reviewer skipped: ${view.skippedReason}`;
	return `Reviewer recorded${view.source ? ` (${view.source})` : ""}. Fix reported gaps if any, then call grill_finish_output_phase.`;
}

export function groundingStatusText(view: GroundingView): string {
	if (view.skippedReason)
		return `⚠ grounding skipped: ${view.skippedReason}`.slice(0, 100);
	const source = view.source ? ` · ${view.source}` : "";
	return `✓ grounding${source}`.slice(0, 100);
}

export function groundingResultText(view: GroundingView): string {
	if (view.skippedReason)
		return `Grounding skipped: ${view.skippedReason}. Continue ungrounded.`;
	return `Grounding recorded${view.source ? ` (${view.source})` : ""}. Ask the next question.`;
}

/** Derive the end-of-process reviewer task from the approved output plan and
 * the checkpoint. The reviewer verifies sync: checkpoint decisions vs produced
 * outputs vs edited files. Always read-only; never mutates. */
export function deriveReviewerTask(
	plan: string | undefined,
	checkpoint: string | undefined,
): string {
	const head =
		"You are a read-only reviewer for a Grill Me session. Inspect the repository with read-only tools only; do not edit, write, or apply any change. Verify that the grill session stayed in sync and report a concise verdict: PASS or a bulleted list of gaps (file:symbol where possible).";
	const syncPart =
		"Check three-way sync: (1) the checkpoint decisions below actually hold in the repo; (2) the produced outputs match what the checkpoint claims was produced; (3) edited files (git status/diff) match the declared output plan and the checkpoint's decisions. Flag anything stale, contradicted, or missing.";
	const planPart = plan
		? `\n\nApproved output plan:\n${plan.slice(0, 2000)}`
		: "";
	const checkpointPart = checkpoint
		? `\n\nCheckpoint (decisions + coverage):\n${checkpoint.slice(0, 6000)}`
		: "";
	return `${head}\n\n${syncPart}${planPart}${checkpointPart}`;
}

export function buildSystemPrompt(state: GrillState): string {
	const thoroughGrillingGuidance = [
		"Use one thorough default style throughout the interview.",
		"Be relentlessly curious but collaborative: challenge vague answers, surface contradictions, and test assumptions without changing persona.",
		"Ask enough follow-up questions to resolve the decision tree. Prefer one more high-value question over premature readiness.",
		"Maintain a coverage checklist and decision-branch ledger in the checkpoint; mark branches resolved, deferred, or still open as understanding evolves.",
		"Walk dependent branches one at a time. If an answer changes upstream assumptions, revisit affected downstream decisions before moving on.",
		"Do not enter output selection until major objective, scope, constraints, dependencies, risks, validation, and output branches are resolved or explicitly deferred.",
	].join("\n- ");

	const researchGuidance: Record<ResearchMode, string> = {
		off: "Do not proactively inspect files or research. Ask the user instead unless they explicitly provide context.",
		ask: "If a question could be answered by inspecting files/code/research, ask permission before doing so.",
		auto: "For coding/project contexts, if a question can be answered by inspecting available files/code, inspect instead of asking. Use read-only tools during interview mode.",
	};

	const groundingGuidance =
		state.subagents === false
			? "Subagent integration is OFF for this session (/grill subagents on re-enables). Ground with cymbal tools only; do not call subagents."
			: 'Grounding is first-class. A compact repo dossier was captured at session start — use it; before each repo-relevant question, use cymbal_* tools first when they can answer. If cymbal cannot answer, call subagent({ action: "list", capabilities: true }), pass its live capability rows to grill_set_scouts, then run one eligible read-only scout with subagent({ agent, task }). Call grill_show_grounding with a concise evidence summary before the question. If grounding fails, call grill_show_grounding with skippedReason and continue ungrounded. If a scout reports follow-up work, use subagent mission.create/missionId for durable escalation rather than silently launching repeated work.';

	const phase = currentPhase(state);
	const delegationGuidance =
		state.delegate === true
			? `Write delegation is ON for this batch: the parent is blocked from edit/write; spawn the writer subagent (${state.chosenWriter ?? "the chosen writer"}) with subagent({ agent, output, task }) where output is an approved output path; the extension blocks writer spawns whose output is outside the approved plan. The parent keeps CLI mutations (gh/git). Run the writer BEFORE the advisory audit (the audit window blocks non-auditor spawns). If the writer fails or times out, fall back to finishing the writes yourself and notify the user.`
			: state.delegate === false
				? "Write delegation is OFF for this batch: the parent writes the approved outputs directly."
				: "";
	const writerDiscoveryGuidance =
		phase === "output-selection"
			? ' After the user approves outputs, if they may want to delegate file writes, call subagent({ action: "list", capabilities: true }) and pass the rows to grill_set_writers to discover write-capable delegates. grill_enter_output_phase will then ask (via a picker) whether to delegate; the picker is skipped if no write delegate exists.'
			: "";
	const outputPhaseGuidance =
		phase === "output"
			? `Approved output phase: produce only the approved outputs. If a required mutation is blocked by permissions, auth, or repo setup, ask the user instead of bypassing or faking success. ${GITHUB_REPO_PERMISSION_GUIDANCE} ${delegationGuidance} When done, call grill_finish_output_phase. If subagent integration is on, run ONE end-of-process reviewer pass: call subagent({ action: "list", capabilities: true }), pass the rows to grill_run_reviewer (it spawns one read-only reviewer, records PASS or a gap list, and caps at 2 rounds). If gaps are reported, fix them, then call grill_run_reviewer once more; the cap is hard.`
			: phase === "output-selection"
				? `You are in the mandatory output-selection phase. Do not ask new interview questions unless the user chooses to continue grilling. Ask the user to choose outputs/continue/review/stop from the active output-selection alternatives. If they approve concrete output production, call grill_enter_output_phase. If they choose to continue or stop without output, call grill_finish_output_selection_phase.${writerDiscoveryGuidance}`
				: "You are in read-only interview mode. Do not implement, write files, create issues, install packages, run mutating commands, or stop the Grill Me work. When ready to end the interview, first update the checkpoint if needed, then call grill_enter_output_selection_phase to enter the mandatory hardcoded output-selection phase before output production or stopping.";

	const outputSelectionSummary = state.outputSelection
		? `\n\nActive output selection:\n- Rationale: ${state.outputSelection.readinessRationale}\n- Recommended outputs: ${state.outputSelection.recommendedOutputs}\n- Recommended strategy: ${state.outputSelection.recommendedStrategy}\n- Question: ${state.outputSelection.question}`
		: "";

	const prompt = `\n\n[GRILL ME EXTENSION ACTIVE]\nTopic:\n${state.topic}\n\nConfiguration:\n- Intent preset: ${state.intent}\n- Grilling style: thorough default
- Research mode: ${state.researchMode}
- Grounding: first-class (auto dossier at start; cymbal spot-checks + read-only scouts as needed)
- Subagent integration: ${state.subagents === false ? "off (/grill subagents on re-enables)" : "on"}
- Output preference: ${describeOutputPreference(state)}
- Phase: ${phase}\n- Output phase: ${state.outputPhase ? "yes" : "no"}${outputSelectionSummary}\n\nCurrent checkpoint:\n${state.checkpoint || "(No checkpoint yet.)"}\n\nCurrent picker alternatives (shown in the ↑/↓ + Enter overlay):\n${state.alternatives.length ? state.alternatives.map((a) => `- ${a.label}: ${a.value}${a.description ? ` (${a.description})` : ""}`).join("\n") : "(None set.)"}\n\nDecisions so far:\n${state.decisions.length ? state.decisions.map((d) => `- ${d.question} → ${d.label}${d.note ? ` (note: ${d.note})` : ""}`).join("\n") : "(None recorded.)"}\n\nBehavior:\n- Apply the Socratic method to reach shared understanding of the topic.\n- Avoid hardcoded interview phases. Adapt the dimensions you explore to the subject and to the user's expertise.\n- The output-selection phase is the one hardcoded terminal phase: it is mandatory before stopping the Grill Me work, stopping without outputs, or producing outputs.\n- Treat desired outcome mode as important: learning, building, researching, content/tutorial creation, decision review, etc.\n- Do not set or assume a default output mode for the session. A missing output preference means no output has been chosen yet, not design-doc or any other default.\n- Treat /grill output as a preference only, not production approval. Always explicitly ask/confirm which output(s) to produce before output production.\n- Support 1..n outputs in one approved output plan; for example, a design doc AND uploaded GitHub issues.\n- The output-selection phase must explicitly mention concrete output destinations by name. Use this catalog and allow custom combinations:\n${outputDestinationOptionsMarkdown()}\n- ${groundingGuidance}
- Ask mostly one focused question at a time. Small grouped questions are allowed only when inseparable.
- Ask more than the minimum needed for a shallow summary: keep drilling until the meaningful dependency branches are resolved, contradicted, or intentionally deferred.\n- Every grill question must present 2-5 concrete answer alternatives. Before asking the question, call grill_set_alternatives with 2-5 concrete alternatives (and optional previews); it opens an ↑/↓ + Enter picker overlay with a "Type something." custom-answer row and an n-note key, and returns the user's structured answer as the tool result. Show the same alternatives briefly in chat, and record the picked answer (with any note) as a structured decision in the checkpoint before asking the next question.\n- Include your recommended answer by default with each grill question and mark it as recommended.\n- ${thoroughGrillingGuidance}\n- ${researchGuidance[state.researchMode]}\n- ${outputPhaseGuidance}\n\nCheckpoint rule:\n- The checkpoint is the source of durable shared understanding.\n- Whenever the user's answer meaningfully changes shared understanding, call grill_update_checkpoint with a full replacement Markdown checkpoint and a concise changeSummary BEFORE asking the next grill question.\n- The checkpoint should be adaptive Markdown. Add/remove sections as appropriate for the topic.\n- Keep a coverage checklist and decision-branch ledger in the checkpoint when useful; update branch status as resolved, open, contradicted, or intentionally deferred.\n- If there is no meaningful change, you may ask the next question without updating.\n\nReadiness/output rule:\n- When you think shared understanding is good enough, do not merely present a prompt-only readiness gate. First verify that the major coverage branches are resolved or explicitly deferred, then call grill_enter_output_selection_phase with the rationale, recommended output destination(s), recommended strategy, explicit output-selection question, and 2-5 alternatives.\n- The mandatory output-selection phase must explicitly ask the user which output(s) to produce, even if you have a recommendation or /grill output preference. In the chat response, name the concrete options from the catalog above, including GitHub issues, design doc, README.md, ADR, PRD, implementation plan, research brief, summary/decision memo, tutorial/content outline, test plan/QA checklist, and changelog/release notes.\n- Offer useful single-output and multi-output alternatives where appropriate, and make clear the user can choose 1..n outputs or customize the list.\n- Output-selection alternatives should include continue grilling and/or review checkpoint when useful, and stop-without-output when producing no artifact is a reasonable choice.\n- Output destination and strategy are separate. For example, GitHub issues can be implementation slices, tutorial chapters, research investigations, content installments, or prototype experiments.\n- For file outputs, draft before writing. For GitHub issues, preview titles/bodies/labels before creating. For multiple outputs, preview the full set and dependencies/order before creation.\n- Mutating output actions require explicit user approval of the concrete output set/plan, an active output-selection phase, and grill_enter_output_phase first.\n- During approved output phase, perform only approved mutations, and do not refuse approved mutating output actions merely because they mutate state. If a permission/authentication/tool/repo setup gate blocks an approved mutation (for example gh issue create), ask the user for permission, confirmation, credentials, or a revised plan instead of bypassing or faking success. ${GITHUB_REPO_PERMISSION_GUIDANCE}\n- If the user chooses to continue grilling or stop without output during output selection, call grill_finish_output_selection_phase with that outcome.\n[/GRILL ME EXTENSION ACTIVE]`;

	return prompt;
}
