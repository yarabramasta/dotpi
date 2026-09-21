import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "./prompts.js";
import { isProbablyReadOnlyBash } from "./read-only.js";
import type { GrillHelpers } from "./runtime.js";
import {
	approvedOutputPaths,
	cloneState,
	DEFAULT_STATE,
	type GrillState,
	isWithinApprovedOutputPath,
	LEGACY_DEFAULT_OUTPUT_PREFERENCE,
	runtime,
	STATE_ENTRY_TYPE,
	STATE_SCHEMA_VERSION,
} from "./state.js";

export function registerEvents(pi: ExtensionAPI, helpers: GrillHelpers): void {
	const { updateUi } = helpers;

	pi.on("tool_call", async (event) => {
		if (!runtime.state.active) return;

		// Audit-window enforcement removed: the audit flow was replaced by the
		// end-of-process reviewer pass (grill_run_reviewer), which spawns its own
		// read-only reviewer via the pi-subagents RPC and needs no spawn window.

		// Write-delegation enforcement (approved output phase only): when the
		// user chose to delegate file writes, the parent is blocked from
		// edit/write so file mutations go through the writer subagent. CLI
		// mutations (gh/git via bash) stay allowed for non-file outputs. Writer
		// subagent spawns are allowed but their declared `output` path must be
		// within the approved plan's output paths; spawns outside are blocked.
		if (runtime.state.outputPhase && runtime.state.delegate === true) {
			if (event.toolName === "edit" || event.toolName === "write") {
				return {
					block: true,
					reason:
						"Grill Me is delegating file writes to a writer subagent this batch. Spawn the writer with subagent({ agent, output, task }) where output is an approved output path; the parent keeps CLI mutations (gh/git) only. If the writer is unavailable or fails, fall back to finishing the writes yourself and notify the user.",
				};
			}
			if (event.toolName === "subagent") {
				const input = (event.input ?? {}) as {
					action?: string;
					agent?: string;
					output?: string | false;
				};
				const isManagement =
					typeof input.action === "string" && input.action.length > 0;
				if (!isManagement) {
					const target =
						typeof input.agent === "string" ? input.agent.trim() : "";
					const isWriter =
						!!target &&
						!!runtime.state.availableWriters.some((w) => w.name === target);
					if (isWriter) {
						const out =
							typeof input.output === "string" ? input.output.trim() : "";
						const approved =
							runtime.state.outputPaths && runtime.state.outputPaths.length > 0
								? runtime.state.outputPaths
								: approvedOutputPaths(runtime.state.approvedOutputPlan);
						if (approved.length === 0) {
							// No paths parsed from the plan → cannot enforce scope; do not block.
						} else if (!out) {
							return {
								block: true,
								reason:
									"Grill Me requires a writer spawn to declare an `output` path within the approved output plan when delegating. Pass output: <approved path> to subagent.",
							};
						} else if (!isWithinApprovedOutputPath(out, approved)) {
							return {
								block: true,
								reason: `Grill Me blocked a writer spawn whose output path is outside the approved output plan. Use an approved output path. Declared output: ${out}`,
							};
						}
					}
				}
			}
		}

		if (runtime.state.outputPhase) return;

		if (event.toolName === "edit" || event.toolName === "write") {
			return {
				block: true,
				reason:
					"Grill Me is read-only until the mandatory output-selection phase runs and the user approves a concrete output plan. Call grill_enter_output_selection_phase first, then grill_enter_output_phase before writing artifacts.",
			};
		}

		if (event.toolName === "bash") {
			const command = String(
				(event.input as Record<string, unknown> | undefined)?.command ?? "",
			);
			if (!isProbablyReadOnlyBash(command)) {
				return {
					block: true,
					reason: `Grill Me read-only mode blocked a potentially mutating command. Run the mandatory output-selection phase with grill_enter_output_selection_phase, get output approval, then call grill_enter_output_phase first.\nCommand: ${command}`,
				};
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (!runtime.state.active) return;

		return {
			systemPrompt: event.systemPrompt + buildSystemPrompt(runtime.state),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		runtime.state = cloneState(DEFAULT_STATE);
		const entries = ctx.sessionManager.getBranch();
		for (const entry of entries as Array<{
			type?: string;
			customType?: string;
			data?: Partial<GrillState>;
		}>) {
			if (
				entry?.type === "custom" &&
				entry.customType === STATE_ENTRY_TYPE &&
				entry.data
			) {
				// Schema gate: only resume entries written by the current schema.
				// Old grill sessions are not resumable (accepted scope cut), but
				// /reload restore within a current-version session still works.
				if (entry.data.schemaVersion !== STATE_SCHEMA_VERSION) continue;
				runtime.state = { ...cloneState(DEFAULT_STATE), ...entry.data };
				if (runtime.state.outputPreference === LEGACY_DEFAULT_OUTPUT_PREFERENCE)
					runtime.state.outputPreference = "";
				if (!runtime.state.phase)
					runtime.state.phase = runtime.state.outputPhase
						? "output"
						: "interview";
				if (runtime.state.phase !== "output") runtime.state.outputPhase = false;
				if (typeof runtime.state.subagents !== "boolean")
					runtime.state.subagents = true;
				if (!Array.isArray(runtime.state.availableScouts))
					runtime.state.availableScouts = [];
				if (!Array.isArray(runtime.state.availableWriters))
					runtime.state.availableWriters = [];
				if (runtime.state.phase !== "output") {
					runtime.state.delegate = undefined;
					runtime.state.chosenWriter = undefined;
					runtime.state.outputPaths = undefined;
				}
				if (
					runtime.state.grounding &&
					typeof runtime.state.grounding !== "object"
				)
					runtime.state.grounding = undefined;
				if (
					runtime.state.reviewer &&
					typeof runtime.state.reviewer !== "object"
				)
					runtime.state.reviewer = undefined;
				if (typeof runtime.state.reviewerRounds !== "number")
					runtime.state.reviewerRounds = 0;
			}
		}
		updateUi(ctx);
	});
}
