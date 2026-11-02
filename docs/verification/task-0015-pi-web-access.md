 ## Verification report: pi-web-access migration (task-0015)

Branch: `specd/test/task-0015-verify-pi-web-access-migr`  
Target: `~/.pi` on this machine  
Date: 2026-11-02 UTC

---

### Executive summary

| Criterion | Status | Notes |
|---|---|---|
| 1. `./dotpi install` mirrors `agent/web-search.json` + updated `settings.json`; Pi restarts | **MANUAL-STEP-REQUIRED** | Config mirrors correctly. Default Pi start/restart is **blocked** by a stale local `~/.pi/agent/extensions/jina` extension left over from the old setup. |
| 2. Pi registers exactly one web tool set (`web_search`, `fetch_content`, `get_search_content`, `source_check`) | **PASS** (after removing stale `jina` in an isolated sandbox) / **MANUAL-STEP-REQUIRED** on default `~/.pi` | Verified in a fresh headless run. Default `~/.pi` still drags in the old `jina` aliases and fails to load `pi-web-access`. |
| 3. Live `web_search` returns source-backed results | **PASS** | Ran 1 live query. Provider reported: `exa` (auto-fallback). Returned official Rust sources. |
| 4. Live `fetch_content` succeeds on a regular docs page | **PASS** | Fetched `https://doc.rust-lang.org/stable/std/index.html`. |
| 5. `/google-account` reports authenticated Google One Brave session | **MANUAL-STEP-REQUIRED** | Brave Browser is running; cookie copy returns `EPERM`. User must quit Brave first, then retry. |
| 6. `researcher` subagent produces a sourced brief | **PASS** | Ran one real prompt; brief produced with web tools and inline citations. |
| 7. Tool parameter-shape gaps recorded | **PASS** | `web_search` uses `query` (string), not `queries` (array). `fetch_content` uses `url` (string). |

---

### 1. Configuration mirroring / `./dotpi install`

**Command run:**

```bash
./dotpi install -y -n
```

**Result:**  
- Installed `agent/settings.json` and `agent/web-search.json` into `~/.pi/agent`.
- `agent/agents/specd-reviewer.md` and `agent/agents/specd-worker.md` updated.
- Backup created: `20261102T090151Z-ac21aa67`.
- `npm` dependencies were rebuilt; `npm:pi-web-access` is present in `~/.pi/agent/npm/node_modules/pi-web-access`.

**Verification:**

```bash
diff agent/settings.json ~/.pi/agent/settings.json   # identical
diff agent/web-search.json ~/.pi/agent/web-search.json # identical
```

`~/.pi/agent/settings.json` contains `"npm:pi-web-access"` and `~/.pi/agent/web-search.json` contains:

```json
{
  "jinaApiKey": "$JINA_API_KEY",
  "allowBrowserCookies": true,
  "browserCookies": { "browser": "brave" }
}
```

**Default Pi restart failure evidence:**

```text
$ pi --help
Error: Failed to load extension ".../pi-web-access/dist/index.js": Tool "web_search" conflicts with /Users/yarabramasta/.pi/agent/extensions/jina/src/index.ts
Error: Failed to load extension ".../pi-web-access/dist/index.js": Tool "source_check" conflicts with ...
Error: Failed to load extension ".../pi-web-access/dist/index.js": Tool "fetch_content" conflicts with ...
Error: Failed to load extension ".../pi-web-access/dist/index.js": Tool "get_search_content" conflicts with ...
Hint: Start without extensions using "pi -ne".
```

**Root cause:** `~/.pi/agent/extensions/jina` still exists from the pre-migration local install. `dotpi install` (safe and clean) intentionally preserves unmanaged old-agent entries, so it does **not** prune orphaned local extensions installed by `pi install`.

**Required manual step before criterion 1 is fully satisfied:**

```bash
pi uninstall jina
# or, if the above leaves the directory:
rm -rf ~/.pi/agent/extensions/jina
```

Also remove the stale `jina` auth block from `~/.pi/agent/auth.json`:

```json
{
  "jina": {
    "type": "api_key",
    "key": "jina_***REDACTED***"
  }
}
```

