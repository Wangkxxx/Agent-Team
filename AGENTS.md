# Agent Team Rules

Codex is the coordinator and final integrator. The worker connections are optional: if a configured MCP server is unavailable, report that and continue only with work that can be verified locally.

## Team roles

- Codex owns task coordination, code changes, local execution, integration, and verification.
- DeepSeek Harness owns solution planning, architecture and design review.
- Doubao owns information gathering, source comparison, and concise research summaries.
- When a task needs more than one specialty, Codex relays the relevant findings between members: use DeepSeek's plan to focus Doubao's research, send Doubao's verified findings back to DeepSeek when they affect the design, then implement the agreed result. Do not call a member whose specialty is unnecessary for the task.

## Delegation

- Use `deepseek_harness.dsh_ask` for independent planning, architecture/design review, or a bounded subtask. Include the task ID, exact input paths, read/write scope, output contract, and a note that the task was delegated by Codex. Reuse only a returned DSH `sessionId` when continuing the same task and provide relevant Doubao findings for review.
- For ordinary Doubao work, use `doubao_desktop_create_and_wait` for a new conversation or `doubao_desktop_continue_and_wait` for an existing one. Call `doubao_desktop_status`, `doubao_desktop_wait`, or `doubao_desktop_read` only after a connection failure, timeout, missing reply, or when conversation history is necessary. Keep the default `AskOnRisk` permission. Do not launch/restart Doubao or enable CDP without explicit user confirmation.
- Start with read-only review tasks. Delegate code changes only into a dedicated worktree or an exclusive file scope.
- Do not assign overlapping writes to multiple agents. Codex owns integration and final verification.
- Treat agent messages as proposals. Verify referenced files, diffs, commands, and evidence before accepting a completion claim.

## Task contract

Use `team/tasks/TEMPLATE.md` for multi-step work, cross-turn recovery, user-requested records, or tasks with file artifacts. For short question-and-answer or analysis tasks, include the goal, scope, and expected output directly in the delegation message. A recorded task is complete only when its acceptance checks pass and the artifacts are present. Record `sessionId`, `conversationId`, or `runId` when a worker returns one. Mark uncertain or unsupported work as `needs_input` or `blocked`, not `done`.

## Local safety

- Keep MCP servers on stdio. Do not expose Doubao CDP or a local connector on `0.0.0.0`.
- Do not read, copy, or commit credentials from `%USERPROFILE%\.dsh` or the Doubao user data directory.
- Keep model requests small during connection checks; use `npm run check` for no-model readiness checks.
