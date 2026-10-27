import type { SpecdStore } from "../store/store.js";
import { readSinkSetup, readSinkConfig } from "./config.js";
import type { SinkVerify } from "./contract.js";
import type { GhRunner } from "./gh.js";
import { realGhRunner } from "./gh.js";
import { createGithubAdapter } from "./github.js";
import { tryResolveAdapter } from "./resolve.js";

/** Sink onboarding (design §4.6): each non-GitHub sink is completable from
 * the guided flow alone — plain-language steps, exact credential URLs and
 * scopes, dev-owned env vars. Credentials never enter the repo or the
 * store: they live only in the developer's shell environment or
 * ~/.pi/agent/auth.json (same store pi uses for provider keys — outside
 * every repo, shared across sandboxes, read fresh at probe time). */
export interface SinkOnboarding {
	id: string;
	name: string;
	/** Has an adapter port landed yet? Verification beyond credential
	 * presence needs the port; onboarding itself works regardless. */
	ported: boolean;
	/** Where to create the credential, and what it may touch. */
	credentialUrl: string;
	scopes: string;
	/** Dev-owned env var(s), mapped to their auth.json field names.
	 * Never stored in a repo or a specd store. */
	envVars: Record<string, string>;
	steps: string[];
	/** Graded parity: what the adapter port will map specd concepts to,
	 * and what it lacks. Sinks without a kanban board map lanes onto
	 * whatever status equivalent they have. */
	parity: string;
}

export const ONBOARDING: Record<string, SinkOnboarding> = {
	github: {
		id: "github",
		name: "GitHub",
		ported: true,
		credentialUrl: "https://cli.github.com/ (gh auth login)",
		scopes: "repo + project (gh handles scopes)",
		envVars: {},
		steps: [
			"Install the gh CLI if missing.",
			"Run: gh auth login (device flow; credentials stay in gh's own config).",
			"Probe: run /spec doctor — the readiness matrix shows gh's verdict.",
		],
		parity:
			"tasks → issues; lanes → Projects v2 status; labels → labels; naming → issue titles. Full parity (reference adapter).",
	},
	null: {
		id: "null",
		name: "Null (store-native, no external board)",
		ported: true,
		credentialUrl: "—",
		scopes: "—",
		envVars: {},
		steps: ["Nothing to connect: tasks live in the local store only."],
		parity:
			"store-native: tasks are items, lanes are the local status, nothing external.",
	},
};

export const SINK_IDS = Object.keys(ONBOARDING);

/** Probe one sink's readiness: real adapter probe when the sink is
 * configured, credential-presence fallback when it isn't yet. ghRunner is
 * injectable so tests run offline. */
export async function probeSink(
	store: SpecdStore,
	id: string,
	ghRunner?: GhRunner,
): Promise<SinkVerify> {
	if (id === "null") {
		return { ok: true, detail: "store-native; nothing to reach." };
	}
	if (id === "github") {
		const config = readSinkConfig(store, "sink.github");
		if (!config?.owner || !config.projectNumber) {
			return {
				ok: false,
				detail:
					"gh authenticated check skipped — project owner/number not stored yet (/spec sink or first export sets them).",
			};
		}
		const adapter = createGithubAdapter(
			store.cwd,
			{
				owner: String(config.owner),
				projectNumber: Number(config.projectNumber),
				statusMap: readSinkSetup(store)?.statusMap,
			},
			ghRunner ?? realGhRunner,
		);
		return adapter.verify();
	}
	const adapter = tryResolveAdapter(store, id);
	if (adapter) return adapter.verify();
	return {
		ok: false,
		detail: `No adapter found for sink "${id}" — supported: github (via gh CLI), null (store-native).`,
	};
}

/** Doctor readiness matrix: one row per known sink, reflecting per-adapter
 * state. */
export async function readinessMatrix(
	store: SpecdStore,
	ghRunner?: GhRunner,
): Promise<string> {
	const lines: string[] = [
		"## Sink readiness matrix",
		"",
		"| sink | ported | configured | detail |",
		"|---|---|---|---|",
	];
	for (const id of SINK_IDS) {
		const ob = ONBOARDING[id];
		const verify = await probeSink(store, id, ghRunner);
		lines.push(
			`| ${id} | ${ob.ported ? "yes" : "no — M2c"} | ${verify.ok ? "yes" : "no"} | ${verify.detail.replaceAll("|", "\\|")} |`,
		);
	}
	lines.push("", "Not configured? /spec connect <sink> walks you through it.");
	return lines.join("\n");
}
