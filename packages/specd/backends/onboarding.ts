import type { SpecdStore } from "../store/store.js";
import { readSinkConfig } from "./config.js";
import type { SinkVerify } from "./contract.js";
import { sinkCredentials } from "./credentials.js";
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
	linear: {
		id: "linear",
		name: "Linear",
		ported: true,
		credentialUrl: "https://linear.app/settings/api",
		scopes: "read/write issues and projects (GraphQL, scoped API key)",
		envVars: { LINEAR_API_KEY: "key" },
		steps: [
			"Create an API key at linear.app/settings/api.",
			'Either export LINEAR_API_KEY in your shell profile, or add { "linear": { "key": "…" } } to ~/.pi/agent/auth.json (recommended — no pi restart needed).',
			"Then run /spec doctor and check the linear row in the readiness matrix.",
		],
		parity:
			"tasks → issues; lanes → team workflow states (no board columns); labels → labels; naming → issue titles.",
	},
	jira: {
		id: "jira",
		name: "Jira",
		ported: true,
		credentialUrl:
			"https://id.atlassian.com/manage-profile/security/api-tokens",
		scopes: "REST v3 via Basic auth (email + API token)",
		envVars: { JIRA_HOST: "host", JIRA_EMAIL: "email", JIRA_API_TOKEN: "key" },
		steps: [
			"Create an API token at id.atlassian.com/manage-profile/security/api-tokens.",
			'Either export JIRA_HOST (e.g. https://yourco.atlassian.net), JIRA_EMAIL and JIRA_API_TOKEN, or add { "jira": { "host": "…", "email": "…", "key": "…" } } to ~/.pi/agent/auth.json.',
			"Then run /spec doctor and check the jira row in the readiness matrix.",
		],
		parity:
			"tasks → issues; lanes → board column/status (needs a company-managed board); labels → labels; naming → issue summary.",
	},
	notion: {
		id: "notion",
		name: "Notion",
		ported: true,
		credentialUrl: "https://www.notion.so/my-integrations",
		scopes: "integration token; share target database(s) with the integration",
		envVars: { NOTION_API_TOKEN: "key" },
		steps: [
			"Create an internal integration at notion.so/my-integrations.",
			"Share the target database with the integration (Notion → ••• → Connections).",
			'Either export NOTION_API_TOKEN, or add { "notion": { "key": "…" } } to ~/.pi/agent/auth.json. Then run /spec doctor.',
		],
		parity:
			"tasks → database rows; lanes → status property; labels → multi-select property; naming → page title; no board kanban view required.",
	},
	trello: {
		id: "trello",
		name: "Trello",
		ported: true,
		credentialUrl: "https://trello.com/app-key",
		scopes: "key + token (read/write boards and cards)",
		envVars: { TRELLO_KEY: "key", TRELLO_TOKEN: "token" },
		steps: [
			"Get your key at trello.com/app-key and generate a token on the same page.",
			'Either export TRELLO_KEY and TRELLO_TOKEN, or add { "trello": { "key": "…", "token": "…" } } to ~/.pi/agent/auth.json. Then run /spec doctor.',
		],
		parity:
			"tasks → cards; lanes → lists (native kanban); labels → labels (per-board cap); naming → card names.",
	},
	clickup: {
		id: "clickup",
		name: "ClickUp",
		ported: true,
		credentialUrl: "https://app.clickup.com/settings/developers",
		scopes: "personal API token (pk_…), sent as a raw header",
		envVars: { CLICKUP_API_TOKEN: "key" },
		steps: [
			"Create a personal token at app.clickup.com/settings/developers.",
			'Either export CLICKUP_API_TOKEN, or add { "clickup": { "key": "…" } } to ~/.pi/agent/auth.json. Then run /spec doctor.',
		],
		parity:
			"tasks → tasks; lanes → list statuses; labels → tags; naming → task names; needs space/list ids as workspace coords.",
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
					"gh authenticated check skipped — project owner/number not stored yet (/spec plan or first export sets them).",
			};
		}
		const adapter = createGithubAdapter(
			store.cwd,
			{
				owner: String(config.owner),
				projectNumber: Number(config.projectNumber),
				lane: typeof config.lane === "string" ? config.lane : undefined,
			},
			ghRunner ?? realGhRunner,
		);
		return adapter.verify();
	}
	const adapter = tryResolveAdapter(store, id);
	if (adapter) return adapter.verify();
	const { missing } = sinkCredentials(id);
	if (missing.length > 0) {
		return {
			ok: false,
			detail: `credential(s) not set in env or ~/.pi/agent/auth.json: ${missing.join(", ")} — /spec connect ${id} walks through it.`,
		};
	}
	// Credential present but the workspace isn't wired yet: the readiness
	// matrix must not claim "configured" for a sink we have never probed.
	return {
		ok: false,
		detail: `credential present; workspace ids not stored yet — run /spec plan to set them, then this row probes the live ${ONBOARDING[id]?.name ?? id} API.`,
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
