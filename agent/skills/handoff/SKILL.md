---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save it to the OS temporary directory (e.g. via `mktemp "${TMPDIR:-/tmp}/handoff-XXXXXX.md"`), never into the current workspace.

After writing, print the full path of the document to the user. Temp directories are ephemeral; if the next session is not starting within the hour or under a different harness, tell the user to copy the file somewhere durable.

Include a "suggested skills" section in the document, naming which skills the next agent should load (by `/skill:name` or the path to its SKILL.md).

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
