import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { renderSessionReport, sessionReportFilename } from "../report.js";
import { readinessMatrix, SINK_IDS } from "../sinks/onboarding.js";
import { runDoctor } from "../store/doctor.js";
import {
	readStorageConfig,
	STORAGE_MODES,
	type StorageMode,
	saveStorageConfig,
} from "../store/storage.js";
import { openStore } from "../store/store.js";
import { dashboardContent } from "../tools/store-tools.js";
import {
	ANALYZE_PROMPT,
	CONSTITUTION_PROMPT,
	CONVERGE_PROMPT,
	CLARIFY_PROMPT,
	connectPrompt,
	HELP,
	PAUSE_PROMPT,
	PLAN_ENTRY_PROMPT,
	REVIEW_PROMPT,
	RUN_PROMPT,
	RUN_WAVES_PROMPT,
	SINK_PROMPT,
	START_PROMPT,
	TASKS_ENTRY_PROMPT,
} from "./prompts.js";

function firstWord(args: string): string {
	return args.trim().split(/\s+/)[0] ?? "";
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("spec", {
		description:
			"Spec-driven development: start a cycle, run a task, current state, doctor",
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			const sub = firstWord(trimmed);
			const rest = trimmed.slice(sub.length).trim();
			if (sub === "help") {
				pi.sendMessage({
					customType: "specd-help",
					content: HELP,
					display: true,
				});
				return;
			}
			if (sub === "start") {
				let idea = rest;
				if (!idea && ctx.hasUI) {
					const edited = await ctx.ui.editor(
						"What should we build? (the cycle starts from this idea)",
						"",
					);
					if (!edited?.trim()) {
						ctx.ui.notify("Cancelled cycle start.", "info");
						return;
					}
					idea = edited.trim();
				}
				if (!idea) {
					ctx.ui.notify("Usage: /spec start <idea>", "warning");
					return;
				}
				pi.sendUserMessage(START_PROMPT(idea));
				return;
			}
			if (sub === "run") {
				if (!rest) {
					pi.sendUserMessage(RUN_WAVES_PROMPT);
					return;
				}
				const task = rest;
				pi.sendUserMessage(RUN_PROMPT(task));
				return;
			}
			if (sub === "converge") {
				const scope = rest;
				if (!scope) {
					ctx.ui.notify("Usage: /spec converge <spec-or-cycle-id>", "warning");
					return;
				}
				pi.sendUserMessage(CONVERGE_PROMPT(scope));
				return;
			}
			if (sub === "pause") {
				pi.sendUserMessage(PAUSE_PROMPT);
				return;
			}
			if (sub === "review") {
				const id = rest;
				if (!id) {
					ctx.ui.notify("Usage: /spec review <checklist-id>", "warning");
					return;
				}
				pi.sendUserMessage(REVIEW_PROMPT(id));
				return;
			}
			if (sub === "analyze") {
				pi.sendUserMessage(ANALYZE_PROMPT(rest));
				return;
			}
			if (sub === "constitution") {
				pi.sendUserMessage(CONSTITUTION_PROMPT);
				return;
			}
			if (sub === "clarify") {
				if (!rest) {
					ctx.ui.notify("Usage: /spec clarify <spec-id>", "warning");
					return;
				}
				pi.sendUserMessage(CLARIFY_PROMPT(rest));
				return;
			}
			if (sub === "plan") {
				if (!rest) {
					ctx.ui.notify("Usage: /spec plan <spec-id>", "warning");
					return;
				}
				pi.sendUserMessage(PLAN_ENTRY_PROMPT(rest));
				return;
			}
			if (sub === "tasks") {
				if (!rest) {
					ctx.ui.notify("Usage: /spec tasks <spec-id>", "warning");
					return;
				}
				pi.sendUserMessage(TASKS_ENTRY_PROMPT(rest));
				return;
			}
			if (sub === "sink") {
				pi.sendUserMessage(SINK_PROMPT);
				return;
			}
			if (sub === "connect") {
				const id = rest;
				if (!id) {
					ctx.ui.notify(
						`Usage: /spec connect <sink> — known sinks: ${SINK_IDS.join(", ")}.`,
						"warning",
					);
					return;
				}
				pi.sendMessage({
					customType: "specd-connect",
					content: connectPrompt(id),
					display: true,
				});
				return;
			}
			if (sub === "import") {
				const mode = firstWord(rest);
				const source = rest.slice(mode.length).trim();
				if (!source) {
					ctx.ui.notify(
						"Usage: /spec import <preview|apply> <source-repo-path>",
						"warning",
					);
					return;
				}
				if (mode === "preview") {
					pi.sendUserMessage(
						`Run specd_import_preview(source=${JSON.stringify(source)}) and summarize what would be imported.`,
					);
				} else if (mode === "apply") {
					pi.sendUserMessage(
						`Run specd_import_apply(source=${JSON.stringify(source)}, apply=true). Confirm idempotency by re-running the preview after.`,
					);
				} else if (mode === "revert") {
					pi.sendUserMessage(
						`Run specd_import_revert() to list known import batches, show me the list, and revert only the batch I name (specd_import_revert(batch=<id>)). After reverting, run /spec doctor to confirm the store is clean.`,
					);
				} else {
					ctx.ui.notify(
						`Usage: /spec import <preview|apply> <source-repo-path> — got mode "${mode}".`,
						"warning",
					);
				}
				return;
			}
			try {
				const store = await openStore(ctx.cwd);
				if (sub === "doctor") {
					const findings = runDoctor(store);
					const text = findings.length
						? findings.map((f) => `- ${f.kind}: ${f.detail}`).join("\n")
						: "clean — the store matches its event history.";
					const matrix = await readinessMatrix(store);
					pi.sendMessage({
						customType: "specd-doctor",
						content: `# specd doctor\n\n${text}\n\n${matrix}`,
						display: true,
					});
					return;
				}
				if (sub === "storage") {
					const mode = firstWord(rest);
					if (!mode) {
						const config = readStorageConfig(store);
						pi.sendMessage({
							customType: "specd-storage",
							content: `Storage mode: **${config.mode}**${config.mdPath ? ` (${config.mdPath})` : ""}\n\n- db-only — md promotion off (default)\n- md-inrepo — md mirrors under docs/specd/ in this repo\n- md-external <path> — md mirrors in a directory outside the repo\n\nPromotion surface: the specd_promote tool (write/remove an item's md mirror).`,
							display: true,
						});
						return;
					}
					if (!STORAGE_MODES.includes(mode as StorageMode)) {
						ctx.ui.notify(
							`Unknown storage mode: ${mode}. Valid: ${STORAGE_MODES.join(", ")}.`,
							"warning",
						);
						return;
					}
					const mdPath = rest.slice(mode.length).trim() || undefined;
					if (mode === "md-external" && !mdPath) {
						ctx.ui.notify("Usage: /spec storage md-external <path>", "warning");
						return;
					}
					saveStorageConfig(store, { mode: mode as StorageMode, mdPath });
					ctx.ui.notify(
						`Storage mode set to ${mode}${mdPath ? ` (${mdPath})` : ""}.`,
						"info",
					);
					return;
				}
				if (sub === "export") {
					const target = rest || join(ctx.cwd, sessionReportFilename());
					const html = renderSessionReport(store);
					writeFileSync(target, html, "utf8");
					pi.sendMessage({
						customType: "specd-export",
						content: `Session report written: ${target}\n\npi's own conversation export covers the chat side — run it from the session as well when handing both to another agent.`,
						display: true,
					});
					return;
				}
				if (sub === "" || sub === "status" || sub === "dashboard") {
					pi.sendMessage({
						customType: "specd-dashboard",
						content: await dashboardContent(store),
						display: true,
					});
					return;
				}
				ctx.ui.notify(
					`Unknown /spec command: ${sub}. Try /spec help.`,
					"warning",
				);
			} catch (error) {
				ctx.ui.notify(
					`specd error: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
