# dsh-ai-bridge

Two zero-dependency tools that connect an external AI client to a local
**DeepSeek Harness (DSH)** — and one that drives the **Doubao desktop app**
from the outside. Nothing in the DSH installation is modified.

[中文说明](README.md)

```
External AI client ──MCP──▶ dsh-mcp-connector ──▶ dsh --profile headless ──▶ DSH
   (Claude Code / Cursor / VS Code / Codex / Kimi Code / CodeBuddy / Qoder /
    TRAE / ZCode / Step Code / MiniMax Code / Coze, …)

DSH / scripts / HTTP ──enqueue──▶ tasks.jsonl ──task_claim──▶ any MCP client
                                 (pull-based task queue)

scripts / DSH ──CDP──▶ doubao-cdp ──▶ Doubao desktop (dispatch into its chat box)
```

## Why this exists

A DSH installation ships an MCP **client** (`dsh-mcp-client`) but no MCP
**server** half, and its Web API is fenced by a browser cookie plus Host/Origin
checks that a third-party process cannot hold. So letting another AI send
messages *into* DSH requires a separate bridge — that is the first tool.

The reverse direction (handing work to another vendor's AI) has **no official
inbound API at all**, so it can only be GUI automation — that is the second tool.

And because MCP tools only run inside the client's own turn, work cannot be
pushed to a client; the only shape that scales is **pull**: a producer enqueues,
the client claims. That is built into the first tool.

## Layout

| Path | What it is |
|---|---|
| [`dsh-mcp-connector/`](dsh-mcp-connector/) | MCP server (stdio + Streamable HTTP) exposing `dsh_ask`, `dsh_cli_info`, `connector_status` and four task-queue tools, driving `dsh --profile headless` |
| [`doubao-cdp/`](doubao-cdp/) | Chrome DevTools Protocol driver for the Doubao desktop app: `cdp.mjs` sends and reads back, `dispatch.mjs` dispatches with **side-effect verification** |
| [`doubao-status-panel/`](doubao-status-panel/) (**Doubao Controller**, bundle id still `@local/doubao-status-panel`) | A DSH Web sidebar control panel: live tasks (`received → started → progress → done`), Doubao's **current mode and model** (with the menu's `0921 新版` / `即将下线` annotation), and the **5h and 7d quota windows** (one 5px bar each; amber at 80%, red at 95%), with a **"switch to work" button** when not in work mode. Its host half is a read-only `GET /doubao-status/api` plus a loopback-only `POST /doubao-status/api/mode`, on DSH's own web port — no extra listener. Quota (three clicks into the app's own quota page, degrading to the account menu) and the model list are **samples** sharing one serial queue with the mode switch, and the sampling interval is a setting |
| [`skills/dsh-mcp-connector/`](skills/dsh-mcp-connector/) | Agent skill: config matrix for 17 MCP clients, a traps table, and an explicit list of unverified claims |
| [`docs/design-notes.md`](docs/design-notes.md) | Design notes (Chinese): why a bridge is unavoidable, DSH's five machine entry points, why the queue pulls, the two compliance directions, known failure modes |
| [`scripts/register.mjs`](scripts/register.mjs) | Registration helper: writes the connector into an MCP client's config instead of hand-copying JSON/TOML |

## Quick start

```bash
git clone https://github.com/ganmayou2333/dsh-ai-bridge
cd dsh-ai-bridge

npm test                       # both hermetic suites: no DSH, no Doubao needed

cd dsh-mcp-connector
node selftest.mjs              # the full selftest, including two checks that need a local DSH

# then add a stdio server in your MCP client:
#   command: node
#   args:    <path>/dsh-ai-bridge/dsh-mcp-connector/server.mjs
#   env:     DSH_BIN=<dsh executable>   DSH_WORKSPACE=<DSH session working directory>
# Per-client paths and snippets: dsh-mcp-connector/README.md
```

### Register without hand-editing configs

```bash
node scripts/register.mjs --list                       # where each client's config lives, and whether dsh is in it
node scripts/register.mjs --client cursor --dry-run    # print what would be written, touch nothing
node scripts/register.mjs --client vscode              # write it (an existing file is backed up to .bak)
node scripts/register.mjs --client all --dry-run       # inspect every supported client at once
```

Each client's quirk is encoded: ZCode's `mcp.servers`, Step Code's TOML, the explicit `type: stdio` CodeBuddy and MiniMax need, and VS Code's `servers` key. `claude-code` is CLI-managed, so the script writes nothing and prints the `claude mcp add` command instead.

Prefer `--dry-run` first. Tests redirect everything with `--root`/`--project`, so your real configuration is never touched by the suite.

Requirements: Node ≥ 20, and a working DSH installation (`dsh` on PATH).

## Verification status

