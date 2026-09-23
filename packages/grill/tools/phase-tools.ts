import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type IsolationSetting,
	isolationBranchName,
	isolationPickerText,
	type ResolvedIsolation,
	resolveIsolation,
} from "../backends/backend.js";
import {
	detectGitbutlerMode,
	isButBinaryPresent,
} from "../backends/gitbutler-detect.js";
import {
	DELEGATE_OPTIONS,
	GITHUB_REPO_PERMISSION_GUIDANCE,
	OUTPUT_DESTINATION_OPTIONS,
	outputDestinationOptionNames,
	outputDestinationOptionsMarkdown,
} from "../options.js";
import { showPicker } from "../picker.js";
import type { GrillHelpers } from "../runtime.js";
import { parsePlanPaths, sliceApprovedPaths } from "../slicer.js";
import {
	approvedOutputPaths,
	currentPhase,
	type GrillAlternative,
	type GrillState,
	normalizeAlternatives,
	runtime,
} from "../state.js";

const ISOLATION_VALUES = new Set(["worktrees", "gitbutler", "slices", "auto"]);

function asIsolationSetting(value: unknown): IsolationSetting | undefined {
	return typeof value === "string" && ISOLATION_VALUES.has(value)
		? (value as IsolationSetting)
		: undefined;
}

function gitWorkingTreeIsClean(repoRoot: string): boolean {
	try {
		const result = spawnSync("git", ["status", "--porcelain"], {
			cwd: repoRoot,
			timeout: 5000,
			encoding: "utf8",
		});
		return result.status === 0 && (result.stdout?.trim() ?? "") === "";
	} catch {
		return false;
	}
}

function parseConventionalScope(plan: string): { type: string; scope: string } {
	const lines = plan.split(/\r?\n/);
	const firstContent = lines.find((line) => {
		const trimmed = line.trim();
		return trimmed && !trimmed.startsWith("#");
	});
	const match = firstContent?.match(
		/^(feat|fix|chore|docs|style|refactor|test|build|ci|perf)(\([^)\s]+\))?!?:/,
	);
	return {
		type: match?.[1] ?? "feat",
		scope: match?.[2] ? match[2].slice(1, -1) : "grill",
	};
}

function isolationNoteText(
	resolved: ResolvedIsolation,
	_setting: IsolationSetting,
): string {
	const parts: string[] = [];
	if (resolved.backend !== "slices") {
		parts.push(isolationPickerText(resolved));
	} else if (resolved.reason) {
		parts.push(`${resolved.backend} (${resolved.reason})`);
	}
	return parts.join(" ");
}

function gitbutlerBranchNames(sliceCount: number, plan: string): string[] {
	const { type, scope } = parseConventionalScope(plan);
	const names: string[] = [];
	for (let i = 0; i < sliceCount; i++) {
		names.push(isolationBranchName(type, scope, names));
	}
	return names;
}

function slicesDelegationText(): string {
	return `Slice the approved paths into disjoint file sets and spawn one writer subagent per slice with subagent({ agent: <writer>, output: <approved path from that slice>, task: <that slice's spec> }); each writer must only edit the paths in its assigned slice (enforced by the task spec; runtime gates spawns to the whole approved plan). If a writer fails, finish its slice yourself and notify the user.`;
}

function worktreesDelegationText(slices: { paths: string[] }[]): string {
	const lines = slices
		.map(
			(_, i) =>
				`Slice ${i + 1}: subagent({ agent: <writer>, output: <approved path from slice ${i + 1}>, task: <slice ${i + 1} spec>, worktree: true, baseRef: "HEAD", async: false })`,
		)
		.join("\n");
	return `Delegation uses managed git worktrees. Slice the approved paths into disjoint file sets and spawn one writer subagent per slice:\n${lines}\nEach writer must do its slice work in its managed worktree, commit there via bash (git add/commit), and END its report with a line \`BRANCH: <branch-name>\` (the worktree's checked-out branch). Each writer runs blocking (async: false); when a spawn returns, immediately merge its reported branch into the source checkout (git merge <branch-name>) before spawning the next writer. Any merge failure pauses and notifies the user: either run git merge --abort to bail, or resolve the conflicts and commit to continue. After merges, surface the \`worktree.cleanup\` plan invocation (lane.recordMerge attestation when available) — plan only, grill never auto-deletes worktrees.`;
}

