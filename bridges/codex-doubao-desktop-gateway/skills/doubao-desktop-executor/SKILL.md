---
name: doubao-desktop-executor
description: Use when the user explicitly asks Codex to delegate a task to the Windows Doubao desktop app, read a Doubao desktop conversation, or continue and verify a Doubao desktop task. Requires the local doubao-desktop MCP; does not apply to Doubao Web or ordinary Codex work.
---

# Doubao desktop execution

Use the `doubao_desktop_*` MCP tools. First call `doubao_desktop_status`; it must identify the local Doubao desktop endpoint. If unavailable, explain that enabling CDP requires a Doubao restart and can lose draft input. Do not restart the app without authorization for that action.

For a new task, use `doubao_desktop_create_task` with a concrete objective and an existing absolute workspace chosen by the user. Record its conversation and run IDs. Use `doubao_desktop_wait` for progress and `doubao_desktop_read` for the final conversation. Continue the same conversation when requesting corrections; do not resend an uncertain task without checking its original run.

Treat a reported completion as a claim. Inspect actual files, output, and relevant checks before telling the user the work is complete. Default to Doubao's `AskOnRisk` permission setting unless the user specifies another mode. Doubao's own approval behavior is version dependent.

This is an experimental Windows adaptation tested on one Doubao 2.31.4 installation. If the app changes or a tool fails, report the limitation and diagnose; do not silently switch to Doubao Web or an API service.