| Item | Evidence |
|---|---|
| `dsh-mcp-connector` selftest | **61 assertions pass, exit 0** — hermetic headless-profile bootstrap, stdio round trip, HTTP transport auth (401/403/404/405/202) and producer route (201), queue semantics, 6-way concurrent claims without collision, self-observation and the pipelined-handshake gate |
| Offline selftest (CI) | 58 pass / 2 skipped, exit 0 — skips the two checks that need a local `dsh` |
| Real model call | one message answered in 3.7 s, returning a `sessionId`; a second message with that id continued the same session |
| Real MCP client handshake | Claude Code 2.1.226 completed the handshake and negotiated protocol `2025-11-25`; the evidence is the connector's own `clients.json`, not the client's prose (that client was not logged in, so no tool call ran) |
| `doubao-cdp` round trips | three consecutive dispatch/reply pairs |
| `dispatch.mjs` verification | both paths measured: success (queue completed → exit 0 `VERIFIED`) and failure (client claimed success while the queue still held the task → exit 2 `UNVERIFIED`); the hermetic test passes **35 assertions** (instruction content, the status contract, live status output, a completion with no started event, the pre-flight check, `--no-send` writing no `received`, and `--no-preflight` on the post-send `wait`/`read`) with neither Doubao nor CDP present |
| Doubao startup confirmation | **42 assertions pass**: closed port / open port without the chat page / ready / the `--no-preflight` escape hatch, plus "a failed confirmation must not leave an orphan task", the model-control text split (`豆包 2.1 Lite低` — the trailing level is not part of the model name), `state` being a readout rather than a gate, `mode` rejecting a bad target before it ever touches CDP, **`quota`/`models` failing loudly (exit 1, `ok:false`) while Doubao is closed instead of inventing a number or a list**, and **parsing the quota page text** (two windows from the captured real text, `已用 <1%` read as 0 with `approximate` rather than 1%, reset times and counts, and zero windows for text that is not the quota page). Driven hermetically against a fake CDP endpoint, so no Doubao is needed |
| Status reporting | **34 assertions pass**: fixed vocabulary and aliases, ini switches, a disabled state is a silent no-op, throttling (critical states are never dropped), truncation, terminal states are final, torn final line, timeline ordering, busy/stuck detection; plus `received` (the dispatcher-side delivery fact) being written, folded, overridden by `started`, and counted as busy before any start |
| Pre-call identification | **23 assertions pass**: connectivity / mode / command capability / busy-idle / channel, with three distinct verdicts (`0` send, `3` not ready, `8` cannot identify); a wrong mode or a busy app refuses, `--force` proceeds and records an override |
| Status push (P2) | **16 assertions pass**: only phase transitions are pushed (`progress` stays in the file), cursor idempotency, new events get pushed, a missing session fails loudly, `--create-session` creates exactly one session |
| Doubao Controller (DSH Web sidebar) | **118 assertions pass**: `received` folding, read-only API (`POST`/`PUT`/`DELETE`/`PATCH` → 405 **without touching the reader**), a loopback source fence, a single relative route, no listener in the host half, manifest and module-loader shape, `DSH_HOME` fallback, the runtime snapshot with its 15-second cache, the **mode-switch endpoint**, the **quota/model samples** (parsing, clamping, `ok:false` instead of inventing a number, name deduplication, **multi-window payloads**, degraded flags, `<1%` read as 0 rather than 1), the **menu mutex**, the **sampling settings**, and **render assertions that run `client.js` against a fake React** (no task = one bar, progress 55% = two bars and three lines, a started task with no percentage = no task bar, done = full, quota ≥95% = error colour, **two quota windows = two rows with two 5px bars, three bars while a task runs**). Live checks covered the loopback API, mode switching, work-mode task state flow, quota/model sampling, fallback paths, and rendering. Public examples and fixtures use synthetic quota values; account quota values and reset timestamps are omitted. The quota reader validates each step and retries the full sequence; offline tests cover failure and recovery paths |
| Single entry point | `npm test` at the repository root runs seven suites (connector offline, dispatcher, startup confirmation, status, status push, status panel, registration helper), exit 0 |

The selftest spends nothing by default; `DSH_MCP_CONNECTOR_LIVE=1 node selftest.mjs`
adds one real billed call.

## Security notes

- The connector's **stdio** mode trusts the spawning client process; its
  **HTTP** mode requires a bearer token, binds `127.0.0.1` by default and
  answers 403 to any `Origin` that is not explicitly allowed. Put TLS in front
  before exposing it, and replace the sample token.
- Messages delivered into DSH arrive with `{kind:"user"}` and are
  **indistinguishable from the human's own input** — make the downstream label
  the origin in the task text.
- **Never trust an AI client's "I already called the tool."** Measured: with the
  connector not enabled in the conversation, Doubao replied "called task_claim,
  status ok" while the queued task was still `pending`. Verify side effects —
  queue events, files, logs. `doubao-cdp/dispatch.mjs` is built on that rule.
- `doubao-cdp` needs Doubao started with `--remote-debugging-port`, which means
  **any local process can drive your Doubao** (read chats, send messages as
  you). Close it when you are done.
- Both tools only **deliver messages**. Do not point them at a subscription
  account to power a third-party model backend; that violates the vendors'
  consumer terms.

## License

MIT — see [LICENSE](LICENSE).
