# pi-jina-web

Jina-backed web tools for Pi: search, reader, and a naive textual claim check.

In addition to the promoted tools, this extension registers unpromoted
convention-name aliases — `web_search`, `fetch_content`, `get_search_content`,
and `source_check` — backed by the same Jina endpoints. These aliases are
callable by built-in pi-subagents such as `researcher` and `evidence-auditor`
whose definitions strict-allowlist those convention names, without needing
per-agent overrides. They are intentionally hidden from the default
system-prompt tool prose; this setup assumes `pi-web-access` is not installed.
If `pi-web-access` were ever added, Pi's silent first-registration-wins
behavior means load order would decide which provider each name resolves to.
The aliases deliberately do not implement deep search, LLM-backed source
verification, or collision handling.

Auth: `JINA_API_KEY` environment variable first, then the configured
`auth.json` value.
