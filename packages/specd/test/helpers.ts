import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SpecdStore } from "../store/store.js";

export interface TestStore {
	store: SpecdStore;
	dir: string;
	cleanup: () => void;
}

export async function makeStore(): Promise<TestStore> {
	const dir = mkdtempSync(join(tmpdir(), "specd-test-"));
	const store = await openStore(dir);
	return {
		store,
		dir,
		cleanup: () => {
			try {
				store.db.close();
			} catch {
				// already closed by a reopen test — fine
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
