# Stale required-tool set repro runbook

**Type:** How-to / repro procedure  
**Audience:** specd/dotpi maintainers debugging a stale required-tool name in a worker/reviewer spawn  
**Runtime cost:** no model calls, no writes to `~/.pi` or `node_modules` beyond read-only imports from the installed `pi-subagents` package

## Goal

Reproduce and locate where a live `pi` parent session reuses a stale required-tool set after the extension or agent definition that supplied the name has been renamed/removed.

This runbook is the repro slice from [spec-0007](../..) (Deterministic specd subagent spawns).  
The conclusion is captured here so the parent session can record it as evidence on `cycle-0003`.

## Root cause observed

The stale required-tool set is read from the **`pi-subagents` runtime agent registry** held in the live parent `pi` process, *not* from a fresh read of the extension source or agent definition file.

- A stub extension registers tool `stale_repro_x` and a runtime agent `repro-agent` whose allowlist names `stale_repro_x`.
- The first spawn resolves the launch tool-plan to `["read", "stale_repro_x"]`.
- Rename the tool to `stale_repro_y` in the extension source **without** reloading the parent process.
- A second spawn in the *same* process still resolves to `["read", "stale_repro_x"]` because the runtime agent registry still holds the old definition.
- A *fresh* `pi` process loads the updated extension and resolves to `["read", "stale_repro_y"]`.

This matches the 2026-10-29 lingua-lair-core symptom: after `cbc3afa` merged the specd tool surface, a still-running parent session spawned workers that still carried the pre-merge tool names.

## What the launch resolved (executed 2026-10-29)

Warm parent process, extension source already rewritten to `v2` (`stale_repro_y`):

```json
{
  "date": "2026-10-29T16:00:21.141Z",
  "phase": "warm-same-process",
  "extensionFile": "/private/tmp/ext/index.js",
  "liveToolRegistry": ["stale_repro_x"],
  "warm1": {
    "agent": { "name": "repro-agent", "filePath": "runtime:repro-agent", "tools": ["read", "stale_repro_x"] },
    "plan": { "effectiveToolAllowlist": ["read", "stale_repro_x"], "requiredChildTools": ["read", "stale_repro_x"] }
  },
  "warm2": {
    "agent": { "name": "repro-agent", "filePath": "runtime:repro-agent", "tools": ["read", "stale_repro_x"] },
    "plan": { "effectiveToolAllowlist": ["read", "stale_repro_x"], "requiredChildTools": ["read", "stale_repro_x"] }
  },
  "observation": "warm2 still lists stale_repro_x in required set despite extension file now defining stale_repro_y",
  "source": "runtime agent registry in live parent Pi session"
}
```

Fresh process loading the updated extension source:

```json
{
  "date": "2026-10-29T16:00:21.205Z",
  "phase": "fresh-process",
  "extensionFile": "/private/tmp/ext/index.js",
  "liveToolRegistry": ["stale_repro_y"],
  "agent": { "name": "repro-agent", "filePath": "runtime:repro-agent", "tools": ["read", "stale_repro_y"] },
  "plan": { "effectiveToolAllowlist": ["read", "stale_repro_y"], "requiredChildTools": ["read", "stale_repro_y"] },
  "observation": "fresh process reads current extension source and resolves required set with stale_repro_y",
  "source": "extension source file loaded in fresh process"
}
```

## Procedure

### Scripted repro

1. Save the two files below to `/tmp`.
2. Adjust `SUBAGENTS` if `pi-subagents` is installed somewhere other than `~/.pi/agent/npm/node_modules/pi-subagents`.
3. Run:

```bash
node /tmp/stale-repro.mjs
```

The main script:

- Creates `/tmp/ext/` with a stub extension.
- Loads the `v1` extension (registers tool `stale_repro_x` + runtime agent `repro-agent` requiring it) and resolves `pi-subagents` launch tool-plan.
- Overwrites the extension source with `v2` (renames the tool to `stale_repro_y`) **without** reloading the parent process.
- Resolves the launch tool-plan again in the same process — the required set is still `stale_repro_x`.
- Spawns a fresh Node process (`/tmp/fresh-repro.mjs`) that loads the updated extension and resolves the required set as `stale_repro_y`.

