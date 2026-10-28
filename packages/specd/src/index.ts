import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands/index.js";
import { registerSpecdTools } from "./tools/index.js";

export default function specdExtension(pi: ExtensionAPI): void {
	registerCommands(pi);
	registerSpecdTools(pi);
}
