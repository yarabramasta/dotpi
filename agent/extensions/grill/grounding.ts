export { eligibleScouts, type ScoutAgent } from "./grounding-policy.js";

export interface GroundingView {
	summary: string;
	source?: string;
	confidence?: string;
	skippedReason?: string;
}
