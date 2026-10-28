import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { statusTokens } from "./prompts.js";
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
			return;
		}

		const state = runtime.state;
		const phase = currentPhase(state);
		ctx.ui.setStatus(
			"grill-me",
			ctx.ui.theme.fg(
				phase === "output"
					? "warning"
					: phase === "output-selection"
						? "success"
						: "accent",
				statusTokens(state),
			),
		);
	}

	return { persist, updateUi };
}
