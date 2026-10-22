import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSinkConfig, saveSinkConfig } from "../backends/config.js";
import {
	ONBOARDING,
	probeSink,
	readinessMatrix,
	resolveSinkCredentials,
	SINK_IDS,
	type SinkOnboarding,
} from "../backends/onboarding.js";
import { makeStore, type TestStore } from "./helpers.js";

describe("sink onboarding registry", () => {
	it("covers all six sinks with complete, plain-language data", () => {
		expect(SINK_IDS.sort()).toEqual(
			[
				"clickup",
				"github",
				"jira",
				"linear",
				"notion",
				"null",
				"trello",
			].sort(),
		);
		for (const id of SINK_IDS) {
			const ob: SinkOnboarding = ONBOARDING[id];
			expect(ob.id, id).toBe(id);
			expect(ob.name.length, id).toBeGreaterThan(0);
			expect(ob.credentialUrl.length, id).toBeGreaterThan(0);
			expect(ob.scopes.length, id).toBeGreaterThan(0);
			expect(ob.steps.length, id).toBeGreaterThan(0);
			expect(ob.parity, id).toContain("lanes");
			if (id !== "null" && id !== "github") {
				expect(Object.keys(ob.envVars).length, id).toBeGreaterThan(0);
				// Graded parity: every port documents what it lacks.
				expect(ob.ported, id).toBe(false);
			}
		}
	});
});

describe("credential resolution (env first, then ~/.pi/agent/auth.json)", () => {
	let store: TestStore;
	let agentDir: string | undefined;
	const savedEnv: Record<string, string | undefined> = {};

	function useAgentDir(): string {
		agentDir = mkdtempSync(join(tmpdir(), "specd-auth-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		return agentDir;
	}

	function setEnv(name: string, value: string | undefined): void {
		if (!(name in savedEnv)) savedEnv[name] = process.env[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	afterEach(() => {
		store?.cleanup();
		store = undefined as never;
		if (agentDir) {
			rmSync(agentDir, { recursive: true, force: true });
			agentDir = undefined;
		}
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
			delete savedEnv[k];
		}
		delete process.env.PI_CODING_AGENT_DIR;
	});

	async function setup() {
		store = await makeStore();
		return store.store;
	}

	it("resolves from env vars when set", async () => {
		await setup();
		setEnv("LINEAR_API_KEY", "lin_env");
		const { present, missing } = resolveSinkCredentials("linear");
		expect(present).toEqual({ key: "lin_env" });
		expect(missing).toEqual([]);
	});

	it("falls back to the auth.json section, with $VAR indirection", async () => {
		await setup();
		const dir = useAgentDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({
				linear: { key: "$LINEAR_API_KEY" },
				trello: { key: "trello-file-key", token: "trello-file-token" },
			}),
		);
		// $VAR with the var present → resolved
		setEnv("LINEAR_API_KEY", "lin_indirect");
		expect(resolveSinkCredentials("linear").present).toEqual({
			key: "lin_indirect",
		});
		// $VAR with the var absent → missing, not a broken half-credential
		setEnv("LINEAR_API_KEY", undefined);
		const linear = resolveSinkCredentials("linear");
		expect(linear.missing).toEqual(["LINEAR_API_KEY"]);
		// plain file values resolve without env
		const trello = resolveSinkCredentials("trello");
		expect(trello.present).toEqual({
			key: "trello-file-key",
			token: "trello-file-token",
		});
	});

	it("env vars win over the auth.json file", async () => {
		await setup();
		const dir = useAgentDir();
		writeFileSync(
			join(dir, "auth.json"),
			JSON.stringify({ linear: { key: "file-key" } }),
		);
		setEnv("LINEAR_API_KEY", "env-key");
		expect(resolveSinkCredentials("linear").present).toEqual({
			key: "env-key",
		});
	});

	it("reports each missing credential by env-var name", async () => {
		await setup();
		setEnv("JIRA_HOST", "https://x.atlassian.net");
		const { present, missing } = resolveSinkCredentials("jira");
		expect(present).toEqual({ host: "https://x.atlassian.net" });
		expect(missing.sort()).toEqual(["JIRA_API_TOKEN", "JIRA_EMAIL"].sort());
	});

	it("unknown sink resolves to nothing (probeSink handles the refusal)", async () => {
		await setup();
		expect(resolveSinkCredentials("asana")).toEqual({
			present: {},
			missing: [],
		});
	});

	it("probeSink: not-ported sink is ok when credentials are present, plain otherwise", async () => {
		const s = await setup();
		setEnv("NOTION_API_TOKEN", "ntn_x");
		const ok = await probeSink(s, "notion");
		expect(ok.ok).toBe(true);
		expect(ok.detail).toContain("adapter port");
		delete process.env.NOTION_API_TOKEN;
		const no = await probeSink(s, "notion");
		expect(no.ok).toBe(false);
		expect(no.detail).toContain("/spec connect notion");
	});

	it("probeSink: null is always ok; unknown sink refuses", async () => {
		const s = await setup();
		expect((await probeSink(s, "null")).ok).toBe(true);
		expect((await probeSink(s, "asana")).ok).toBe(false);
	});

	it("readiness matrix renders all six rows with per-adapter state", async () => {
		const s = await setup();
		setEnv("CLICKUP_API_TOKEN", "pk_test");
		const matrix = await readinessMatrix(s, async () => ({
			stdout: "",
			stderr: "gh not mocked",
		}));
		for (const id of SINK_IDS) {
			expect(matrix).toContain(`| ${id} |`);
		}
		expect(matrix).toContain("no — M2c"); // not-ported sinks are labeled
		// clickup credential present → configured
		expect(matrix).toContain("| clickup | no — M2c | yes |");
		// github probe without stored owner/project → surfaced, not crashed
		expect(matrix).toContain("| github | yes | no |");
	});

	it("readiness matrix uses the injected gh runner for github", async () => {
		const s = await setup();
		saveSinkConfig(s, "sink.github", { owner: "acme", projectNumber: 7 });
		const matrix = await readinessMatrix(s, async (args) => {
			if (args.includes("auth")) {
				return { stdout: "", stderr: "" };
			}
			return { stdout: JSON.stringify({ name: "app" }), stderr: "" };
		});
		expect(matrix).toContain("| github | yes | yes |");
		expect(readSinkConfig(s, "sink.github")).toMatchObject({ owner: "acme" });
	});
});
