import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

/** Optional settings for the grill extension. Default: subagents on.
 *
 * Global: ~/.pi/agent/grill.json → { "subagents": true|false }
 * Project: <cwd>/.pi/grill.json (same shape, wins over global; trust-gated) */

interface GrillSettings {
	subagents?: boolean;
}

function readSettings(path: string): GrillSettings | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as GrillSettings;
		return typeof parsed === "object" && parsed !== null ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve the subagents default: project > global > on (first-class). */
export function readSubagentsDefault(ctx: ExtensionContext): boolean {
	const project = ctx.isProjectTrusted()
		? readSettings(join(ctx.cwd, CONFIG_DIR_NAME, "grill.json"))
		: undefined;
	if (typeof project?.subagents === "boolean") return project.subagents;
	const globalSettings = readSettings(
		join(homedir(), CONFIG_DIR_NAME, "grill.json"),
	);
	if (typeof globalSettings?.subagents === "boolean") {
		return globalSettings.subagents;
	}
	return true;
}