Manual edit: delete the `jina` top-level key from `~/.pi/agent/auth.json`.  
(Repo `agent/auth.json` is already clean; `dotpi install` skips `auth.json` to avoid destroying credentials.)

---

### 2. Tool registration

Because the stale `jina` extension blocked the default agent, I created an isolated agent copy at `/tmp/pi-verify-root/agent` (copied from `~/.pi/agent`, removed `extensions/jina`, and ran with `PI_CODING_AGENT_DIR=/tmp/pi-verify-root/agent`). No files under `~/.pi` were modified.

**Command run:**

```bash
PI_CODING_AGENT_DIR=/tmp/pi-verify-root/agent \
  pi -p "List every tool name you have registered, one per line." \
     --no-session --name verify-tools
```

**Tool-list output (web-relevant excerpt):**

```text
...
web_search
source_check
fetch_content
get_search_content
...
```

No `jina_search_web`, `jina_search_web_deep`, or `jina_read_url` appeared, and the four `pi-web-access` tool names were present exactly once each.

**Status: PASS** once the stale `jina` extension is removed from the default agent.

---

### 3. Live `web_search`

**Command run (isolated sandbox):**

```bash
PI_CODING_AGENT_DIR=/tmp/pi-verify-root/agent \
  pi -p 'Use web_search to search for "latest stable Rust version" and report the tool call result, including the provider name.' \
     --no-session --name live-web-search --thinking off --mode text
```

**Tool-call result line:**

```text
Tool call result (web_search, query: "latest stable Rust version"):
```

**Output excerpt:**

```text
- **Provider:** exa
- **Top answer:** Latest stable Rust is **1.99.1** ...
- **Source URLs:**
  - https://blog.rust-lang.org/2026/10/15/Rust-1.99.1/
  - https://doc.rust-lang.org/stable/releases.html
  - https://github.com/rust-lang/rust/releases
```

**Status: PASS.** The call returned source-backed results and reported provider `exa` (an allowed auto-fallback provider).

---

### 4. Live `fetch_content`

**Command run (isolated sandbox):**

```bash
PI_CODING_AGENT_DIR=/tmp/pi-verify-root/agent \
  pi -p 'Use fetch_content on https://doc.rust-lang.org/stable/std/index.html and ...' \
     --no-session --name live-fetch-content --thinking off --mode text
```

**Output:**

```text
Succeeded. First 200 characters:

Expand description

## [§](#the-rust-standard-library)The Rust Standard Library

The Rust Standard Library is the foundation of portable Rust software...
```

**Status: PASS.**

---

### 5. `/google-account`

**Command run (isolated sandbox, 20 s timeout):**

```bash
PI_CODING_AGENT_DIR=/tmp/pi-verify-root/agent \
  pi -p '/google-account' --no-session --name google-account --thinking off --mode text
```

**Error:**

```text
Extension error (command:google-account): EPERM: operation not permitted, copyfile '/Users/yarabramasta/Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies' -> '/var/folders/q7/z3z497ks7kx_6l0n_yk72gch0000gn/T/pi-chrome-cookies-WRr1cF/Cookies'
```

**Status: MANUAL-STEP-REQUIRED.** Brave was running and its `Cookies` SQLite file is locked/exclusive.

**Exact manual step for the user:**

1. Make sure you are signed in to the Google account with Google One in Brave.
2. **Fully quit Brave Browser** (including menu bar / background helpers).
3. Start a new interactive Pi session.
4. Send the message `/google-account`.
5. If macOS prompts for Keychain/Password Store access, grant it, then retry.

I did not unlock, bypass, or interact with the Keychain/password store.

---

### 6. `researcher` subagent

**Command run (isolated sandbox):**

```bash
PI_CODING_AGENT_DIR=/tmp/pi-verify-root/agent \
  pi -p '/researcher What is the latest stable Rust version? Produce a brief with sources.' \
     --no-session --name researcher-subagent --thinking off --mode text
```

**Result:** Produced a headed research brief (`# Brief: Latest Stable Rust Version`), summary, findings, and a `Sources:` list using the new web tools including `https://blog.rust-lang.org/...`, `https://doc.rust-lang.org/...`, etc.

**Status: PASS.**

---

### 7. Tool parameter-shape gaps / spec-record notes

