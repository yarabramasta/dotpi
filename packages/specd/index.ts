import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./src/commands/index.js";
import { registerSpecdTools } from "./src/tools/index.js";

export default function specdExtension(pi: ExtensionAPI): void {
	registerCommands(pi);
	registerSpecdTools(pi);
}
