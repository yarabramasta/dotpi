import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { registerEvents } from "./events.js";
import { createRuntime } from "./runtime.js";
import { registerGroundingTools } from "./tools/grounding-tools.js";
import { registerPhaseTools } from "./tools/phase-tools.js";
import { registerReviewerTools } from "./tools/reviewer-tools.js";
import { registerStateTools } from "./tools/state-tools.js";

export default function grillMeExtension(pi: ExtensionAPI): void {
	const helpers = createRuntime(pi);
	registerCommands(pi, helpers);
	registerStateTools(pi, helpers);
	registerGroundingTools(pi, helpers);
	registerReviewerTools(pi, helpers);
	registerPhaseTools(pi, helpers);
	registerEvents(pi, helpers);
}
