# Codex Doubao Desktop Gateway

Experimental MCP server and Codex Skill for the **Windows Doubao desktop app**. Created by **ChassyChan**. It connects to a real local Doubao session through localhost Chrome DevTools Protocol (CDP), sends tasks, waits for runs, and reads replies. It does not use Doubao Web or an Ark API key.

This project wraps a [Windows adaptation](patches/doubao-cli-windows.patch) of [Fullstop000/doubao-cli](https://github.com/Fullstop000/doubao-cli). The upstream CLI and its copyright remain with Fullstop000; see [third party notices](THIRD_PARTY_NOTICES.md). The adaptation has been tested on one Windows machine with Doubao 2.31.4. It is not an official Doubao or ByteDance integration.

## Requirements

- Windows 10/11, Doubao desktop app installed and signed in.
- Node.js 22 or newer, Git, and Codex CLI for registration.
- The ability to restart Doubao once with `--remote-debugging-port=9225`. Restart can lose unsaved draft input.

## Install

```powershell
git clone https://github.com/ChassyChan/codex-doubao-desktop-gateway.git
cd codex-doubao-desktop-gateway
npm ci
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

Find your Doubao executable and User Data directory. For a typical installation, User Data is under `%LOCALAPPDATA%\Doubao\User Data`. Set these variables for the current PowerShell session:

```powershell
$env:DOUBAO_APP = 'C:\Path\To\Doubao.exe'  # replace with your location
$env:DOUBAO_DATA_DIR = "$env:LOCALAPPDATA\Doubao\User Data"
$env:DOUBAO_CLI_ENTRY = (Resolve-Path .\deps\doubao-cli\bin\doubao.mjs).Path
$env:DOUBAO_CLI_CONFIG_DIR = (Join-Path (Get-Location) 'data')
```

When you are ready to restart Doubao, enable localhost CDP:

```powershell
node .\deps\doubao-cli\bin\doubao.mjs --app doubao cdp launch --yes --json
```

The `--yes` flag authorizes restarting Doubao. The Windows adaptation first tries to close normally and may force close remaining processes. Run it only after saving work in the app.

Register the MCP server with Codex (replace paths with your absolute installation paths):

```powershell
codex mcp add doubao-desktop `
  --env "DOUBAO_APP=$env:DOUBAO_APP" `
  --env "DOUBAO_DATA_DIR=$env:DOUBAO_DATA_DIR" `
  --env "DOUBAO_CLI_ENTRY=$env:DOUBAO_CLI_ENTRY" `
  --env "DOUBAO_CLI_CONFIG_DIR=$env:DOUBAO_CLI_CONFIG_DIR" `
  -- node.exe (Resolve-Path .\src\server.mjs).Path
```

Install the [Skill](skills/doubao-desktop-executor/SKILL.md) into your Codex skills directory, then start a new Codex turn so it becomes available. The MCP server never restarts Doubao itself. After any later app restart, CDP may need to be enabled again.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `doubao_desktop_status` | Check localhost desktop connection |
| `doubao_desktop_sessions` | List existing desktop conversations |
| `doubao_desktop_create_task` | Send a new task in an existing local workspace |
| `doubao_desktop_continue_task` | Send a follow-up to a specified conversation |
| `doubao_desktop_wait` | Wait for a known run ID |
| `doubao_desktop_read` | Read messages from a specified conversation |

`create_task` and `continue_task` default to Doubao's `AskOnRisk` permission mode. The caller may select `AlwaysAsk` or `FullAccess`. This policy is enforced by Doubao, not by the MCP server; it does not guarantee a prompt for every action. New tasks require an existing absolute workspace path. A successful Doubao reply is not proof that files or commands are correct, so inspect artifacts separately.

## Limits

- The Windows adaptation depends on private desktop behavior exposed by the upstream CLI. App updates can break it.
- The MCP server is local stdio only and exposes no network listener. CDP is expected on `127.0.0.1:9225`; do not expose that port to the network.
- This release has a live smoke test for connection, message send/read, and local file creation on Doubao 2.31.4. Model selection, attachments, MCP connectors inside Doubao, long running tasks, and other Doubao versions are not yet validated here.
