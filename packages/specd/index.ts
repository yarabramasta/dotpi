import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { registerSpecdTools } from "./tools.js";

export default function specdExtension(pi: ExtensionAPI): void {
	registerCommands(pi);
	registerSpecdTools(pi);
}
