import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Sink credential resolution: dev-owned env vars first, then per-sink
 * sections in ~/.pi/agent/auth.json (pi's provider-key store — the same
 * file jina reads) with $VAR indirection. Credentials never enter a repo
 * or a specd store; the file is read fresh at every call, so testing or
 * migrating between adapters never needs a pi restart. */

/** Read one auth.json section with $VAR indirection so secrets can stay
 * in the shell. */
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

export interface CredentialSpec {
	/** env var name → auth.json field name. */
	envVars: Record<string, string>;
}

/** Per-sink credential mappings. github uses the gh CLI (no env vars);
 * null needs nothing. Field names double as the auth.json section keys. */
export const SINK_CREDENTIAL_SPECS: Record<string, CredentialSpec> = {
	github: { envVars: {} },
	null: { envVars: {} },
	linear: { envVars: { LINEAR_API_KEY: "key" } },
	jira: {
		envVars: {
			JIRA_HOST: "host",
			JIRA_EMAIL: "email",
			JIRA_API_TOKEN: "key",
		},
	},
	notion: { envVars: { NOTION_API_TOKEN: "key" } },
	trello: { envVars: { TRELLO_KEY: "key", TRELLO_TOKEN: "token" } },
	clickup: { envVars: { CLICKUP_API_TOKEN: "key" } },
};

/** Resolve a registered sink's credentials (spec comes from the registry). */
export function sinkCredentials(sinkId: string): CredentialResolution {
	return resolveSinkCredentials(
		sinkId,
		SINK_CREDENTIAL_SPECS[sinkId] ?? { envVars: {} },
	);
}

/** Resolve one sink's credentials from its registry env-var mapping. */
export function resolveSinkCredentials(
	sinkId: string,
	spec: CredentialSpec,
): CredentialResolution {
	const section = authSection(sinkId);
	const present: Record<string, string> = {};
	const missing: string[] = [];
	for (const [envName, field] of Object.entries(spec.envVars)) {
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