function gitbutlerDelegationText(
	slices: { paths: string[] }[],
	plan: string,
): string {
	const branches = gitbutlerBranchNames(slices.length, plan);
	const branchList = branches.map((b, i) => `Slice ${i + 1}: ${b}`).join("\n");
	return `Delegation uses GitButler virtual branches. Slice the approved paths into disjoint file sets. Parent pre-creates one branch per slice via \`but branch new <name>\`:\n${branchList}\nSpawn one writer subagent per slice with subagent({ agent: <writer>, output: <approved path from that slice>, task: <that slice's spec> }). Each writer must: after editing, run \`but diff\` to collect its slice's change IDs, then commit with \`but commit -b <branch> <ids> -m "<conventional message>"\` (always \`-m\` or \`--no-message\`; never a bare \`but commit\`; never \`but push\`). Parent never runs \`but commit\`. Conflicts/overlaps must be surfaced before committing.`;
}

function delegationInstructionText(
	resolved: ResolvedIsolation,
	slices: { paths: string[] }[],
	plan: string,
): string {
	switch (resolved.backend) {
		case "worktrees":
			return worktreesDelegationText(slices);
		case "gitbutler":
			return gitbutlerDelegationText(slices, plan);
		default:
			return slicesDelegationText();
	}
}

export function registerPhaseTools(
	pi: ExtensionAPI,
	helpers: GrillHelpers,
): void {
	const { persist, updateUi } = helpers;
	pi.registerTool({
		name: "grill_enter_output_selection_phase",
		label: "Enter Grill Output Selection",
		description: `Enter the mandatory hardcoded output-selection phase at the end of the Grill Me interview before stopping or producing outputs. The phase must explicitly mention available output destinations: ${outputDestinationOptionNames()}.`,
		promptSnippet: "Start the mandatory Grill Me output-selection phase",
		promptGuidelines: [
			"Use grill_enter_output_selection_phase after the final checkpoint update when the Grill Me interview is ready to end.",
			"Do not stop a Grill Me interview, claim the work is complete, or enter output production until grill_enter_output_selection_phase has been called and the user has selected what happens next.",
			`In the output-selection chat response, explicitly list these output destination options before asking for a choice: ${outputDestinationOptionNames()}.`,
		],
		parameters: Type.Object({
			readinessRationale: Type.String({
				description:
					"Why shared understanding is sufficient to leave interview mode.",
			}),
			recommendedOutputs: Type.String({
				description: `One or more recommended output destinations/formats from the explicit catalog (${outputDestinationOptionNames()}), or 'none' if no artifact is recommended.`,
			}),
			recommendedStrategy: Type.String({
				description:
					"Recommended output strategy, distinct from destination/format.",
			}),
			question: Type.String({
				description:
					"The explicit output-selection question to ask the user. It should name concrete output options rather than saying only 'outputs'.",
			}),
			alternatives: Type.Array(
				Type.Object({
					value: Type.String({
						description:
							"The exact reply inserted into the user's editor when selected.",
					}),
					label: Type.String({
						description: "Short visible label for the alternative.",
					}),
					description: Type.Optional(
						Type.String({
							description: "Brief explanation or recommendation note.",
						}),
					),
					preview: Type.Optional(
						Type.String({
							description:
								"Optional markdown preview shown when this option is focused in the picker.",
						}),
					),
				}),
				{
					description:
						"2-5 choices covering produce output(s), continue grilling, review checkpoint, or stop with no output as appropriate.",
				},
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!runtime.state.active) {
				return {
					content: [
						{
							type: "text",
							text: "No active Grill Me session. Start one with /grill <topic>.",
						},
					],
					details: { phase: currentPhase(runtime.state) },
				};
			}
			runtime.state.phase = "output-selection";
			runtime.state.outputPhase = false;
			runtime.state.outputSelection = {
				readinessRationale: params.readinessRationale,
				recommendedOutputs: params.recommendedOutputs,
				recommendedStrategy: params.recommendedStrategy,
				question: params.question,
			};
			runtime.state.approvedOutputPlan = undefined;
			runtime.state.delegate = undefined;
			runtime.state.chosenWriter = undefined;
			runtime.state.outputPaths = undefined;
			runtime.state.outputSlices = [];
			runtime.state.writerDiscoveryRequired = undefined;
			runtime.state.availableWriters = [];
			runtime.state.resolvedIsolation = undefined;
			runtime.state.currentQuestion = params.question;
			runtime.state.alternatives = normalizeAlternatives(
				params.alternatives as GrillAlternative[],
			);
			runtime.state.lastChangeSummary =
				"Entered mandatory output-selection phase";
			persist();
			if (ctx) updateUi(ctx);

			if (ctx?.hasUI) {
				const result = await showPicker(
					ctx,
					params.question,
					runtime.state.alternatives,
				);
				if (result.status === "answered") {
					runtime.state.decisions = [
						...runtime.state.decisions,
						{
							question: params.question,
							value: result.value,
							label: result.label,
							custom: result.custom,
							note: result.note,
							at: Date.now(),
						},
					];
					runtime.state.lastChangeSummary = `Output selection answered: ${result.label}`;
					persist();
					return {
						content: [
							{
								type: "text",
								text: `User chose: ${result.label}${result.custom ? ` (custom: "${result.value}")` : ` (${result.value})`}${result.note ? `\nNote: ${result.note}` : ""}\n\nIn the chat response, name the concrete output options from the catalog (GitHub issues, Design doc, README.md, ADR, PRD, Implementation plan, Research brief, Summary / decision memo, Tutorial / content outline, Test plan / QA checklist, Changelog / release notes). If the user approved concrete output production, call grill_enter_output_phase; if they chose to continue or stop without output, call grill_finish_output_selection_phase.`,
							},
						],
						details: {
							phase: currentPhase(runtime.state),
							outputSelection: runtime.state.outputSelection,
							result,
							alternatives: runtime.state.alternatives,
						},
					};
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `Output-selection phase is active. In the chat response, explicitly show these output destination options:\n${outputDestinationOptionsMarkdown()}\n\nThen ask the user to choose one or more, customize the set, continue grilling, review the checkpoint, or stop without output. Alternatives: ${runtime.state.alternatives.map((a) => a.label).join(", ")}`,
					},
				],
				details: {
					phase: currentPhase(runtime.state),
					outputSelection: runtime.state.outputSelection,
					outputDestinationOptions: OUTPUT_DESTINATION_OPTIONS,
					alternatives: runtime.state.alternatives,
				},
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg(
					"toolTitle",
					theme.bold("grill_enter_output_selection_phase "),
				) + theme.fg("muted", args.question ?? ""),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const selection = (
				result.details as
					| { outputSelection?: GrillState["outputSelection"] }
					| undefined
			)?.outputSelection;
			const text = selection
				? `✓ Output selection: ${selection.recommendedOutputs}`
				: result.content[0]?.type === "text"
					? result.content[0].text
					: "Output selection phase updated";
			return new Text(theme.fg(selection ? "success" : "warning", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "grill_finish_output_selection_phase",
		label: "Finish Grill Output Selection",
		description:
			"Resolve the mandatory output-selection phase without entering output production, either by continuing the interview or stopping with no outputs.",
		promptSnippet:
			"Resolve Grill Me output selection without output production",
		promptGuidelines: [
			"Use grill_finish_output_selection_phase when the user responds to the mandatory output-selection phase by choosing to continue grilling or stop without producing outputs.",
			"If the user approves concrete output production, use grill_enter_output_phase instead.",
		],
		parameters: Type.Object({
			outcome: Type.String({
				description: "Either 'continue-grilling' or 'stop-without-output'.",
			}),
			summary: Type.Optional(
				Type.String({
					description: "Brief summary of the user's output-selection decision.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
					},
				};
			}
			if (currentPhase(runtime.state) !== "output-selection") {
				return {
					content: [
						{
							type: "text",
							text: "No active output-selection phase. Call grill_enter_output_selection_phase before resolving output selection.",
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
					},
				};
			}

			const outcome = String(params.outcome ?? "")
				.trim()
				.toLowerCase();
			if (
				outcome === "continue-grilling" ||
				outcome === "continue" ||
				outcome === "grill"
			) {
				runtime.state.phase = "interview";
				runtime.state.outputPhase = false;
				runtime.state.outputSelection = undefined;
				runtime.state.delegate = undefined;
				runtime.state.chosenWriter = undefined;
				runtime.state.outputPaths = undefined;
				runtime.state.outputSlices = [];
				runtime.state.writerDiscoveryRequired = undefined;
				runtime.state.availableWriters = [];
				runtime.state.resolvedIsolation = undefined;
				runtime.state.currentQuestion = undefined;
				runtime.state.alternatives = [];
				runtime.state.lastChangeSummary = params.summary
					? `Output selection resolved: ${params.summary}`
					: "Output selection resolved: continue grilling";
				persist();
				if (ctx) updateUi(ctx);
				return {
					content: [
						{
							type: "text",
							text: "Returned to Grill Me interview mode. Ask the next Socratic question with grill_set_alternatives.",
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
						outcome,
					},
				};
			}

			if (
				outcome === "stop-without-output" ||
				outcome === "stop" ||
				outcome === "no-output" ||
				outcome === "none"
			) {
				runtime.state.active = false;
				runtime.state.phase = "interview";
				runtime.state.outputPhase = false;
				runtime.state.outputSelection = undefined;
				runtime.state.approvedOutputPlan = undefined;
				runtime.state.delegate = undefined;
				runtime.state.chosenWriter = undefined;
				runtime.state.outputPaths = undefined;
				runtime.state.outputSlices = [];
				runtime.state.writerDiscoveryRequired = undefined;
				runtime.state.availableWriters = [];
				runtime.state.resolvedIsolation = undefined;
				runtime.state.currentQuestion = undefined;
				runtime.state.alternatives = [];
				runtime.state.lastChangeSummary = params.summary
					? `Stopped after output selection: ${params.summary}`
					: "Stopped after output selection without outputs";
				persist();
				if (ctx) updateUi(ctx);
				return {
					content: [{ type: "text", text: runtime.state.lastChangeSummary }],
					details: {
						phase: currentPhase(runtime.state),
						active: runtime.state.active,
						outcome,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: "Unsupported outcome. Use 'continue-grilling' or 'stop-without-output'. If outputs were approved, call grill_enter_output_phase instead.",
					},
				],
				details: {
					phase: currentPhase(runtime.state),
					active: runtime.state.active,
					outcome,
				},
			};
		},
	});

	pi.registerTool({
		name: "grill_enter_output_phase",
		label: "Enter Grill Output Phase",
		description:
			"Mark that the user approved output production after mandatory output selection, allowing the assistant to use tools required to create the approved artifacts.",
		promptSnippet: "Enter approved Grill Me output-production phase",
		promptGuidelines: [
			"Use grill_enter_output_phase only after grill_enter_output_selection_phase has run and the user explicitly approves a concrete output plan or preview during an active Grill Me session.",
			"During output phase, do not refuse approved mutating output work merely because it mutates runtime.state, such as creating GitHub issues. If a tool, CLI, platform, or pi permission/authentication gate blocks the mutation, stop and ask the user for the needed permission, confirmation, credentials, or plan change; do not bypass it or broaden scope.",
			"When subagent integration is on and delegation is unset, this tool enforces writer discovery: the model must call subagent({ action: 'list', capabilities: true }), pass write-capable executable agents to grill_set_writers, then re-call grill_enter_output_phase. Once writers are available, the tool asks (via picker) whether to delegate. When delegating, approved paths are sliced into disjoint file sets and one writer subagent is spawned per slice with subagent({ agent, output, task }); the parent is blocked from edit/write and keeps CLI mutations (gh/git) only. Once discovery runs with zero rows, delegation is skipped this session — parent writes directly; grill_set_writers with eligible rows re-enables it.",
			GITHUB_REPO_PERMISSION_GUIDANCE,
		],
		parameters: Type.Object({
			outputPlan: Type.String({
				description:
					"The approved output plan, including one or more outputs/artifacts/files/issues and intended tool use.",
			}),
			delegate: Type.Optional(
				Type.Boolean({
					description:
						"If true, delegate approved file writes to write-capable subagents (parent stays read-only for files, keeps CLI mutations). If false, parent writes directly. When omitted and subagent integration is on, writer discovery is enforced first; once grill_set_writers populates eligible writers, the user is asked via a picker.",
				}),
			),
			writer: Type.Optional(
				Type.String({
					description:
						"Override the canonical-first writer selection with a specific eligible writer name. Must be in runtime.state.availableWriters.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!runtime.state.active) {
				return {
					content: [{ type: "text", text: "No active Grill Me session." }],
					details: {
						phase: currentPhase(runtime.state),
						outputPhase: false,
						outputPlan: params.outputPlan,
					},
				};
			}
			if (
				currentPhase(runtime.state) !== "output-selection" &&
				!runtime.state.outputPhase
			) {
				return {
					content: [
						{
							type: "text",
							text: "Output production requires the mandatory output-selection phase first. Call grill_enter_output_selection_phase, ask the user to choose/approve outputs, then call grill_enter_output_phase.",
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						outputPhase: false,
						outputPlan: params.outputPlan,
					},
				};
			}

			// Per-batch write-delegation runtime.state. Reset, then resolve via param or
			// picker. If subagent integration is on but no eligible writers have been
			// discovered yet, gate entry until the model completes the one-step discovery
			// handshake: subagent list → grill_set_writers → re-enter output phase.
			// If grill_set_writers already reported zero eligible writers, skip the gate and
			// fall through to direct parent writes for this session.
			runtime.state.delegate = undefined;
			runtime.state.chosenWriter = undefined;
			runtime.state.outputSlices = [];
			runtime.state.writerDiscoveryRequired = undefined;

			const subagentsOff = runtime.state.subagents === false;
			let delegate = subagentsOff ? false : params.delegate;

			if (delegate === true && runtime.state.availableWriters.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: 'Delegation requested but no write-capable subagents are discovered. Call subagent({ action: "list", capabilities: true }) and pass rows to grill_set_writers, or call grill_enter_output_phase with delegate:false to have the parent write directly.',
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						outputPhase: false,
						outputPlan: params.outputPlan,
						delegate: false,
						availableWriters: runtime.state.availableWriters,
					},
				};
			}

			if (
				delegate === undefined &&
				runtime.state.availableWriters.length === 0 &&
				runtime.state.writersUnavailable !== true
			) {
				runtime.state.writerDiscoveryRequired = true;
				runtime.state.lastChangeSummary =
					"Output phase gated: writer discovery required";
				persist();
				if (ctx) updateUi(ctx);
				return {
					content: [
						{
							type: "text",
							text: 'Writer delegation requires discovery first: call subagent({ action: "list", capabilities: true }), filter write-capable executable agents (mutation tools include edit/write, or name ends with "writer"), pass the rows to grill_set_writers, then call grill_enter_output_phase again.',
						},
					],
					details: {
						phase: currentPhase(runtime.state),
						outputPhase: false,
						outputPlan: params.outputPlan,
						writerDiscoveryRequired: true,
					},
				};
			}

			// Resolve isolation backend once per batch. Skip expensive probes when
			// subagents are off; resolveIsolation returns the slices backend with the
			// "subagents off" reason.
			const repoRoot = process.cwd();
			let isGitbutlerMode = false;
			let butBinary = false;
			let isCleanTree = false;
			if (!subagentsOff) {
				const gb = detectGitbutlerMode(repoRoot);
				isGitbutlerMode = gb.isGitbutlerMode;
				butBinary = gb.isGitbutlerMode ? isButBinaryPresent() : false;
				isCleanTree = gitWorkingTreeIsClean(repoRoot);
			}
			const setting =
				asIsolationSetting(runtime.state.sessionIsolationOverride) ??
				asIsolationSetting(runtime.state.isolationSetting) ??
				"auto";
			const resolved = resolveIsolation({
				setting,
				isGitbutlerMode,
				butBinary,
				isCleanTree,
				subagentsOn: runtime.state.subagents !== false,
			});
			runtime.state.resolvedIsolation = {
				backend: resolved.backend,
				reason: resolved.reason,
			};

			if (delegate === undefined && runtime.state.availableWriters.length > 0) {
				if (ctx?.hasUI) {
					const paths = parsePlanPaths(params.outputPlan);
					const slices =
						paths.length > 0
							? sliceApprovedPaths(paths, paths.length >= 6 ? 5 : 3)
							: [];
					const options = [...DELEGATE_OPTIONS];
					const isolationNote = isolationNoteText(resolved, setting);
					if (paths.length > 0) {
						options[0] = {
							...options[0],
							description: `Plan has ${paths.length} file path${paths.length === 1 ? "" : "s"} → up to ${slices.length} writer${slices.length === 1 ? "" : "s"} with disjoint file sets. ${options[0].description}${isolationNote ? `\n${isolationNote}` : ""}`,
						};
					} else if (isolationNote) {
						options[0] = {
							...options[0],
							description: `${options[0].description}\n${isolationNote}`,
						};
					}
					const result = await showPicker(
						ctx,
						"Delegate approved file writes to writer subagents, or have the parent write directly?",
						options,
					);
					delegate = result.status === "answered" && result.value === "yes";
				} else {
					delegate = false;
				}
			} else if (delegate === undefined) {
				delegate = false;
			}
			runtime.state.delegate = delegate;
			if (delegate) {
				const requested = params.writer?.trim();
				const writer = requested
					? runtime.state.availableWriters.find((w) => w.name === requested)
					: runtime.state.availableWriters[0];
				runtime.state.chosenWriter = writer?.name;
			}

			runtime.state.phase = "output";
			runtime.state.outputPhase = true;
			runtime.state.approvedOutputPlan = params.outputPlan;
			runtime.state.outputPaths = approvedOutputPaths(params.outputPlan);
			if (delegate) {
				const paths = parsePlanPaths(params.outputPlan);
				runtime.state.outputSlices = sliceApprovedPaths(
					paths,
					paths.length >= 6 ? 5 : 3,
				);
			}
			// Keep availableWriters populated through the output phase: events.ts
			// uses it to block writer spawns whose output path is outside the
			// approved plan. Cleared again in finish_output_phase.
			runtime.state.reviewer = undefined;
			runtime.state.reviewerRounds = 0;
			const slices = runtime.state.outputSlices ?? [];
			const isolationNote = isolationNoteText(resolved, setting);
			const directText =
				runtime.state.writersUnavailable === true
					? `No write-capable subagents available — parent writes directly (grill_set_writers with eligible rows re-enables delegation). ${isolationNote ? `${isolationNote}\n\n` : ""}${GITHUB_REPO_PERMISSION_GUIDANCE}`
					: `Parent writes the approved outputs directly. ${isolationNote ? `${isolationNote}\n\n` : ""}${GITHUB_REPO_PERMISSION_GUIDANCE}`;
			const delegationText = runtime.state.delegate
				? `${delegationInstructionText(resolved, slices, params.outputPlan)}\n\n${GITHUB_REPO_PERMISSION_GUIDANCE}`
				: directText;
			runtime.state.lastChangeSummary = runtime.state.delegate
				? `Entered approved output phase (delegating file writes to ${runtime.state.chosenWriter ?? "?"})`
				: "Entered approved output phase (parent writes directly)";
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Output phase enabled for approved plan:\n${params.outputPlan}\n\n${delegationText}`,
					},
				],
				details: {
					phase: currentPhase(runtime.state),
					outputPhase: true,
					outputPlan: params.outputPlan,
					delegate: runtime.state.delegate,
					chosenWriter: runtime.state.chosenWriter,
					outputSlices: runtime.state.outputSlices,
					availableWriters: runtime.state.availableWriters,
					resolvedIsolation: runtime.state.resolvedIsolation,
				},
			};
		},
	});

	pi.registerTool({
		name: "grill_finish_output_phase",
		label: "Finish Grill Output Phase",
		description:
			"Return an active Grill Me session to read-only interview/planning enforcement after output production.",
		promptSnippet:
			"Return Grill Me to read-only interview mode after output production",
		parameters: Type.Object({
			summary: Type.Optional(
				Type.String({ description: "Brief summary of outputs created." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			runtime.state.phase = "interview";
			runtime.state.outputPhase = false;
			runtime.state.outputSelection = undefined;
			runtime.state.approvedOutputPlan = undefined;
			runtime.state.delegate = undefined;
			runtime.state.chosenWriter = undefined;
			runtime.state.outputPaths = undefined;
			runtime.state.outputSlices = [];
			runtime.state.writerDiscoveryRequired = undefined;
			runtime.state.availableWriters = [];
			runtime.state.resolvedIsolation = undefined;
			runtime.state.lastChangeSummary = params.summary
				? `Finished output phase: ${params.summary}`
				: "Finished output phase";
			persist();
			if (ctx) updateUi(ctx);
			return {
				content: [{ type: "text", text: runtime.state.lastChangeSummary }],
				details: {
					phase: currentPhase(runtime.state),
					outputPhase: false,
					summary: params.summary,
				},
			};
		},
	});
}
