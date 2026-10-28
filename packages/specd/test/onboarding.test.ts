import { describe, expect, it } from "vitest";
import {
	ONBOARDING,
	SINK_IDS,
	type SinkOnboarding,
} from "../src/sinks/onboarding.js";

describe("sink onboarding registry", () => {
	it("covers the supported sinks with complete, plain-language data", () => {
		expect(SINK_IDS.sort()).toEqual(["github", "null"].sort());
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
				// All five ports are landed (M2c) — graded parity is documented.
				expect(ob.ported, id).toBe(true);
			}
		}
	});
});
