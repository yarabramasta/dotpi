import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { groundingStatusText, reviewerStatusText } from "./prompts.js";
import {
	cloneState,
	currentPhase,
	runtime,
	STATE_ENTRY_TYPE,
} from "./state.js";

export interface GrillHelpers {
	persist(): void;
	updateUi(ctx: ExtensionContext): void;
}

export function createRuntime(pi: ExtensionAPI): GrillHelpers {
	function persist(): void {
		runtime.state.updatedAt = Date.now();
		pi.appendEntry(STATE_ENTRY_TYPE, cloneState(runtime.state));
	}

	function updateUi(ctx: ExtensionContext): void {
		if (!runtime.state.active) {
			ctx.ui.setStatus("grill-me", undefined);
			ctx.ui.setStatus("grill-grounding", undefined);
			ctx.ui.setStatus("grill-reviewer", undefined);
			ctx.ui.setStatus("grill-writer", undefined);
			return;
		}

		const state = runtime.state;
		const phase = currentPhase(state);
		const delegateTag =
			phase === "output" && state.delegate === true
				? ` → ${state.chosenWriter ?? "writer"}`
				: "";
		const status =
			phase === "output"
				? `🔥 grill: output${delegateTag}`
				: phase === "output-selection"
					? "🔥 grill: select output"
					: "🔥 grill";
		ctx.ui.setStatus(
			"grill-me",
			ctx.ui.theme.fg(
				phase === "output"
					? "warning"
					: phase === "output-selection"
						? "success"
						: "accent",
				status,
			),
		);
		ctx.ui.setStatus(
			"grill-grounding",
			state.grounding?.skippedReason
				? ctx.ui.theme.fg("warning", groundingStatusText(state.grounding))
				: undefined,
		);
		ctx.ui.setStatus(
			"grill-reviewer",
			state.reviewer?.skippedReason
				? ctx.ui.theme.fg("warning", reviewerStatusText(state.reviewer))
				: state.reviewer
					? ctx.ui.theme.fg("success", reviewerStatusText(state.reviewer))
					: undefined,
		);
		ctx.ui.setStatus(
			"grill-writer",
			phase === "output" && state.delegate === true
				? ctx.ui.theme.fg("accent", `✎ delegate: ${state.chosenWriter ?? "?"}`)
				: undefined,
		);
	}

	return { persist, updateUi };
}
