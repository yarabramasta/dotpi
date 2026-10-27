import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { registerEvents } from "./events.js";
import { createRuntime } from "./runtime.js";
import { registerAtomTools } from "./tools/atom-tools.js";
import { registerGroundingTools } from "./tools/grounding-tools.js";
import { registerPhaseTools } from "./tools/phase-tools.js";
import { registerReviewerTools } from "./tools/reviewer-tools.js";
import { registerStateTools } from "./tools/state-tools.js";

/** Self-scope predicate: grill tools only register in repos that have a
 * .pi/knowledge/ store. Repos without one get no grill tools, so the
 * agent can't conflate grill with specd or other extensions. */
export function grillStoreExists(cwd: string): boolean {
	return existsSync(join(cwd, ".pi", "knowledge"));
}

export default function grillMeExtension(
	pi: ExtensionAPI,
	opts?: { cwd?: string },
): void {
	const cwd = opts?.cwd ?? process.cwd();
	if (!grillStoreExists(cwd)) {
		return;
	}
	const helpers = createRuntime(pi);
	registerCommands(pi, helpers);
	registerStateTools(pi, helpers);
	registerGroundingTools(pi, helpers);
	registerReviewerTools(pi, helpers);
	registerPhaseTools(pi, helpers);
	registerAtomTools(pi);
	registerEvents(pi, helpers);
}
