import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExecTools } from "./exec-tools.js";
import { registerPipelineTools } from "./pipeline-tools.js";
import { registerPrTools } from "./pr-tools.js";
import { registerSinkTools } from "./sink-tools.js";
import { registerStoreTools } from "./store-tools.js";

export function registerSpecdTools(pi: ExtensionAPI): void {
	registerStoreTools(pi);
	registerPipelineTools(pi);
	registerSinkTools(pi);
	registerExecTools(pi);
	registerPrTools(pi);
}