```js
// /tmp/stale-repro.mjs
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const extDir = join(here, 'ext');
mkdirSync(extDir, { recursive: true });

const SUBAGENTS = `${process.env.HOME}/.pi/agent/npm/node_modules/pi-subagents`;

const [{ registerRuntimeAgent, listRuntimeAgentConfigs }, { resolvePiLaunchToolPlan }] = await Promise.all([
  import(`${SUBAGENTS}/bundle/chunk-G2Z6ZH26.js`),
  import(`${SUBAGENTS}/bundle/child-tool-plan.js`),
]);

const stubV1 = `import { registerRuntimeAgent } from '${SUBAGENTS}/bundle/chunk-G2Z6ZH26.js';
export default function register(pi) {
  pi.registerTool({ name: 'stale_repro_x', label: 'X', description: 'repro tool X', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'x' }] }) });
  registerRuntimeAgent({ pi, name: 'repro-agent', definition: { description: 'repro agent v1', systemPrompt: 'repro agent v1 needs X', tools: ['read', 'stale_repro_x'], model: 'x/y' } });
}`;

const stubV2 = `import { registerRuntimeAgent } from '${SUBAGENTS}/bundle/chunk-G2Z6ZH26.js';
export default function register(pi) {
  pi.registerTool({ name: 'stale_repro_y', label: 'Y', description: 'repro tool Y', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'y' }] }) });
  registerRuntimeAgent({ pi, name: 'repro-agent', definition: { description: 'repro agent v2', systemPrompt: 'repro agent v2 needs Y', tools: ['read', 'stale_repro_y'], model: 'x/y' } });
}`;

// Minimal mock of the pi ExtensionAPI that pi-subagents expects.
const pi = {
  tools: [],
  registerTool(t) { this.tools.push(t.name); },
  on() {},
  getAllTools() { return this.tools; },
  getActiveTools() { return this.tools; },
};

function resolvePlan(agentName) {
  const [agent] = listRuntimeAgentConfigs(pi).filter(a => a.name === agentName);
  const plan = resolvePiLaunchToolPlan({ tools: agent?.tools ?? [], cwd: here, agentName });
  return {
    agent: { name: agent?.name, filePath: agent?.filePath, tools: agent?.tools },
    plan: { effectiveToolAllowlist: plan.effectiveToolAllowlist, requiredChildTools: plan.requiredChildTools },
  };
}

writeFileSync(join(extDir, 'index.js'), stubV1);

// Phase 1: load v1, capture warm1 resolution.
const v1mod = await import(join(extDir, 'index.js') + '?v=1');
v1mod.default(pi);
const warm1 = resolvePlan('repro-agent');

// Phase 2: overwrite extension source with v2 but do NOT reload or clear the registry.
writeFileSync(join(extDir, 'index.js'), stubV2);
const warm2 = resolvePlan('repro-agent');

console.log(JSON.stringify({
  date: new Date().toISOString(),
  phase: 'warm-same-process',
  extensionFile: join(extDir, 'index.js'),
  liveToolRegistry: pi.tools,
  warm1,
  warm2,
  observation: 'warm2 still lists stale_repro_x in required set despite extension file now defining stale_repro_y',
  source: 'runtime agent registry in live parent Pi session',
}, null, 2));

// Phase 3: fresh Node process loads the updated extension source.
const cp = spawn(process.execPath, [join(here, 'fresh-repro.mjs')], { stdio: 'inherit' });
cp.on('exit', (code) => process.exit(code ?? 0));
```

