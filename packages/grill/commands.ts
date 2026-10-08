import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	addEdge,
	createAtom,
	demote,
	getAtom,
	promote,
	queryAtoms,
	updateAtom,
} from "./atom/atoms.js";
import { renderDigest } from "./atom/digest.js";
import { runDoctor } from "./atom/doctor.js";
import { initAtom } from "./atom/init.js";
import {
	EDGE_KINDS,
	type EdgeKind,
	NODE_STATUSES,
	NODE_TYPES,
	type NodeStatus,
	type NodeType,
	openAtomStore,
} from "./atom/store.js";
import { buildDossier } from "./dossier.js";
import { initialCheckpoint, statusMarkdown } from "./prompts.js";
import type { GrillHelpers } from "./runtime.js";
import {
	asIsolationSetting,
	readAtomDefault,
	readIsolationDefault,
	readSubagentsDefault,
} from "./settings.js";
import {
	asIntent,
	asResearchMode,
	asSubagentsValue,
	cloneState,
	DEFAULT_STATE,
	firstWord,
	type GrillState,
	INTENTS,
	inferTopic,
	parseArgs,
	RESEARCH_MODES,
	runtime,
} from "./state.js";
import { shouldRewriteTitle, titleFromTopic } from "./title.js";

/** Parse key=value assignments with optional quoting: `body="multi word" scope=auth` → {body, scope}. */
export function parseAssignments(rest: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /(\w+)=("([^"]*)"|'([^']*)'|(\S+))/g;
	for (const m of rest.matchAll(re)) {
		out[m[1]] = m[3] ?? m[4] ?? m[5] ?? "";
	}
	return out;
}

