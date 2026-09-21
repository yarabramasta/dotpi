import { describe, expect, test } from "vitest";
import grillMeExtension from "../index.ts";
import { buildSystemPrompt } from "../prompts.ts";
import { cloneState, DEFAULT_STATE, type GrillState } from "../state.ts";

const TOOL_NAMES = [
	"grill_update_checkpoint",
	"grill_set_alternatives",
	"grill_set_scouts",
	"grill_show_grounding",
	"grill_set_writers",
	"grill_run_reviewer",
	"grill_enter_output_selection_phase",
	"grill_finish_output_selection_phase",
	"grill_enter_output_phase",
	"grill_finish_output_phase",
];

interface StubPi {
	tools: Array<{ name: string }>;
	commands: Array<{ name: string }>;
	events: Record<string, number>;
	appendEntries: number[];
}

function stubPi(): { pi: unknown; stub: StubPi } {
	const stub: StubPi = {
		tools: [],
		commands: [],
		events: {},
		appendEntries: [],
	};
	const pi = {
		registerTool: (def: { name: string }) => stub.tools.push(def),
		registerCommand: (name: string) => stub.commands.push({ name }),
		on: (event: string) => {
			stub.events[event] = (stub.events[event] ?? 0) + 1;
		},
		appendEntry: () => {
			stub.appendEntries.push(1);
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
	};
	return { pi, stub };
}

describe("grill extension wiring", () => {
	test("registers the full tool, command, and event surface", () => {
		const { pi, stub } = stubPi();
		grillMeExtension(pi as never);

		expect(stub.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
		expect(stub.commands.map((c) => c.name)).toEqual(["checkpoint", "grill"]);
		expect(stub.events).toEqual({
			tool_call: 1,
			before_agent_start: 1,
			session_start: 1,
		});
	});
});

describe("buildSystemPrompt", () => {
	test("deterministic for the same state and contains key sections", () => {
		const state: GrillState = {
			...cloneState(DEFAULT_STATE),
			active: true,
			topic: "Example topic",
		};
		const first = buildSystemPrompt(state);
		const second = buildSystemPrompt(state);
		expect(first).toBe(second);
		expect(first).toContain("[GRILL ME EXTENSION ACTIVE]");
		expect(first).toContain("Example topic");
		expect(first).toContain("grill_enter_output_selection_phase");
	});
});
