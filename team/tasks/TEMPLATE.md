# Task Contract Template

Create one `<taskId>.json` file in this directory. Keep its fields aligned with
`../task-contract.schema.json`.

```json
{
  "schemaVersion": 2,
  "taskId": "TASK-EXAMPLE-01",
  "goal": "One observable outcome.",
  "inputs": [],
  "owner": "codex",
  "writeScope": {
    "mode": "read-only",
    "paths": []
  },
  "outputContract": [
    "Summary",
    "Evidence",
    "Assumptions",
    "Risks or unresolved questions",
    "Artifacts"
  ],
  "acceptanceChecks": [
    "A specific check with observable evidence."
  ],
  "status": "draft",
  "dependencies": [],
  "attempt": 0,
  "attemptId": null,
  "createdAt": "2026-01-01T00:00:00Z",
  "sessionId": null,
  "conversationId": null,
  "runId": null,
  "artifacts": [],
  "evidence": [],
  "failureReason": null
}
```

Use `read-only` unless the worker needs to edit files. For edits, assign an
`exclusive-write` scope and keep it disjoint from other workers. Change the
status to `review` when the worker returns; Codex marks it `done` only after
checking the acceptance evidence.

For a dependent subtask, list completed task IDs in `dependencies`. A new
attempt receives a fresh `attemptId`; an update for a stale attempt must be
rejected rather than changing the current task state.
