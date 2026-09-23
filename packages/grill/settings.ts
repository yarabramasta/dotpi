import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

declare module "./state.js" {
	interface GrillState {
		isolationSetting?: "worktrees" | "gitbutler" | "slices" | "auto";
		sessionIsolationOverride?: "worktrees" | "gitbutler" | "slices" | "auto";
		resolvedIsolation?: { backend: string; reason: string };
	}
}

interface GrillSettings {
	subagents?: boolean;
	collapseKey?: string;
	isolation?: string;
}

export const ISOLATION_SETTINGS = [
	"worktrees",
	"gitbutler",
	"slices",
	"auto",
] as const;
export type IsolationSettingLocal = (typeof ISOLATION_SETTINGS)[number];

export function asIsolationSetting(
	value: unknown,
): IsolationSettingLocal | undefined {
	return typeof value === "string" &&
		(ISOLATION_SETTINGS as readonly string[]).includes(value)
		? (value as IsolationSettingLocal)
		: undefined;
}

/** Optional settings for the grill extension. Defaults: subagents on,
 * collapse key ctrl+] ("off" disables collapse mode).
 *
 * Global: ~/.pi/agent/grill.json → { "subagents": true|false, "collapseKey": "ctrl+]"|"off" }
 * Project: <cwd>/.pi/grill.json (same shape, wins over global; trust-gated) */

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
	const globalSettings = readSettings(join(getAgentDir(), "grill.json"));
	if (typeof globalSettings?.subagents === "boolean") {
		return globalSettings.subagents;
	}
	return true;
}

/** Resolve the isolation backend default: project > global > undefined.
 * Consumers apply "auto" as the fallback default. */
export function readIsolationDefault(
	ctx: ExtensionContext,
): IsolationSettingLocal | undefined {
	const project = ctx.isProjectTrusted()
		? readSettings(join(ctx.cwd, CONFIG_DIR_NAME, "grill.json"))
		: undefined;
	const projectValue = asIsolationSetting(project?.isolation);
	if (projectValue !== undefined) return projectValue;
	const globalSettings = readSettings(join(getAgentDir(), "grill.json"));
	return asIsolationSetting(globalSettings?.isolation);
}

/** Default collapse key: ctrl+] is free in mainstream terminals/multiplexers.
 * "off" disables collapse mode. */
export const DEFAULT_COLLAPSE_KEY = "ctrl+]";

/** Resolve the collapse key: project > global > default. */
export function readCollapseKey(ctx: ExtensionContext): string {
	const project = ctx.isProjectTrusted()
		? readSettings(join(ctx.cwd, CONFIG_DIR_NAME, "grill.json"))
		: undefined;
	if (typeof project?.collapseKey === "string") return project.collapseKey;
	const globalSettings = readSettings(join(getAgentDir(), "grill.json"));
	if (typeof globalSettings?.collapseKey === "string") {
		return globalSettings.collapseKey;
	}
	return DEFAULT_COLLAPSE_KEY;
}