export function registerCommands(
	pi: ExtensionAPI,
	helpers: GrillHelpers,
): void {
	const { persist, updateUi } = helpers;
	async function startSession(
		topic: string,
		ctx: ExtensionContext,
		partial: Partial<GrillState> = {},
	): Promise<void> {
		// First-class grounding: one compact dossier up front, no per-session
		// enable/disable decision. Best-effort — failure just skips the section.
		// Subagent integration defaults from settings, overridable per session.
		if (typeof partial.subagents !== "boolean") {
			partial.subagents = readSubagentsDefault(ctx);
		}
		if (typeof partial.isolationSetting !== "string") {
			partial.isolationSetting = readIsolationDefault(ctx) ?? "auto";
		}
		runtime.state = {
			...cloneState(DEFAULT_STATE),
			...partial,
			active: true,
			topic,
			phase: "interview",
			outputPhase: false,
			outputSelection: undefined,
			approvedOutputPlan: undefined,
		};
		runtime.state.checkpoint = initialCheckpoint(topic, runtime.state);
		runtime.state.lastChangeSummary = "Started grill session";
		persist();
		updateUi(ctx);

		// Startup feedback: the dossier (cymbal structure + git) can take a few
		// seconds on a cold cache. Show a working indicator so the quiet gap
		// doesn't look like the extension died; updateUi below restores tokens.
		ctx.ui.setStatus(
			"grill-me",
			ctx.ui.theme.fg("accent", "🔥 grill · warming up…"),
		);

		// First-class grounding: one compact dossier up front, no per-session
		// enable/disable decision. Best-effort — failure just skips the section.
		const dossier = await buildDossier(pi, ctx.cwd);
		runtime.state.dossier = dossier
			? { text: dossier, at: Date.now() }
			: undefined;
		runtime.state.lastChangeSummary = dossier
			? "Grounding dossier captured"
			: "Grounding dossier unavailable (cymbal/git)";

		// Session-title fix: rewrite generic grill-default titles so resume lists
		// are distinguishable. Custom user titles are left alone.
		if (shouldRewriteTitle(pi.getSessionName?.())) {
			pi.setSessionName?.(titleFromTopic(topic));
			runtime.state.titleSet = true;
		}

		persist();
		updateUi(ctx);

		pi.sendUserMessage(
			`Start a Grill Me session for this topic:\n\n${topic}\n\nGrounding is first-class for this session: the repo dossier below was captured automatically; use cymbal tools for spot-checks and grill_set_scouts + one read-only scout when cymbal cannot answer.\n\n${dossier ? `Repo grounding dossier (auto-captured at session start):\n\n${dossier}\n\n` : ""}Begin by updating the checkpoint if needed, seed or maintain the coverage checklist and decision branches, then call grill_set_alternatives with 2-5 concrete answer choices and ask the first focused Socratic question. Call grill_set_alternatives so an ↑/↓ + Enter picker overlay opens; it returns the user's structured answer as the tool result, which you record in the checkpoint before asking the next question. Use the single thorough grilling style. When the interview is ready to end, the mandatory hardcoded output-selection phase must be entered with grill_enter_output_selection_phase before producing outputs or stopping.`,
		);
	}

	async function showCheckpointOverlay(
		ctx: ExtensionContext,
	): Promise<"edit" | undefined> {
		if (!ctx.hasUI) {
			pi.sendMessage({
				customType: "grill-me-checkpoint",
				content: runtime.state.checkpoint,
				display: true,
			});
			return undefined;
		}

		return await ctx.ui.custom<"edit" | undefined>(
			(tui, theme, _keybindings, done) => {
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				const markdown = new Markdown(
					runtime.state.checkpoint,
					1,
					0,
					getMarkdownTheme(),
				);
				let scrollOffset = 0;
				let cachedWidth = 0;
				let cachedBody: string[] = [];
				const maxBodyLines = 16;

				function bodyLines(width: number): string[] {
					if (cachedWidth !== width || cachedBody.length === 0) {
						cachedWidth = width;
						cachedBody = markdown.render(width);
					}
					return cachedBody;
				}

				function maxOffset(): number {
					return Math.max(0, cachedBody.length - maxBodyLines);
				}

				function move(delta: number): void {
					scrollOffset = Math.max(
						0,
						Math.min(maxOffset(), scrollOffset + delta),
					);
					tui.requestRender();
				}

				return {
					render(width: number) {
						const body = bodyLines(width);
						scrollOffset = Math.min(scrollOffset, maxOffset());
						const visible = body.slice(
							scrollOffset,
							scrollOffset + maxBodyLines,
						);
						const range =
							body.length > maxBodyLines
								? `lines ${scrollOffset + 1}-${Math.min(scrollOffset + maxBodyLines, body.length)} of ${body.length}`
								: "full checkpoint";
						return [
							...border.render(width),
							truncateToWidth(
								theme.fg("accent", theme.bold("🔥 Grill Me Checkpoint")),
								width,
							),
							truncateToWidth(
								theme.fg(
									"dim",
									`${range} • ↑↓/PgUp/PgDn scroll • e edit • Enter/Esc close`,
								),
								width,
							),
							...visible.map((line) => truncateToWidth(line, width, "")),
							...border.render(width),
						];
					},
					invalidate() {
						border.invalidate();
						markdown.invalidate();
						cachedWidth = 0;
						cachedBody = [];
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "enter"))
							done(undefined);
						else if (matchesKey(data, "e")) done("edit");
						else if (matchesKey(data, "up")) move(-1);
						else if (matchesKey(data, "down")) move(1);
						else if (matchesKey(data, "pageUp")) move(-maxBodyLines);
						else if (matchesKey(data, "pageDown")) move(maxBodyLines);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "80%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);
	}

	async function showCheckpoint(
		ctx: ExtensionContext,
		mode?: string,
	): Promise<void> {
		if (!runtime.state.checkpoint.trim()) {
			ctx.ui.notify("No grill checkpoint yet.", "warning");
			return;
		}

		const selected = mode?.trim().toLowerCase() || "overlay";
		if (selected.includes("edit")) {
			const edited = await ctx.ui.editor(
				"Edit Grill Me checkpoint",
				runtime.state.checkpoint,
			);
			if (edited !== undefined) {
				runtime.state.checkpoint = edited.trim() || runtime.state.checkpoint;
				runtime.state.lastChangeSummary = "Checkpoint edited by user";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill checkpoint updated.", "info");
			}
			return;
		}

		if (selected.includes("chat")) {
			pi.sendMessage({
				customType: "grill-me-checkpoint",
				content: runtime.state.checkpoint,
				display: true,
			});
			return;
		}

		const action = await showCheckpointOverlay(ctx);
		if (action === "edit") {
			await showCheckpoint(ctx, "edit");
		}
	}

	async function handleAtom(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const trimmed = args.trim();
		const command = firstWord(trimmed);
		const rest = trimmed.slice(command.length).trim();
		if (!command || command === "help") {
			pi.sendMessage({
				customType: "grill-atom-help",
				content: `# grill atom — knowledge base

- /atom init — scaffold .pi/knowledge/ (atoms.db + .gitignore + .gitattributes), report workspace shape, print the optional textconv setup line
- /atom doctor [--strict] — check schema version, empty bodies, orphan edges; --strict also flags promoted decisions with no sources
- /atom show <id> — full atom: meta + body
- /atom query <type=<t>> <status=<s>|status!=<s>> <q=<text>> <scope=<s>> <after=YYYY-MM-DD> <limit=<n>> <sort=created|id> — list matching atoms (FTS5 keyword search)
- /atom create type=<t> title=<t> [body=<md>|--edit] [scope=<s>] [sources=<comma-separated>] — create an atom
- /atom update <id> [body=<md>|--edit] [status=<s>] [scope=<s>] [sources=<comma-separated>] — update in place (promoted atoms regenerate their export; empty sources= clears provenance)
- /atom promote <id> [docs/path.md] — write the md export into the repo tree
- /atom demote <id> [<id>…] — reverse promotions: status → accepted, exports deleted
- /atom link <from> <to> <kind> — typed edge (supersedes, depends-on, …)
- /atom digest [--task <text>] — print the compact digest, optionally task-lensed

Agents can also call the native tools: atom_query, atom_create, atom_update, atom_promote, atom_digest, atom_link, atom_backfill.

Settings: { "atom": true|false } in ~/.pi/agent/grill.json or .pi/grill.json — or toggle for this session with /grill atom on|off (currently ${typeof runtime.state.atomOverride === "boolean" ? (runtime.state.atomOverride ? "on" : "off") : readAtomDefault(ctx) ? "on" : "off"}). Data lives in .pi/knowledge/atoms.db (single SQLite store, bodies in-db).`,
				display: true,
			});
			return;
		}
		const atomEnabled =
			typeof runtime.state.atomOverride === "boolean"
				? runtime.state.atomOverride
				: readAtomDefault(ctx);
		if (!atomEnabled) {
			ctx.ui.notify(
				'atom is disabled ({ "atom": false } in grill.json or /grill atom off).',
				"warning",
			);
			return;
		}
		try {
			const store = await openAtomStore(ctx.cwd);
			if (command === "init") {
				const result = initAtom(store);
				ctx.ui.notify(
					`atom init: scaffolded .pi/knowledge/ (atoms.db, .gitignore, .gitattributes). monorepo=${result.isMonorepo} (kind: ${result.workspaceKind ?? "single"}, packages: ${result.workspacePkgs}). Pointer: ${result.agentsPointer}. Diffable blobs (optional): ${result.textconvHint}`,
					"info",
				);
				return;
			}
			if (command === "doctor") {
				const issues = runDoctor(store, { strict: rest.includes("--strict") });
				const text = issues.length
					? issues
							.map(
								(i: { kind: string; id?: string; detail: string }) =>
									`- ${i.kind}${i.id ? ` (${i.id})` : ""}: ${i.detail}`,
							)
							.join("\n")
					: "clean";
				pi.sendMessage({
					customType: "grill-atom-doctor",
					content: `# atom doctor\n\n${text}`,
					display: true,
				});
				return;
			}
			if (command === "show") {
				const id = firstWord(rest);
				if (!id) {
					ctx.ui.notify("Usage: /atom show <id>", "warning");
					return;
				}
				const atom = getAtom(store, id);
				if (!atom) {
					ctx.ui.notify(`Atom not found: ${id}.`, "warning");
					return;
				}
				const sources = atom.sources
					? JSON.parse(atom.sources)?.join(", ")
					: "—";
				pi.sendMessage({
					customType: "grill-atom-show",
					content: `# ${atom.id}\n\n- type: ${atom.type}\n- status: ${atom.status}\n- scope: ${atom.scope ?? "—"}\n- promoted_to: ${atom.promoted_to ?? "—"}\n- sources: ${sources}\n- created: ${new Date(atom.created_at).toISOString()}\n\n${atom.body}`,
					display: true,
				});
				return;
			}
			if (command === "create") {
				const wantsEditor = rest.includes("--edit");
				const parsed = parseAssignments(rest.replaceAll("--edit", ""));
				const type = parsed.type as NodeType | undefined;
				if (!type || !(NODE_TYPES as readonly string[]).includes(type)) {
					ctx.ui.notify(
						`Usage: /atom create type=${NODE_TYPES.join("|")} title=<t> [body=<md>|--edit] [scope=<s>] [sources=<comma-separated>]`,
						"warning",
					);
					return;
				}
				if (!parsed.title) {
					ctx.ui.notify("create requires title=<t>", "warning");
					return;
				}
				let body = parsed.body ?? "";
				if (wantsEditor || !parsed.body) {
					const edited = await ctx.ui.editor("Atom body", body);
					if (edited === undefined) {
						ctx.ui.notify("Cancelled atom create.", "info");
						return;
					}
					body = edited;
				}
				const atom = createAtom(store, {
					type,
					title: parsed.title,
					body,
					scope: parsed.scope,
					sources: parsed.sources
						? parsed.sources
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
						: undefined,
				});
				ctx.ui.notify(
					`Created ${atom.id} (${atom.type}) — ${atom.title}.`,
					"info",
				);
				return;
			}
			if (command === "update") {
				const id = firstWord(rest);
				if (!id) {
					ctx.ui.notify(
						"Usage: /atom update <id> [body=<md>|--edit] [status=<s>] [scope=<s>]",
						"warning",
					);
					return;
				}
				const current = getAtom(store, id);
				if (!current) {
					ctx.ui.notify(`Atom not found: ${id}.`, "warning");
					return;
				}
				const wantsEditor = rest.includes("--edit");
				const parsed = parseAssignments(
					rest.slice(id.length).replaceAll("--edit", ""),
				);
				const status = parsed.status as NodeStatus | undefined;
				if (status && !(NODE_STATUSES as readonly string[]).includes(status)) {
					ctx.ui.notify(
						`Unknown status: ${status}. Valid: ${NODE_STATUSES.join(", ")}.`,
						"warning",
					);
					return;
				}
				let body = parsed.body;
				if (wantsEditor) {
					const edited = await ctx.ui.editor("Atom body", current.body);
					if (edited === undefined) {
						ctx.ui.notify("Cancelled atom update.", "info");
						return;
					}
					body = edited;
				}
				const updated = updateAtom(store, id, {
					body,
					status,
					scope: parsed.scope,
					sources: parsed.sources
						? parsed.sources
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean)
						: undefined,
				});
				const touched = [
					body !== undefined ? "body" : "",
					status !== undefined ? "status" : "",
					parsed.scope !== undefined ? "scope" : "",
					parsed.sources !== undefined ? "sources" : "",
				].filter(Boolean);
				const regenerated =
					updated.status === "promoted" && updated.promoted_to
						? ` Export regenerated: ${updated.promoted_to}.`
						: "";
				ctx.ui.notify(
					`Updated ${updated.id}${touched.length ? `: ${touched.join(", ")}` : ""}.${regenerated}`,
					"info",
				);
				return;
			}
			if (command === "promote") {
				const id = firstWord(rest);
				if (!id) {
					ctx.ui.notify("Usage: /atom promote <id> [docs/path.md]", "warning");
					return;
				}
				const docsPath =
					rest.slice(id.length).trim().split(/\s+/)[0] || undefined;
				const updated = promote(store, id, docsPath);
				ctx.ui.notify(
					`Promoted ${updated.id} → ${updated.promoted_to}.`,
					"info",
				);
				return;
			}
			if (command === "demote") {
				const ids = rest.split(/\s+/).filter(Boolean);
				if (!ids.length) {
					ctx.ui.notify("Usage: /atom demote <id> [<id>…]", "warning");
					return;
				}
				const demoted: string[] = [];
				const removed: string[] = [];
				const skipped: string[] = [];
				const failed: string[] = [];
				for (const id of ids) {
					try {
						const result = demote(store, id);
						if (result.atom.status !== "promoted" && !result.removedExport) {
							skipped.push(id);
							continue;
						}
						demoted.push(result.atom.id);
						if (result.removedExport) removed.push(result.removedExport);
					} catch {
						failed.push(id);
					}
				}
				const parts: string[] = [];
				if (demoted.length) {
					parts.push(
						`demoted ${demoted.length} → accepted${removed.length ? ` (${removed.length} export(s) deleted)` : ""}`,
					);
				}
				if (skipped.length) parts.push(`not promoted: ${skipped.join(", ")}`);
				if (failed.length) parts.push(`not found: ${failed.join(", ")}`);
				ctx.ui.notify(
					parts.length
						? `atom demote: ${parts.join("; ")}.`
						: "Nothing to demote.",
					"info",
				);
				return;
			}
			if (command === "link") {
				const [from, to, kind] = rest.split(/\s+/).filter(Boolean);
				if (!from || !to || !kind) {
					ctx.ui.notify(
						"Usage: /atom link <from> <to> <kind> (e.g. supersedes, depends-on)",
						"warning",
					);
					return;
				}
				if (!(EDGE_KINDS as readonly string[]).includes(kind)) {
					ctx.ui.notify(
						`Unknown edge kind: ${kind}. Valid: ${EDGE_KINDS.join(", ")}.`,
						"warning",
					);
					return;
				}
				addEdge(store, from, to, kind as EdgeKind);
				ctx.ui.notify(`Linked ${from} -[${kind}]-> ${to}.`, "info");
				return;
			}
			if (command === "query") {
				const parsed = parseAssignments(rest);
				const statusNot = /status!=(\w+)/.exec(rest)?.[1];
				const opts: Parameters<typeof queryAtoms>[1] = {};
				if (
					parsed.type &&
					(NODE_TYPES as readonly string[]).includes(parsed.type)
				)
					opts.type = parsed.type as NodeType;
				if (
					parsed.status &&
					(NODE_STATUSES as readonly string[]).includes(parsed.status)
				)
					opts.status = parsed.status as NodeStatus;
				if (
					statusNot &&
					(NODE_STATUSES as readonly string[]).includes(statusNot)
				)
					opts.statusNot = statusNot as NodeStatus;
				if (parsed.q) opts.q = parsed.q;
				if (parsed.scope) opts.scope = parsed.scope;
				if (parsed.after) opts.after = parsed.after;
				if (parsed.limit) opts.limit = Number.parseInt(parsed.limit, 10);
				if (parsed.sort === "created" || parsed.sort === "id") {
					opts.sort = parsed.sort;
				}
				const rows = queryAtoms(store, opts);
				const text = rows.length
					? rows
							.map((r) => {
								const snippet = r.body.split("\n")[0].trim().slice(0, 80);
								return `- **${r.id}** (${r.type}, ${r.status}) ${r.title}${r.promoted_to ? ` → ${r.promoted_to}` : ""}${snippet ? `\n  ${snippet}${r.body.length > snippet.length ? "…" : ""}` : ""}`;
							})
							.join("\n")
					: "no matching atoms";
				pi.sendMessage({
					customType: "grill-atom-query",
					content: `# atom query\n\n${text}`,
					display: true,
				});
				return;
			}
			if (command === "digest") {
				const task = rest.startsWith("--task") ? rest.slice(6).trim() : "";
				pi.sendMessage({
					customType: "grill-atom-digest",
					content: renderDigest(store, task ? { task } : undefined),
					display: true,
				});
				return;
			}
			ctx.ui.notify(
				`Unknown atom command: ${command}. Try /atom help.`,
				"warning",
			);
		} catch (error) {
			ctx.ui.notify(
				`atom error: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	pi.registerCommand("checkpoint", {
		description: "Show the current Grill Me checkpoint in an overlay",
		handler: async (args, ctx) => {
			await showCheckpoint(ctx, args.trim());
		},
	});

	pi.registerCommand("grill", {
		description: "Start or control a Socratic Grill Me planning session",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const command = firstWord(trimmed);
			const rest = trimmed.slice(command.length).trim();

			if (command === "help") {
				pi.sendMessage({
					customType: "grill-me-help",
					content: `# Grill Me commands

- /grill <topic> — start a session
- /grill stop — stop the session
- /grill status — show session status
- /grill checkpoint [edit|chat] — show/edit the checkpoint (also /checkpoint)
- /grill intent auto|plan|learn|research|content|decide
- /grill output <one or more outputs> (preference only; approval still required)
- /grill research off|ask|auto
- /grill atom on|off|init|doctor|query|digest — grill atom knowledge base (toggle for this session)
- /grill subagents on|off — toggle the first-class subagent integration (auto grounding scouts, end-of-process reviewer, write delegation)
- /grill isolation [worktrees|gitbutler|slices|auto] — show or set the isolation backend for this session (session-only override; default from grill.json)
- /atom init|doctor|query|digest — grill atom knowledge base (see /atom help)

Grill Me uses one thorough default Socratic style. Grounding is first-class: a compact repo dossier is captured automatically at session start; per-question spot-checks use cymbal tools and read-only scouts.

Subagent integration defaults from ~/.pi/agent/grill.json ({ "subagents": true|false }) or .pi/grill.json in the project; /grill subagents overrides per session. When on, the session uses installed read-only scouts for grounding, an end-of-process reviewer pass (grill_run_reviewer: checkpoint vs produced outputs vs edited files, PASS or gap list, 2-round cap), and optional write delegation in the approved output phase.

The mandatory output-selection phase still gates all output production: grill_enter_output_selection_phase → user choice → grill_enter_output_phase. State auto-persists every change; switching model mid-session is safe. Old grill sessions from previous versions are not resumed after upgrading.`,
					display: true,
				});
				return;
			}

			if (command === "stop") {
				runtime.state.active = false;
				runtime.state.phase = "interview";
				runtime.state.outputPhase = false;
				runtime.state.outputSelection = undefined;
				runtime.state.approvedOutputPlan = undefined;
				runtime.state.currentQuestion = undefined;
				runtime.state.alternatives = [];
				runtime.state.availableWriters = [];
				runtime.state.reviewer = undefined;
				runtime.state.reviewerRounds = 0;
				runtime.state.delegate = undefined;
				runtime.state.chosenWriter = undefined;
				runtime.state.outputPaths = undefined;
				runtime.state.lastChangeSummary = "Stopped grill session";
				persist();
				updateUi(ctx);
				ctx.ui.notify("Grill mode stopped.", "info");
				return;
			}

			if (command === "status") {
				pi.sendMessage({
					customType: "grill-me-status",
					content: statusMarkdown(runtime.state),
					display: true,
				});
				return;
			}

			if (command === "checkpoint") {
				await showCheckpoint(ctx, rest);
				return;
			}

			if (command === "intent") {
				const value = asIntent(rest);
				if (!value) {
					ctx.ui.notify(`Usage: /grill intent ${INTENTS.join("|")}`, "warning");
					return;
				}
				runtime.state.intent = value;
				runtime.state.lastChangeSummary = `Intent set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill intent: ${value}`, "info");
				return;
			}

			if (command === "output") {
				if (!rest) {
					ctx.ui.notify(
						"Usage: /grill output <one or more outputs, e.g. design-doc,issues>",
						"warning",
					);
					return;
				}
				runtime.state.outputPreference = rest;
				runtime.state.lastChangeSummary = `Output preference set to ${rest}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(
					`Grill output preference: ${rest}. This is not approval; Grill Me will still ask/confirm before producing outputs.`,
					"info",
				);
				return;
			}

			if (command === "research") {
				const value = asResearchMode(rest);
				if (!value) {
					ctx.ui.notify(
						`Usage: /grill research ${RESEARCH_MODES.join("|")}`,
						"warning",
					);
					return;
				}
				runtime.state.researchMode = value;
				runtime.state.lastChangeSummary = `Research mode set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(`Grill research mode: ${value}`, "info");
				return;
			}

			if (command === "atom") {
				const sub = firstWord(rest);
				if (sub === "on" || sub === "off") {
					const value = sub === "on";
					runtime.state.atomOverride = value;
					runtime.state.lastChangeSummary = `atom ${value ? "enabled" : "disabled"} (session)`;
					persist();
					updateUi(ctx);
					ctx.ui.notify(
						`atom ${value ? "enabled" : "disabled"} for this session (settings default unchanged).`,
						"info",
					);
					return;
				}
				await handleAtom(rest, ctx);
				return;
			}

			if (command === "subagents") {
				const value = asSubagentsValue(rest);
				if (!runtime.state.active && value === undefined) {
					ctx.ui.notify("Usage: /grill subagents on|off", "warning");
					return;
				}
				if (value === undefined) {
					ctx.ui.notify(
						`Subagent integration: ${runtime.state.subagents ? "on" : "off"}. Toggle with /grill subagents on|off.`,
						"info",
					);
					return;
				}
				runtime.state.subagents = value;
				runtime.state.lastChangeSummary = `Subagent integration ${value ? "enabled" : "disabled"}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(
					`Grill subagent integration: ${value ? "on" : "off"}.`,
					"info",
				);
				return;
			}

			if (command === "isolation") {
				const override = rest.trim();
				if (!override) {
					const effective =
						runtime.state.sessionIsolationOverride ??
						runtime.state.isolationSetting ??
						"auto";
					const source = runtime.state.sessionIsolationOverride
						? "session override"
						: runtime.state.isolationSetting
							? "grill.json"
							: "default auto";
					const lastBatch = runtime.state.resolvedIsolation
						? ` Last batch: ${runtime.state.resolvedIsolation.backend} — ${runtime.state.resolvedIsolation.reason}.`
						: "";
					ctx.ui.notify(
						`Isolation backend: ${effective} (source: ${source}).${lastBatch}`,
						"info",
					);
					return;
				}
				const value = asIsolationSetting(override);
				if (value === undefined) {
					ctx.ui.notify(
						"Usage: /grill isolation [worktrees|gitbutler|slices|auto]",
						"warning",
					);
					return;
				}
				runtime.state.sessionIsolationOverride = value;
				runtime.state.lastChangeSummary = `Isolation override set to ${value}`;
				persist();
				updateUi(ctx);
				ctx.ui.notify(
					`Isolation override (session): ${value}. Takes effect at the next delegated batch.`,
					"info",
				);
				return;
			}

			const parsed = parseArgs(trimmed);
			const partial: Partial<GrillState> = {};
			const intent = asIntent(parsed.flags.intent);
			const researchMode = asResearchMode(parsed.flags.research);
			if (intent) partial.intent = intent;
			if (researchMode) partial.researchMode = researchMode;
			if (typeof parsed.flags.output === "string")
				partial.outputPreference = parsed.flags.output;

			let topic = parsed.rest;
			if (!topic) {
				const inferred = inferTopic(ctx);
				if (ctx.hasUI) {
					const edited = await ctx.ui.editor(
						"What should I grill you about?",
						inferred || "",
					);
					if (!edited?.trim()) {
						ctx.ui.notify("Cancelled grill start.", "info");
						return;
					}
					topic = edited.trim();
				} else {
					topic = inferred || "Current conversation";
				}
			}

			await startSession(topic, ctx, partial);
		},
	});

	pi.registerCommand("atom", {
		description: "Grill atom: init, doctor, query, digest",
		handler: (args, ctx) => handleAtom(args, ctx),
	});
}
