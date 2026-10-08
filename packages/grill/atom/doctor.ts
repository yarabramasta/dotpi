import { listAtoms } from "./atoms.js";
import { type AtomStore, SCHEMA_VERSION } from "./store.js";

export type DoctorIssueKind =
	| "schema-version"
	| "empty-body"
	| "orphan-edge"
	| "null-provenance";

export interface DoctorOptions {
	/** strict: also flag promoted decisions with no sources recorded */
	strict?: boolean;
}

export interface DoctorIssue {
	kind: DoctorIssueKind;
	id?: string;
	detail: string;
}

export function runDoctor(
	store: AtomStore,
	options: DoctorOptions = {},
): DoctorIssue[] {
	const issues: DoctorIssue[] = [];

	const version = (
		store.db
			.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
			.get() as { value: string } | undefined
	)?.value;
	if (version !== SCHEMA_VERSION) {
		issues.push({
			kind: "schema-version",
			detail: `schema_version ${version ?? "missing"} (expected ${SCHEMA_VERSION})`,
		});
	}

	const atoms = listAtoms(store);
	const ids = new Set(atoms.map((a) => a.id));

	for (const atom of atoms) {
		if (!atom.body.trim()) {
			issues.push({
				kind: "empty-body",
				id: atom.id,
				detail: `empty body: ${atom.id}`,
			});
		}
	}

	const edges = store.db
		.prepare("SELECT from_id, to_id, kind FROM edges")
		.all() as Array<{ from_id: string; to_id: string; kind: string }>;
	for (const edge of edges) {
		if (!ids.has(edge.from_id) || !ids.has(edge.to_id)) {
			issues.push({
				kind: "orphan-edge",
				detail: `orphan edge: ${edge.from_id} -[${edge.kind}]-> ${edge.to_id} (missing atom)`,
			});
		}
	}

	if (options.strict) {
		for (const atom of atoms) {
			if (
				atom.type === "decision" &&
				atom.status === "promoted" &&
				atom.sources === null
			) {
				issues.push({
					kind: "null-provenance",
					id: atom.id,
					detail: `promoted decision ${atom.id} has no sources — record provenance at creation time`,
				});
			}
		}
	}

	return issues;
}
