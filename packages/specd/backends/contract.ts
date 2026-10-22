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

/** Sink workspace coordinates — github today; other sinks map their own
 * keys at their own ports (M2c). */
export interface PlanWorkspace {
	/** github: user or org hosting the board. */
	owner?: string;
	/** github: Projects v2 project number. */
	projectNumber?: number;
	[key: string]: string | number | undefined;
}

/** The project plan: a vendor-neutral description of the sink structure a
 * cycle exports into — workspace, lanes, label taxonomy, naming convention.
 * Applied idempotently (re-running a converged plan changes nothing) with a
 * read-only preview first. */
export interface ProjectPlan {
	/** Sink workspace, adapter-interpreted. */
	workspace: PlanWorkspace;
	/** Lanes = board status options exported tasks can be placed in. */
	lanes: string[];
	/** Label taxonomy ensured to exist on the workspace. */
	labels: string[];
	/** Export title convention with {ref} and {title} placeholders. */
	naming: string;
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
	/** Read-only: the changes the sink needs to converge to the plan.
	 * A not-onboarded (empty) workspace is treated as an empty kanban:
	 * the preview reports the structure that would be created. */
	previewPlan?(plan: ProjectPlan): Promise<string[]>;
	/** Apply the plan; returns what actually changed. Idempotent: a
	 * converged plan yields []. A not-onboarded (empty) workspace is
	 * treated as an empty kanban — the adapter creates missing structure
	 * (fields, options, labels) itself instead of requiring pre-setup
	 * in a web UI. */
	ensurePlan?(plan: ProjectPlan): Promise<string[]>;
}
