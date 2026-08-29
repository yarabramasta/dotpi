import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { registerInfoTool } from "./tools/info.js";
import { registerEmulatorTool } from "./tools/emulator.js";
import { registerSdkTool } from "./tools/sdk.js";
import { registerDocsTool } from "./tools/docs.js";
import {
	registerProjectCreateTool,
	registerProjectDescribeTool,
} from "./tools/project.js";
import { registerRunTool } from "./tools/run.js";
import { registerLayoutTool } from "./tools/layout.js";
import { registerScreenTool } from "./tools/screen.js";
import { registerStudioTool } from "./tools/studio.js";

// ponytail: marker-based discovery avoids running slow Gradle commands at startup.
function isAndroidProject(directory: string): boolean {
	const root = resolve(directory);
	const hasGradleFiles = [
		"settings.gradle",
		"settings.gradle.kts",
		"build.gradle",
		"build.gradle.kts",
	].some((file) => existsSync(join(root, file)));
	if (!hasGradleFiles) return false;

	const hasManifest = [
		"src/main/AndroidManifest.xml",
		"app/src/main/AndroidManifest.xml",
	].some((file) => existsSync(join(root, file)));
	if (hasManifest) return true;

	// Support projects whose Android module is not named "app".
	try {
		return readdirSync(root, { withFileTypes: true }).some(
			(entry) =>
				entry.isDirectory() &&
				existsSync(join(root, entry.name, "src/main/AndroidManifest.xml")),
		);
	} catch {
		return false;
	}
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
			const result = await pi.exec("android", ["init"], { timeout: 60_000 });
			ctx.ui.notify(
				result.stdout?.trim() || "android init completed",
				result.code === 0 ? "info" : "error",
			);
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
			const result = await pi.exec("android", ["update"], {
				timeout: 120_000,
			});
			ctx.ui.notify(
				result.stdout?.trim() || "android update completed",
				result.code === 0 ? "info" : "error",
			);
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
					ctx.ui.notify(`Android Studio detected:\n${check.stdout?.trim()}`, "info");
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

	pi.on("session_start", async (event, ctx) => {
		const projectDir = findAndroidProject([event.cwd, ctx.cwd, process.cwd()]);
		if (!projectDir) {
			ctx.ui.setStatus("android-cli", "");
			return;
		}

		registerAndroidTools();
		if (!commandsRegistered) {
			registerCommands(pi, enableStudioTool);
			commandsRegistered = true;
		}
		ctx.ui.setStatus("android-cli", `Android project: ${projectDir}`);

		// Show SDK info in status
		try {
			const result = await pi.exec("android", ["info"], { timeout: 10_000 });
			const sdkMatch = result.stdout?.match(/^sdk:\s*(.+)$/m);
			const versionMatch = result.stdout?.match(/^version:\s*(.+)$/m);
			if (sdkMatch) {
				ctx.ui.setStatus(
					"android-cli",
					`Android CLI ${versionMatch?.[1] ?? ""} · SDK: ${sdkMatch[1]}`,
				);
			}
		} catch {
			// CLI not available — keep project status
		}

		// Auto-detect Android Studio
		try {
			const check = await pi.exec("android", ["studio", "check"], {
				timeout: 10_000,
			});
			if (check.code === 0 && check.stdout?.includes("READY")) {
				enableStudioTool();
				ctx.ui.notify(
					"Android Studio detected — android_studio tool enabled",
					"info",
				);
			}
		} catch {
			// Studio not running — skip
		}
	});
}