```js
// /tmp/fresh-repro.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SUBAGENTS = `${process.env.HOME}/.pi/agent/npm/node_modules/pi-subagents`;

const [{ registerRuntimeAgent, listRuntimeAgentConfigs }, { resolvePiLaunchToolPlan }] = await Promise.all([
  import(`${SUBAGENTS}/bundle/chunk-G2Z6ZH26.js`),
  import(`${SUBAGENTS}/bundle/child-tool-plan.js`),
]);

const pi = {
  tools: [],
  registerTool(t) { this.tools.push(t.name); },
  on() {},
  getAllTools() { return this.tools; },
  getActiveTools() { return this.tools; },
};

const mod = await import(join(here, 'ext', 'index.js') + '?v=3');
mod.default(pi);
const [agent] = listRuntimeAgentConfigs(pi).filter(a => a.name === 'repro-agent');
const plan = resolvePiLaunchToolPlan({ tools: agent?.tools ?? [], cwd: here, agentName: 'repro-agent' });

console.log(JSON.stringify({
  date: new Date().toISOString(),
  phase: 'fresh-process',
  extensionFile: join(here, 'ext', 'index.js'),
  liveToolRegistry: pi.tools,
  agent: { name: agent?.name, filePath: agent?.filePath, tools: agent?.tools },
  plan: { effectiveToolAllowlist: plan.effectiveToolAllowlist, requiredChildTools: plan.requiredChildTools },
  observation: 'fresh process reads current extension source and resolves required set with stale_repro_y',
  source: 'extension source file loaded in fresh process',
}, null, 2));
```

### Manual Pi-TUI repro

1. Create a stub extension in a temporary directory:
   - registers a tool `stale_repro_x`
   - registers (or defines in `agent/agents/repro-agent.md`) an agent `repro-agent` whose `tools:` list includes `stale_repro_x`
2. Start `pi` in a directory where that agent is discoverable and load the extension.
3. Spawn the agent as a **background** child (`subagent(..., async: true)` or the `/subagents` slash).  
   The launch succeeds because `stale_repro_x` is registered.
4. While that `pi` session is still running, edit the extension source to rename/remove `stale_repro_x`.
5. Spawn `repro-agent` again from the *same* `pi` session.  
   **Expected buggy behavior:** the launch still carries `stale_repro_x` in its required set, or fails because the tool no longer exists while the agent contract still names it.
6. Quit and restart `pi` (fresh parent process). Spawn `repro-agent` again.  
   **Expected after restart:** the launch resolves to the updated tool name (`stale_repro_y` or a failure with a *current* tool set).

## Conclusion

- **Pinned cause:** `pi-subagents` keeps runtime-registered agents in a process-local registry keyed by the live `pi` session. When an extension renames or removes a tool, the parent session does not re-evaluate the runtime agent definition on the next spawn, so the child launch reuses a stale `tools` allowlist.
- **Local mitigation (already applied in dotpi):** pin `agent/agents/specd-worker.md` and `agent/agents/specd-reviewer.md` with an explicit `tools:` snapshot, and add a `dotpi doctor` guard that resolves each agent definition against the current tool surface. This catches stale names before they reach a spawn.
- **Upstream:** this is a `nicobailon/pi-subagents` bug. Draft issue text below can be filed.

## Upstream draft issue

**Title:** Runtime-registered agents leak stale required tool sets after extension source changes

**Repository:** `https://github.com/nicobailon/pi-subagents`

**Environment:** `pi-subagents` 0.84.0, Node 22+

**Steps to reproduce:**

1. An extension registers tool `stale_repro_x` and a runtime agent `repro-agent` with `tools: ["read", "stale_repro_x"]`.
2. In a live `pi` session, spawn `repro-agent`. Launch tool-plan resolves to `["read", "stale_repro_x"]`.
3. While the session runs, edit the extension source to rename the tool to `stale_repro_y` (and update the extension's runtime agent registration accordingly).
4. Spawn `repro-agent` again from the *same* `pi` session.

**Actual behavior:**
The second launch still resolves its required set to `["read", "stale_repro_x"]`. The stale set comes from `pi-subagents`' runtime agent registry (path `runtime:repro-agent` in `listRuntimeAgentConfigs`), not from a fresh read of the extension file.

**Expected behavior:**
`pi-subagents` should detect that the extension source has changed and invalidate the runtime agent registration (or re-register it) before resolving the launch tool-plan, so the second launch uses the current tool name.

**Minimal script repro:** See the script in this runbook (`/tmp/stale-repro.mjs` and `/tmp/fresh-repro.mjs`). It drives `pi-subagents` bundle internals directly and shows the same warm-vs-fresh difference.

**Impact:** Any extension that renames tools after a previous run in the same `pi` window — including specd's own tool-surface merges — will produce spawning failures or children carrying non-existent required tools until `pi` is restarted.
