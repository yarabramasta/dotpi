import { existsSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	DEFAULT_LABELS,
	DEFAULT_LANES,
	DEFAULT_NAMING,
	readSinkConfig,
	readSinkSetup,
	saveSinkConfig,
	saveSinkSetup,
} from "../sinks/config.js";
import type { PlanWorkspace } from "../sinks/contract.js";
import { resolveAdapter } from "../sinks/resolve.js";
import {
	addStoreReference,
	isSpecdStore,
	lookupStore,
	registerStore,
	resolveReferenceStores,
	type StoreRegistryEntry,
	storesRoot,
} from "../store/registry.js";
import { openSpecd, text } from "./store-tools.js";

export function parseReferenceTarget(
	input: string,
):
	| { kind: "git"; url: string; slug: string }
	| { kind: "path"; target: string } {
	const url = input.trim();
	if (
		url.startsWith("https://") ||
		url.startsWith("http://") ||
		url.startsWith("ssh://") ||
		url.startsWith("git@") ||
		url.endsWith(".git")
	) {
		const slug = path.basename(url.replace(/\.git$/, ""));
		return { kind: "git", url, slug };
	}
	return { kind: "path", target: url };
}

function sanitizeWorkspace(
	raw: Record<string, unknown> | undefined,
): PlanWorkspace {
	const out: PlanWorkspace = {};
	for (const [k, v] of Object.entries(raw ?? {})) {
		if (typeof v === "string" || typeof v === "number") out[k] = v;
	}
	return out;
}

