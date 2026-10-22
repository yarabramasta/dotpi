import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SpecdStore } from "../store/store.js";
import { readSinkConfig } from "./config.js";
import type { SinkAdapter, SinkVerify } from "./contract.js";
import type { GhRunner } from "./gh.js";
import { realGhRunner } from "./gh.js";
import { createGithubAdapter } from "./github.js";

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
		ported: false,
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
		ported: false,
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
		ported: false,
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
		ported: false,
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
		ported: false,
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

/** Read one auth.json section (pi's provider-key store — same file jina
 * reads) with $VAR indirection so secrets can stay in the shell. */
function authSection(id: string): Record<string, unknown> | undefined {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	try {
		const auth = JSON.parse(
			readFileSync(join(agentDir, "auth.json"), "utf8"),
		) as Record<string, unknown>;
		const section = auth[id];
		return section && typeof section === "object"
			? (section as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function dereference(value: string): string {
	return value.startsWith("$") ? (process.env[value.slice(1)] ?? "") : value;
}

export interface CredentialResolution {
	/** auth.json field → resolved value (env var wins, then auth.json). */
	present: Record<string, string>;
	/** env var names with no value anywhere. */
	missing: string[];
}

/** Resolve one sink's credentials: each registry env var is looked up in
 * process.env first, then in ~/.pi/agent/auth.json under the sink id
 * (auth.<sink>.<field>, $VAR indirection supported). The file is read
 * fresh at every call, so testing or migrating between adapters never
 * needs a pi restart, and the same credentials follow the dev across
 * sandboxes. Adapters (M2c) consume this same resolution. */
export function resolveSinkCredentials(sinkId: string): CredentialResolution {
	const ob = ONBOARDING[sinkId];
	if (!ob) return { present: {}, missing: [] };
	const section = authSection(sinkId);
	const present: Record<string, string> = {};
	const missing: string[] = [];
	for (const [envName, field] of Object.entries(ob.envVars)) {
		const fromEnv = process.env[envName];
		if (fromEnv) {
			present[field] = fromEnv;
			continue;
		}
		const raw = section?.[field];
		if (typeof raw === "string" && raw) {
			const resolved = dereference(raw);
			if (resolved) {
				present[field] = resolved;
				continue;
			}
		}
		missing.push(envName);
	}
	return { present, missing };
}

/** Probe one sink's readiness. GitHub runs its real adapter probe; the
 * not-yet-ported sinks report env-var presence as "configured" and defer
 * full verification to their port (M2c). ghRunner is injectable so tests
 * run offline. */
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
		const adapter: SinkAdapter = createGithubAdapter(
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
	const ob = ONBOARDING[id];
	if (!ob) return { ok: false, detail: `unknown sink: ${id}` };
	const { missing } = resolveSinkCredentials(id);
	if (missing.length > 0) {
		return {
			ok: false,
			detail: `credential(s) not set in env or ~/.pi/agent/auth.json: ${missing.join(", ")} — /spec connect ${id} walks through it.`,
		};
	}
	return {
		ok: true,
		detail: "credential present; full probe lands with the adapter port.",
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
