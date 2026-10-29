# Reproduce a stale required-tool set in a Pi subagent spawn

Audience: a Pi user debugging a subagent launch that fails because its `tools` allowlist names tools that no longer exist.

## Manual procedure

The goal is to force a subagent definition and its extension tool set out of sync, then show that the stale set is read from the discovered agent definition file on every spawn.

1. **Create a stub ambient extension that registers one tool `x_stub_ping`.**
   Save it under a path such as `~/.pi/agent/extensions/x-stub/index.ts` and make sure Pi loads it.

2. **Create an agent definition whose `tools` allowlist names that tool.** For example, `~/.agents/x-stub-tester.md`:

   ```yaml
   ---
   description: Tester for stale tool-name bug
   tools: x_stub_ping
   subagentOnlyExtensions: /Users/<you>/.pi/agent/extensions/x-stub/index.ts
   ---
   ```

3. **Spawn it as a background child** and confirm success. Open the agent capability list to see the row that resolves for the agent and note its source directory.

4. **Rename or remove `x_stub_ping` in the stub extension.** Do not edit the agent definition.

5. **Re-spawn the agent twice:**
   - In the same host session, without reloading extensions.
   - After a full host restart / extension reload.

6. **Inspect the following:**
   - Which agent definition row the capability list resolves to.
   - The contents of both user agent directories: `~/.agents/` and `~/.pi/agent/agents/`.
   - Whether the launch fails with the strict-allowlist diagnostic.

What you are looking for: the child receives the `tools` list from the winning definition file discovered at spawn time. If that file still lists a name the extension no longer registers, the validator rejects the launch.

## Observed outcome — 2026-10-29

Pre-state on the host:

- `~/.agents/specd-worker.md` existed with a frontmatter `tools:` block naming 19 `specd_*` tools — 10 already-removed pre-merge names (`specd_dashboard`, `specd_show`, `specd_query`, `specd_store_status`, `specd_register_store`, `specd_add_reference`, `specd_create_worktree`, `specd_import_preview`, `specd_import_apply`, `specd_import_revert`) plus 9 post-merge names.
- The repo version at `agent/agents/specd-worker.md` and its installed mirror at `~/.pi/agent/agents/specd-worker.md` were a newer definition with no `tools` allowlist.
- `PI_CODING_AGENT_DIR` was unset.

Probes:

- **Probe A — capability list, no changes.** The live `specd-worker` row resolved to the `~/.agents` definition, including its integration-testing description and the 19-name allowlist. It did *not* use the repo/installed definition.

- **Probe B — spawn attempt, foreground, pre-mitigation.** The run failed with mission id `7f6c3cbb-d16d-4214-9973-679c74b79b6e` and this verbatim error:

  ```
  Agent 'specd-worker' ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: specd_dashboard, specd_show, specd_query, specd_store_status, specd_register_store, specd_add_reference, specd_create_worktree, specd_import_preview, specd_import_apply, specd_import_revert.
  ```

  This is the same signature seen in the 2026-10-29 lingua-lair-core session: a finished-and-committed worker was still marked failed because its launch carried a stale required-tool set.

- **Mitigation applied.** `~/.agents/specd-worker.md` was replaced with the task-0006 pinned contract: `tools: read, edit, write, bash, grep, find, ls`, and `timeoutMs: 5400000`. Source: branch `specd/fix/task-0006-pin-specd-agent-contracts`, commit `e3e293d`.

- **Probe C — capability list re-check, same session, no reload.** The live row immediately resolved to the new definition: builtin-only tools, no stale names.

- **Probe D — re-spawn, 2026-10-29.** The background launch running this task succeeded under the new contract: builtin tools only, 90-minute deadline.

## Where the stale set is read from

The discovery logic is in `~/.pi/agent/npm/node_modules/pi-subagents/src/agents/agents.js`:

- Scan order for user agent directories (line 2419):

  ```js
  const userLoaded = [...extraUserAgentDirs(), ...userScanDirs.dirs, userDirOld, userDirNew].filter(...)
  ```

- The selected user directory (line 2450):

  ```js
  const userDir = process.env.PI_CODING_AGENT_DIR ? userDirOld : fs.existsSync(userDirNew) ? userDirNew : userDirOld;
  ```

When `PI_CODING_AGENT_DIR` is unset and `~/.agents` exists, `~/.agents` wins. Every spawn reads the `tools` allowlist from that winning definition file at launch time.

The launch failure is emitted by strict allowlist validation. The diagnostic text lives in `~/.pi/agent/npm/node_modules/pi-subagents/src/runs/shared/tool-availability.js`:

```js
`${subject} ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: ${diagnostic.missing.join(", ")}.`
```

## Conclusion

Pinned cause:

- A stale `~/.agents` shadow definition takes precedence over both the repo definition (`agent/agents/specd-worker.md`) and the installed mirror (`~/.pi/agent/agents/specd-worker.md`).
- The subagent loader applies the `tools` allowlist from that shadow file per-spawn.
- Strict allowlist validation then hard-fails the launch when the named tools no longer exist.

Local mitigation:

- Keep the winning definition under `~/.agents` current with the source-of-truth contract.
- Until `~/.agents` is removed or the precedence rule changes, `dotpi` sync installing agent files into `~/.pi/agent/agents` is ineffective for agent definitions on this machine.
- Clean up e2e/legacy leftovers that write to `~/.agents`.

Durable fixes:

- Merge the task-0006 agent-contracts guard (`packages/specd/test/agent-contracts.test.ts`).
- Extend that guard to scan both user directories (`~/.agents` and `~/.pi/agent/agents`), because the current test only checks `agent/agents/*.md` and cannot see a `~/.agents` shadow definition.
- Reconcile `~/.agents` and `~/.pi/agent/agents` during dotpi sync.

## Upstream issue draft — nicobailon/pi-subagents

Title: `~/.agents` shadow definition takes precedence over `~/.pi/agent/agents`, causing stale `tools` allowlist failures

Body:

```
Environment:
- Pi desktop host, `PI_CODING_AGENT_DIR` unset.
- Repo has `agent/agents/specd-worker.md` with no `tools` allowlist.
- Legacy file exists at `~/.agents/specd-worker.md` with a `tools:` list naming removed extension tools.

Steps to reproduce:
1. Ensure `~/.agents/specd-worker.md` exists with a `tools:` allowlist naming `specd_dashboard`, `specd_show`, ..., `specd_import_revert`.
2. Ensure `~/.pi/agent/agents/specd-worker.md` exists with a different/no allowlist.
3. Run the agent capability list and observe that the resolved row comes from `~/.agents`.
4. Spawn `specd-worker`.

Expected behavior:
The launcher uses the current definition (e.g. `~/.pi/agent/agents/specd-worker.md` or the repo definition) and the spawn succeeds because the allowlist matches available tools.

Actual behavior:
The launcher uses the stale `~/.agents` definition. The spawn fails with:

Agent 'specd-worker' ran as a foreground child, which never loads the parent's ambient extensions, and these child tools were unavailable: specd_dashboard, specd_show, specd_query, specd_store_status, specd_register_store, specd_add_reference, specd_create_worktree, specd_import_preview, specd_import_apply, specd_import_revert.

Root cause:
`src/agents/agents.js` line 2450 chooses `~/.agents` over `~/.pi/agent/agents` when `~/.agents` exists and `PI_CODING_AGENT_DIR` is unset. The stale `tools` list is then applied strictly on every spawn.

Suggested fix:
Either (a) prefer the installed/user agent directory over the legacy `~/.agents` path, or (b) merge/validate all discovered user definitions so a stale shadow file cannot override the current contract.
```