export function registerSinkTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "specd_store",
		label: "Manage specd store registration",
		description:
			"Manage specd store registration and references. action=status checks registration; action=register (type, storePath, remote) registers a location; action=reference (store) adds a read-only reference.",
		promptSnippet: "Check, register, or reference a specd store",
		parameters: Type.Object({
			action: Type.String({
				description: '"status" | "register" | "reference".',
			}),
			type: Type.Optional(
				Type.String({
					description: 'register: "in-repo", "external", or "external-git".',
				}),
			),
			storePath: Type.Optional(
				Type.String({
					description: "register: absolute path (required for external types).",
				}),
			),
			remote: Type.Optional(
				Type.String({
					description: "register: git remote URL for external-git stores.",
				}),
			),
			store: Type.Optional(
				Type.String({
					description: "reference: store directory path or git URL.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action as "status" | "register" | "reference";

			// ----- status -----
			if (action === "status") {
				const cwd = ctx.cwd;
				const entry = lookupStore(cwd);
				const inRepo = existsSync(join(cwd, ".spec", "store.db"));
				const refs = resolveReferenceStores(cwd);
				if (entry) {
					const refLines =
						refs.length === 0
							? ""
							: `\n\nReferences:\n${refs
									.map((r) => `- ${isSpecdStore(r) ? "✓" : "✗ missing"} ${r}`)
									.join("\n")}`;
					return text(
						`Store registered: type=${entry.type}, path=${entry.storePath ?? "(in-repo)"}${entry.remote ? `, remote=${entry.remote}` : ""}${refLines}`,
					);
				}
				if (inRepo) {
					return text(
						"Store found at .spec/store.db (in-repo, not registered).",
					);
				}
				return text(
					"No specd store found for this repo. Ask the user where it should live:\n" +
						"1. External — specd-managed (zero footprint)\n" +
						"2. External — git repo (shareable, versioned)\n" +
						"3. In this repo (.spec/, gitignored)\n" +
						"4. In this repo (.spec/, committed)\n" +
						'Then register it with specd_store(action="register").',
				);
			}

			// ----- register -----
			if (action === "register") {
				if (!params.type) {
					return text(
						"register action requires type=<in-repo|external|external-git>.",
					);
				}
				const entry: StoreRegistryEntry = {
					type: params.type as StoreRegistryEntry["type"],
				};
				if (params.storePath) entry.storePath = params.storePath;
				if (params.remote) entry.remote = params.remote;
				if (params.type !== "in-repo" && !params.storePath) {
					return text(
						`External stores need a storePath. Got type=${params.type} without a path.`,
					);
				}
				registerStore(ctx.cwd, entry);
				return text(
					`Registered: ${ctx.cwd} → ${params.type}${params.storePath ? ` (${params.storePath})` : ""}`,
				);
			}

			// ----- reference -----
			if (!params.store) {
				return text("reference action requires store=<path-or-git-url>.");
			}
			const target = parseReferenceTarget(params.store);
			let dir: string;
			if (target.kind === "git") {
				dir = path.join(storesRoot(), target.slug);
				mkdirSync(storesRoot(), { recursive: true });
				if (!isSpecdStore(dir)) {
					const { execFileSync } = await import("node:child_process");
					try {
						execFileSync("git", ["clone", target.url, dir], {
							stdio: "pipe",
						});
					} catch (error) {
						const msg = error instanceof Error ? error.message : String(error);
						return text(
							`Failed to clone reference store: ${msg}\n\nHint: ensure the URL is reachable and you have git credentials configured.`,
						);
					}
				}
				if (!isSpecdStore(dir)) {
					return text(
						`Cloned directory is not a specd store: ${dir}\n\nProvide an absolute path to a store directory containing store.db, or a git URL to clone.`,
					);
				}
			} else {
				dir = path.resolve(target.target);
				if (!isSpecdStore(dir)) {
					return text(
						`Not a specd store: ${dir}\n\nProvide an absolute path to a store directory containing store.db, or a git URL to clone.`,
					);
				}
			}
			const result = addStoreReference(ctx.cwd, dir);
			if (!result.ok) {
				return text(`Cannot add reference: ${result.reason}`);
			}
			const refs = resolveReferenceStores(ctx.cwd);
			return text(
				`Referenced store added.\n\nReferences (${refs.length}):\n${refs.map((r) => `- ${r}`).join("\n")}`,
			);
		},
	});

	pi.registerTool({
		name: "specd_configure_sink",
		label: "Configure the specd sink",
		description:
			"Preview (default, read-only) or apply the sink setup: workspace, lanes, labels, naming. Apply is idempotent. The plan persists and drives export titles and lane placement; labels are repo-wide vocabulary seeded here, never per-issue decoration.",
		promptSnippet: "Preview/apply the sink setup",
		parameters: Type.Object({
			sink: Type.String({
				description: 'Sink id ("null" or "github").',
			}),
			apply: Type.Optional(
				Type.Boolean({
					description: "true applies (write); default previews.",
				}),
			),
			github_owner: Type.Optional(
				Type.String({
					description: "GitHub org or user.",
				}),
			),
			github_project_number: Type.Optional(
				Type.Number({
					description: "GitHub Projects v2 number.",
				}),
			),
			workspace: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description: "Non-github sinks: workspace coords. null needs none.",
				}),
			),
			lanes: Type.Optional(
				Type.Array(Type.String(), {
					description: `Lanes (board status options). Defaults: ${DEFAULT_LANES.join(", ")}.`,
				}),
			),
			labels: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Label taxonomy ensured on the workspace. Defaults: specd.",
				}),
			),
			naming: Type.Optional(
				Type.String({
					description: `Export title convention with {ref} and {title} placeholders. Defaults: "${DEFAULT_NAMING}".`,
				}),
			),
			statusMap: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						'specd status → board workflow option, e.g. { exported: "Ready", "in-progress": "In progress", done: "Done" }. Optional "in-review": lane for a done task\'s open PR (default "In review").',
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await openSpecd(ctx);
			const sink = params.sink;

			// Build the workspace from params + stored config.
			const stored = readSinkConfig(store, "sink.github");
			const workspace: PlanWorkspace =
				sink === "github"
					? {
							owner:
								params.github_owner ??
								(typeof stored?.owner === "string" ? stored.owner : undefined),
							projectNumber:
								params.github_project_number ??
								(typeof stored?.projectNumber === "number"
									? stored.projectNumber
									: undefined),
						}
					: sanitizeWorkspace(
							params.workspace ?? readSinkConfig(store, `sink.${sink}`),
						);

			// Persist the workspace coords so later exports resolve the
			// adapter straight from the store.
			const priorConfig = readSinkConfig(store, `sink.${sink}`) ?? {};
			saveSinkConfig(store, `sink.${sink}`, {
				...priorConfig,
				...workspace,
			});

			// Merge with defaults and any stored plan.
			const prior = readSinkSetup(store);
			const plan = {
				workspace,
				lanes: params.lanes ?? prior?.lanes ?? [...DEFAULT_LANES],
				labels: params.labels ?? prior?.labels ?? [...DEFAULT_LABELS],
				naming: params.naming ?? prior?.naming ?? DEFAULT_NAMING,
				statusMap: params.statusMap ?? prior?.statusMap,
			};

			const adapter = resolveAdapter(store, sink);
			if (!adapter.previewPlan || !adapter.ensurePlan) {
				return text(
					`Sink "${sink}" does not support sink setups (no external board). Nothing to apply.`,
				);
			}

			if (!params.apply) {
				const changes = await adapter.previewPlan(plan);
				saveSinkSetup(store, plan, sink); // persist intent even on preview
				return text(
					changes.length === 0
						? `Plan preview for ${sink}: already converged — no changes needed.`
						: `Plan preview for ${sink} (${changes.length} change(s)):\n${changes.map((c) => `- ${c}`).join("\n")}\n\nRe-run with apply=true to apply.`,
				);
			}

			const changes = await adapter.ensurePlan(plan);
			saveSinkSetup(store, plan, sink);
			return text(
				changes.length === 0
					? `Plan applied for ${sink}: already converged — no changes.`
					: `Plan applied for ${sink} (${changes.length} change(s)):\n${changes.map((c) => `- ${c}`).join("\n")}`,
			);
		},
	});
}