Observed from live tool calls:

| Tool | Expected / prompt-used shape | Actual extension shape | Gap |
|---|---|---|---|
| `web_search` | `queries` array (`pi-subagents` researcher prompt says “with multiple `queries`”) | `query` single string (`{"query": "..."}`) | **MISMATCH** |
| `fetch_content` | `urls` (array) or `url` (string) | `url` single string (`{"url": "..."}`) | matches expectations; no gap to fix |
| `get_search_content`, `source_check` | not invoked | assumed similar single-value shapes | unknown |

**Recommendation for spec record:** Update the `researcher` system prompt from `web_search` with multiple `queries` to use a **single `query` string**, or document that Pi handles array-to-string expansion automatically. In this run the model still produced good results despite the mismatch, likely because the LLM passed a single string.

---

### Findings not tied to a single criterion

1. **Orphaned local extension gap:** `dotpi install` safe/clean modes do not remove local extensions in `~/.pi/agent/extensions` that are no longer in the repo `packages/` tree. This should be tracked as a follow-up (pre-existing state-management gap), but **I did not modify dotpi in this task** per supervisor direction.
2. **Stale auth key:** `~/.pi/agent/auth.json` still contains a literal `jina` API key. Manual removal is required.

---

### Commands run

| Command | Purpose | Result |
|---|---|---|
| `./dotpi install -y -n` | Mirror agent JSON into `~/.pi/agent` | Config mirrored; npm rebuilt |
| `pi list` | Confirm `npm:pi-web-access` installed | Installed |
| `git branch --show-current` / `git status` | Confirm branch and no repo changes | `specd/test/task-0015-verify-pi-web-access-migr`, clean |
| Fresh `pi` with isolated `PI_CODING_AGENT_DIR` | Tool-list + live calls + subagent | All passed in sandbox |
| `pi -p '/google-account'` | Verify Google One cookie path | **Blocked** by running Brave |

No repository files were changed.

---

acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "cfg-mirror",
      "status": "satisfied",
      "evidence": "./dotpi install -y -n installed settings.json and web-search.json; diff shows identical to repo copies; npm:pi-web-access present in ~/.pi/agent/npm"
    },
    {
      "id": "tool-registration",
      "status": "satisfied",
      "evidence": "Isolated headless pi run (PI_CODING_AGENT_DIR=/tmp/pi-verify-root/agent) listed web_search, fetch_content, get_search_content, source_check exactly once; no jina_* tools"
    },
    {
      "id": "pi-restart-clean-default",
      "status": "not-satisfied",
      "evidence": "Default ~/.pi pi run fails with web_search/source_check/fetch_content/get_search_content conflicts against ~/.pi/agent/extensions/jina/src/index.ts"
    },
    {
      "id": "live-web-search",
      "status": "satisfied",
      "evidence": "web_search query 'latest stable Rust version' returned source-backed results and reported provider 'exa'"
    },
    {
      "id": "live-fetch-content",
      "status": "satisfied",
      "evidence": "fetch_content on https://doc.rust-lang.org/stable/std/index.html succeeded and returned first 200 characters"
    },
    {
      "id": "google-account",
      "status": "not-satisfied",
      "evidence": "/google-account failed with EPERM copying Brave Cookies DB; Brave is running and locks the SQLite file"
    },
    {
      "id": "researcher-subagent",
      "status": "satisfied",
      "evidence": "researcher subagent produced a full sourced brief using web_search/fetch_content for the Rust-version prompt"
    },
    {
      "id": "param-shape-notes",
      "status": "satisfied",
      "evidence": "Recorded: web_search actual param is 'query' string, whereas researcher prompt says 'queries' array; fetch_content uses 'url' string"
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "./dotpi install -y -n",
      "result": "passed",
      "summary": "mirrored settings.json and web-search.json to ~/.pi/agent; npm dependencies rebuilt"
    },
    {
      "command": "pi list",
      "result": "passed",
      "summary": "npm:pi-web-access is installed"
    },
    {
      "command": "fresh isolated pi tool listing",
      "result": "passed",
      "summary": "exactly four pi-web-access tools registered, no jina_* tools in sandbox"
    },
    {
      "command": "default pi --help / pi -p",
      "result": "failed",
      "summary": "blocked by stale ~/.pi/agent/extensions/jina conflict"
    },
    {
      "command": "live web_search",
      "result": "passed",
      "summary": "returned source-backed results; provider exa"
    },
    {
      "command": "live fetch_content",
      "result": "passed",
      "summary": "succeeded on Rust standard-library docs"
    },
    {
      "command": "/google-account",
      "result": "failed",
      "summary": "EPERM copying Brave Cookies DB; Brave running"
    },
    {
      "command": "researcher subagent /researcher",
      "result": "passed",
      "summary": "produced sourced research brief"
    }
  ],
  "validationOutput": [
    "Settings and web-search.json are identical between repo and ~/.pi/agent",
    "npm:pi-web-access installed under ~/.pi/agent/npm",
    "Offline-style verification sandbox used: copied ~/.pi/agent, removed jina, ran with PI_CODING_AGENT_DIR"
  ],
  "residualRisks": [
    "Stale ~/.pi/agent/extensions/jina still blocks default Pi startup; user must remove it manually",
    "Stale jina API key remains in ~/.pi/agent/auth.json; user must delete the jina block manually",
    "Brave must be fully quit before /google-account can copy the Cookies DB; a macOS Keychain prompt may also appear",
    "web_search parameter is 'query' string while researcher prompt says 'queries' array; may need prompt update"
  ],
  "noStagedFiles": true,
  "diffSummary": "No repository file changes",
  "reviewFindings": [
    "stale ~/.pi/agent/extensions/jina blocks default Pi startup (manual removal required)",
    "stale jina API key block remains in ~/.pi/agent/auth.json (manual removal required)",
    "/google-account requires Brave fully quit (Cookies SQLite lock EPERM); Keychain grant may be needed"
  ],
  "manualNotes": "Verification used a temporary isolated agent directory because the stale jina extension remained in ~/.pi after the 3-minute poll window given by the supervisor. All live criteria were validated in that sandbox. Two manual cleanup steps are required on the actual ~/.pi target: (1) remove ~/.pi/agent/extensions/jina (and any jina auth entry), and (2) quit Brave before running /google-account."
}
---

