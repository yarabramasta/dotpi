/** The task-sink adapter contract. The core speaks only vendor-neutral
 * concepts; everything platform-specific lives behind this interface.
 *
 * M1 freezes this contract with the GitHub reference adapter implementing
 * createTask/placeInLane/readBack plus isConfigured/verify probes; the
 * updateStatus/setTags surface fills in as the five remaining adapters land
 * (M2/M3). A port is done when it passes the same contract tests GitHub
 * passed. */

export interface TaskExport {
	/** The specd item id being exported (e.g. task-0001). */
	ref: string;
	title: string;
	/** Traceability body: spec excerpt, acceptance criteria, spec-version ref. */
	body: string;
	/** Labels/tags in vendor-neutral form (adapter maps them). */
	labels: string[];
}

export interface TaskCreated {
	/** The sink's identifier for the created work item (issue number etc.). */
	externalRef: string;
	url: string;
}

export interface SinkVerify {
	ok: boolean;
	detail: string;
}

export interface SinkAdapter {
	/** Vendor-neutral adapter id: "null" | "github" | … */
	id: string;
	/** Cheap check: is this sink usable right now (credentials present)? */
	isConfigured(): Promise<boolean>;
	/** Read-only readiness probe — never writes. */
	verify(): Promise<SinkVerify>;
	/** Create the work item in the sink. */
	createTask(task: TaskExport): Promise<TaskCreated>;
	/** Map state back from the sink (issue open/closed → store event). */
	readBack(externalRef: string): Promise<{ state: string }>;
	/** Place the item in a lane/board column, if the sink supports it. */
	placeInLane?(externalRef: string, lane: string): Promise<void>;
	/** Set tags after creation, if the sink supports it. */
	setTags?(externalRef: string, tags: string[]): Promise<void>;
	/** Update the sink-side status, if the sink supports it. */
	updateStatus?(externalRef: string, state: string): Promise<void>;
}
