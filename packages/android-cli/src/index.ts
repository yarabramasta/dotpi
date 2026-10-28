import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { registerDocsTool } from "./tools/docs.js";
import { registerEmulatorTool } from "./tools/emulator.js";
import { registerInfoTool } from "./tools/info.js";
import { registerLayoutTool } from "./tools/layout.js";
import {
	registerProjectCreateTool,
	registerProjectDescribeTool,
} from "./tools/project.js";
import { registerRunTool } from "./tools/run.js";
import { registerScreenTool } from "./tools/screen.js";
import { registerSdkTool } from "./tools/sdk.js";
import { registerStudioTool } from "./tools/studio.js";
import { short } from "./utils.js";

// ponytail: marker-based discovery avoids running slow Gradle commands at startup.
const MODULE_SKIP = new Set(["node_modules", "build", "dist"]);

const MANIFEST_PATHS = [
	"src/main/AndroidManifest.xml",
	"src/androidMain/AndroidManifest.xml", // Kotlin Multiplatform android target
];

function listModuleDirs(directory: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory() &&
			!entry.name.startsWith(".") &&
			!MODULE_SKIP.has(entry.name)
				? [join(directory, entry.name)]
				: [],
		);
	} catch {
		return [];
	}
}

function hasAndroidManifest(directory: string): boolean {
	return MANIFEST_PATHS.some((file) => existsSync(join(directory, file)));
}

function isAndroidProject(directory: string): boolean {
	const root = resolve(directory);
	const hasGradleFiles = [
		"settings.gradle",
		"settings.gradle.kts",
		"build.gradle",
		"build.gradle.kts",
	].some((file) => existsSync(join(root, file)));
	if (!hasGradleFiles) return false;

	if (hasAndroidManifest(root)) return true;

	// Modules nest up to two levels deep: app/, apps/member/, core/ui/ …
	for (const moduleDir of listModuleDirs(root)) {
		if (hasAndroidManifest(moduleDir)) return true;
		for (const nested of listModuleDirs(moduleDir)) {
			if (hasAndroidManifest(nested)) return true;
		}
	}
	return false;
}

function findAndroidProject(
	directories: readonly string[],
): string | undefined {
	return [...new Set(directories.filter(Boolean))].find(isAndroidProject);
}

function registerCommands(pi: ExtensionAPI, enableStudioTool: () => void) {
	pi.registerCommand("android-init", {
		description: "Initialize Android CLI environment and install skills",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Running android init...", "info");
			ctx.ui.setStatus("android", ctx.ui.theme.fg("accent", "▲ initializing…"));
			try {
				const result = await pi.exec("android", ["init"], { timeout: 60_000 });
				ctx.ui.notify(
					result.stdout?.trim() || "android init completed",
					result.code === 0 ? "info" : "error",
				);
			} catch (error) {
				ctx.ui.notify(`android init failed: ${error}`, "error");
			} finally {
				ctx.ui.setStatus("android", undefined);
			}
		},
	});

	pi.registerCommand("android-update", {
		description: "Update Android CLI to latest version",
		handler: async (_args, ctx) => {
			const ok = await ctx.ui.confirm(
				"Update Android CLI",
				"Download and install the latest Android CLI version?",
			);
			if (!ok) return;
			ctx.ui.notify("Updating Android CLI...", "info");
			ctx.ui.setStatus("android", ctx.ui.theme.fg("accent", "▲ updating…"));
			try {
				const result = await pi.exec("android", ["update"], {
					timeout: 120_000,
				});
				ctx.ui.notify(
					result.stdout?.trim() || "android update completed",
					result.code === 0 ? "info" : "error",
				);
			} catch (error) {
				ctx.ui.notify(`android update failed: ${error}`, "error");
			} finally {
				ctx.ui.setStatus("android", undefined);
			}
		},
	});

	pi.registerCommand("android-studio-detect", {
		description: "Re-detect Android Studio and enable studio tools",
		handler: async (_args, ctx) => {
			try {
				const check = await pi.exec("android", ["studio", "check"], {
					timeout: 10_000,
				});
				if (check.code === 0 && check.stdout?.includes("READY")) {
					enableStudioTool();
					ctx.ui.notify(
						`Android Studio detected:\n${check.stdout?.trim()}`,
						"info",
					);
				} else {
					ctx.ui.notify(
						"Android Studio not detected or no projects ready",
						"warning",
					);
				}
			} catch {
				ctx.ui.notify("Failed to check Android Studio", "error");
			}
		},
	});
}