## Review addendum (parent + specd-reviewer, post-verification)

**Reviewer verdict: PASS** (specd-reviewer, run b7e78b0e) — statuses correctly calibrated, isolation approach sound, manual steps exact and safe.

**Machine state at review time (parent-measured):** `~/.pi/agent/extensions/jina` still present; `~/.pi/agent/auth.json` still contains the `jina` key block; `~/.pi/agent/web-search.json` byte-identical to repo copy; branch had no commits (verification-only task).

**Finding 1 (criterion 2 under-evidence) — closed with demonstrated evidence.** The isolated sandbox was recreated (APFS clone of `~/.pi/agent`, stale `jina` extension removed, `PI_CODING_AGENT_DIR` pointed at the copy) and a fresh headless run listed all registered tools:

- 71 tools registered in total
- `web_search` ×1, `fetch_content` ×1, `get_search_content` ×1, `source_check` ×1 — exactly one each
- zero tool names containing `jina`
- zero duplicate tool names across all 71

**Finding 2 (exa provider provenance) — resolved.** `exa` serving the live `web_search` is not incidental: pi-web-access's documented zero-config default is Exa, and the `auto` fallback chain tries Exa before OpenAI and before Jina/Gemini when keys are absent or a provider fails (per the upstream README, v0.46). Jina remains configured via `jinaApiKey` and will serve when reached in the chain; the criterion ("jina or an auto-fallback provider") is met.

**Finding 3 — fixed** in this committed copy: the structured `reviewFindings` field now lists the real residual items instead of `no blockers`.

**Security note:** the original report echoed a real Jina API key quoted from `~/.pi/agent/auth.json`; it is redacted here as `jina_***REDACTED***`. The key also exists in local session logs/artifacts — rotation recommended. dotpi skips `auth.json` during install by design (protects real credentials), so the stale block must be removed by hand.

**Follow-up candidates (out of scope here):** dotpi install modes do not prune orphaned local extensions left by `pi install` (spec-0009-adjacent installer gap).
