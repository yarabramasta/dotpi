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

/** The sink setup: a vendor-neutral description of the sink structure a
 * cycle exports into — workspace, lanes, label taxonomy, naming convention.
 * Applied idempotently (re-running a converged plan changes nothing) with a
 * read-only preview first. */
export interface SinkSetup {
	/** Sink workspace, adapter-interpreted. */
	workspace: PlanWorkspace;
	/** Lanes = board status options exported tasks can be placed in. */
	lanes: string[];
	/** Label taxonomy ensured to exist on the workspace. */
	labels: string[];
	/** Export title convention with {ref} and {title} placeholders. */
	naming: string;
	/** Explicit mapping of specd item statuses → the board's own workflow
	 * options (D15). updateStatus writes exactly the mapped option and
	 * never creates status options; unmapped states are reported, not
	 * guessed. "in-review" is a sink-side pseudo-status: the option a done
	 * task's still-open PR maps to until the merge reconcile records
	 * pr.merged (default "In review"). */
	statusMap?: Record<string, string>;
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
	/** Read the state of the PR open for a branch, when the sink hosts
	 * code PRs ("open" | "closed" | "merged" on github). Drives the merge
	 * reconcile: a done task's open PR holds its board item in the review
	 * lane until this reports "merged". Adapters without PRs omit it. */
	readPrState?(branch: string): Promise<string>;
	/** Place the item in a lane — a workflow column of the sink (GitHub
	 * Status option, Trello list, …). The kanban placement action. */
	placeInLane?(externalRef: string, lane: string): Promise<void>;
	/** Set tags after creation, if the sink supports it. */
	setTags?(externalRef: string, tags: string[]): Promise<void>;
	/** Set the sink-side WORKFLOW status for the item. Adapters map specd
	 * item statuses through the plan's statusMap (D15) onto the board's
	 * own options — they never invent status options. */
	updateStatus?(externalRef: string, state: string): Promise<void>;
	/** Read-only: the changes the sink needs to converge to the plan.
	 * A not-onboarded (empty) workspace is treated as an empty kanban:
	 * the preview reports the structure that would be created. Status
	 * options are the board's own workflow — never bootstrapped from
	 * lanes. */
	previewPlan?(plan: SinkSetup): Promise<string[]>;
	/** Apply the plan; returns what actually changed. Idempotent: a
	 * converged plan yields []. A not-onboarded (empty) workspace is
	 * treated as an empty kanban — the adapter creates missing structure
	 * (workflow options for lanes, labels for tags) itself instead of
	 * requiring pre-setup in a web UI. Milestones/sprints are the
	 * developer's own grouping and are never written by specd. */
	ensurePlan?(plan: SinkSetup): Promise<string[]>;
}