export default function androidCliExtension(pi: ExtensionAPI) {
	let toolsRegistered = false;
	let commandsRegistered = false;
	let studioAvailable = false;
	let active = true;

	const widget = { project: "", cli: "", sdk: "", studio: false };

	const refreshWidget = (ctx: ExtensionContext) => {
		if (!widget.project) return;
		ctx.ui.setWidget("android", (_tui, theme) => {
			let line = theme.fg("accent", "▲ ");
			line += theme.fg("toolTitle", theme.bold(widget.project));
			if (widget.cli) line += theme.fg("muted", ` · CLI ${widget.cli}`);
			if (widget.sdk) line += theme.fg("dim", ` · SDK: ${widget.sdk}`);
			if (widget.studio) line += theme.fg("success", " · Studio ●");
			return new Text(line, 0, 0);
		});
	};

	pi.on("session_shutdown", () => {
		active = false;
	});

	const enableStudioTool = () => {
		if (studioAvailable) return;
		studioAvailable = true;
		registerStudioTool(pi);
	};

	const registerAndroidTools = () => {
		if (toolsRegistered) return;
		registerInfoTool(pi);
		registerEmulatorTool(pi);
		registerSdkTool(pi);
		registerDocsTool(pi);
		registerProjectCreateTool(pi);
		registerProjectDescribeTool(pi);
		registerRunTool(pi);
		registerLayoutTool(pi);
		registerScreenTool(pi);
		toolsRegistered = true;
	};

	// ponytail: fire-and-forget background detection — status fills in, session never blocks
	const detectSdk = async (ctx: ExtensionContext) => {
		try {
			const result = await pi.exec("android", ["info"], { timeout: 10_000 });
			if (!active) return;
			const sdkMatch = result.stdout?.match(/^sdk:\s*(.+)$/m);
			const versionMatch = result.stdout?.match(/^version:\s*(.+)$/m);
			if (sdkMatch) {
				widget.cli = versionMatch?.[1] ?? "?";
				widget.sdk = short(sdkMatch[1].trim(), 40);
				refreshWidget(ctx);
			}
		} catch {
			// CLI not available — keep project-only widget
		}
	};

	const detectStudio = async (ctx: ExtensionContext) => {
		try {
			const check = await pi.exec("android", ["studio", "check"], {
				timeout: 10_000,
			});
			if (!active) return;
			if (check.code === 0 && check.stdout?.includes("READY")) {
				enableStudioTool();
				widget.studio = true;
				refreshWidget(ctx);
				ctx.ui.notify(
					"Android Studio detected — android_studio tool enabled",
					"info",
				);
			}
		} catch {
			// Studio not running — skip
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		active = true;
		const projectDir = findAndroidProject([ctx.cwd, process.cwd()]);

		registerAndroidTools();
		if (!commandsRegistered) {
			registerCommands(pi, enableStudioTool);
			commandsRegistered = true;
		}
		if (!projectDir) {
			ctx.ui.setStatus("android-cli", "");
			ctx.ui.setWidget("android", undefined);
			return;
		}

		widget.project = basename(projectDir);
		refreshWidget(ctx);

		// Parallel detection — do not await, never block the session
		void detectSdk(ctx);
		void detectStudio(ctx);
	});
}
