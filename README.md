# Agent Team Workbench

Windows 本机多 agent 协作工作台。由 Codex 负责拆解和执行任务，按需调用 DeepSeek Harness 进行方案规划，调用豆包桌面端搜集与整理信息。工作台实时展示运行事件、worker 回复和待确认操作。

## 环境要求

- Windows 10 或更新版本
- Node.js 22 或更新版本
- Git（用于安装固定版本的豆包 CLI）
- Codex 桌面端，以及已配置的本地 MCP servers
- DeepSeek Harness CLI 和可用的 headless profile
- 已登录的豆包桌面端

本项目不包含账号凭据。请在各自客户端中完成登录和配置，不要将凭据文件放入仓库。

## 安装与启动

克隆仓库后，在项目根目录运行：

```powershell
npm ci
npm ci --prefix .\bridges\codex-doubao-desktop-gateway
npm run setup:doubao
```

也可以双击项目根目录的 [启动 Agent Team.cmd](./启动%20Agent%20Team.cmd)。启动器会复用已运行的工作台，或在后台启动本机 API，并打开 [http://127.0.0.1:4174](http://127.0.0.1:4174)。它不会启动、重启或控制 Codex、DSH 或豆包客户端。

也可在终端运行 `npm run start:team`。

首次使用前，请按下文配置两个 Codex MCP servers。DSH 需要为 headless profile 配置可用模型和对应认证。更完整的 bridge 说明见 [DSH connector](./bridges/dsh-ai-bridge/README.md) 和 [豆包 gateway](./bridges/codex-doubao-desktop-gateway/README.md)。

### 日常启动

每次开机后，先启动并登录 Codex 与 DeepSeek Harness。豆包需要通过本机 CDP 端口启动，普通双击豆包图标不会启用这个端口。打开项目根目录下的 PowerShell，填入本机豆包程序路径并运行：

```powershell
$env:DOUBAO_APP = 'C:\Path\To\Doubao.exe' # 改为本机实际路径
$env:DOUBAO_DATA_DIR = "$env:LOCALAPPDATA\Doubao\User Data"
$env:DOUBAO_CLI_ENTRY = (Resolve-Path .\bridges\codex-doubao-desktop-gateway\deps\doubao-cli\bin\doubao.mjs).Path
$env:DOUBAO_CLI_CONFIG_DIR = (Join-Path (Get-Location) 'bridges\codex-doubao-desktop-gateway\data')
node $env:DOUBAO_CLI_ENTRY --app doubao cdp launch --yes --json
```

确认结果包含 `"available": true` 后，再双击“启动 Agent Team.cmd”。如果豆包已经打开但没有 CDP 端口，该命令会重启豆包；先保存未发送的内容。也可以运行 `npm run check` 确认本机连接状态。

运行时在工作台填写一个存在的本机工作区绝对路径和任务目标。新任务默认允许 Codex 修改所选工作区；关闭“允许修改工作区”可改为只读。Codex 的高风险命令、工作区外访问和未识别操作仍需确认。

开发模式：

```powershell
npm run dev
```

Vite 页面位于 [http://127.0.0.1:5173](http://127.0.0.1:5173)，本机 API 监听 `127.0.0.1:4174`。发布构建可运行 `npm run build`，然后用 `npm start` 启动。

## 配置 Codex MCP

在仓库根目录打开 PowerShell，按本机安装路径注册 MCP servers。以下命令将 `deepseek_harness` 和 `doubao_desktop` 写入 Codex 用户配置：

```powershell
$node = (Get-Command node.exe).Source
$dshBin = (Resolve-Path .\node_modules\.bin\dsh.cmd).Path
$dshEntry = (Resolve-Path .\bridges\dsh-ai-bridge\dsh-mcp-connector\server.mjs).Path
codex mcp add deepseek_harness --env "DSH_BIN=$dshBin" -- $node $dshEntry

$env:DOUBAO_APP = 'C:\Path\To\Doubao.exe'
$env:DOUBAO_DATA_DIR = "$env:LOCALAPPDATA\Doubao\User Data"
$env:DOUBAO_CLI_ENTRY = (Resolve-Path .\bridges\codex-doubao-desktop-gateway\deps\doubao-cli\bin\doubao.mjs).Path
$env:DOUBAO_CLI_CONFIG_DIR = (Join-Path (Get-Location) 'bridges\codex-doubao-desktop-gateway\data')
$gatewayEntry = (Resolve-Path .\bridges\codex-doubao-desktop-gateway\src\server.mjs).Path
codex mcp add doubao_desktop `
  --env "DOUBAO_APP=$env:DOUBAO_APP" `
  --env "DOUBAO_DATA_DIR=$env:DOUBAO_DATA_DIR" `
  --env "DOUBAO_CLI_ENTRY=$env:DOUBAO_CLI_ENTRY" `
  --env "DOUBAO_CLI_CONFIG_DIR=$env:DOUBAO_CLI_CONFIG_DIR" `
  -- $node $gatewayEntry
```

将 `DOUBAO_APP` 改为本机豆包程序路径。保存配置后，在 Codex 中重载 MCP servers。启用豆包 CDP 后运行 `npm run check` 检查本机依赖和连接状态；检查不会发送模型请求。

## 豆包 CDP

`npm run setup:doubao` 安装 gateway 及其固定版本的 `doubao-cli` 依赖，不会重启豆包。豆包正在运行时，先保存工作，再按需设置应用路径并启用 CDP：

```powershell
$env:DOUBAO_APP = 'C:\Path\To\Doubao.exe'
$env:DOUBAO_DATA_DIR = "$env:LOCALAPPDATA\Doubao\User Data"
$env:DOUBAO_CLI_ENTRY = (Resolve-Path .\bridges\codex-doubao-desktop-gateway\deps\doubao-cli\bin\doubao.mjs).Path
$env:DOUBAO_CLI_CONFIG_DIR = (Join-Path (Get-Location) 'bridges\codex-doubao-desktop-gateway\data')
node $env:DOUBAO_CLI_ENTRY --app doubao cdp launch --yes --json
```

启用 CDP 会重启豆包。CDP 仅应监听 `127.0.0.1`；不要将调试端口暴露到局域网或公网。Codex MCP 配置通常位于 `%USERPROFILE%\.codex\config.toml`；更新配置后需要在 Codex 中重载 MCP servers。

## 架构

- `deepseek_harness`：通过 `dsh-ai-bridge` 的 stdio MCP connector 调用 DSH headless profile。
- `doubao_desktop`：通过 Codex Doubao Desktop Gateway 和本机 CDP 控制已登录的豆包桌面端。
- `AGENTS.md`：Codex 协调、委派和任务验收规则。
- `team/task-contract.schema.json` 与 `team/tasks/TEMPLATE.md`：任务输入、权限范围、状态和产物格式。
- `bridges/`：纳入仓库的 bridge 源码，保留各自的上游许可证和第三方声明。

Codex app-server 是协调入口，MCP bridge 将请求转发给 worker。DSH 的原生 Agent Teams 只管理 DSH 自己的进程，不能直接把 Codex 与豆包放入同一 roster，因此本工作台在外层呈现三个运行时。调度由 Codex 的任务回合决定，不会自动开启多个 DSH 窗口。

bridge 源码来自 [dsh-ai-bridge](https://github.com/ganmayou2333/dsh-ai-bridge) 与 [codex-doubao-desktop-gateway](https://github.com/chassychan/codex-doubao-desktop-gateway)。豆包 gateway 包含与本工作台配套的 create-and-wait 调用扩展。各 bridge 目录保留其上游 `LICENSE`；gateway 还附带 `THIRD_PARTY_NOTICES.md`。项目内 Codex、DeepSeek 与豆包名称和标志归其各自权利人所有，不包含在本项目许可授权范围内。

## 能力与边界

- 工作台逐项显示 Codex 事件以及 DSH、豆包的 MCP 调用和回复；运行状态由 app-server 事件更新。
- 豆包普通新任务和补充任务会在一次 MCP 调用中提交并等待回复。超时但仍在运行会显示为“仍在执行”，不代表失败。
- DSH 和豆包必须已在各自客户端登录并配置好。连接检查不能证明模型授权有效。
- Codex 完成一轮后，在同一任务中发送补充内容会沿用原 Codex 会话。Agent Team 服务重启后，继续历史任务会把已保存的用户与 Codex 主对话带入新会话；上次仍在运行的回合会标记为中断，不会恢复原来的运行进程。重新选择任务会加载该任务的工作区与写入权限。
- 团队回复是协作记录，不代表建议或产物已经独立验收；涉及代码时仍应检查实际文件、diff 和验证结果。

运行记录保存在 `data/runs.json`；本地运行数据、依赖和任务记录由 `.gitignore` 排除。

## 安全边界

- MCP servers 使用本机 stdio；本机 API 和豆包 CDP 应只绑定 loopback 地址。
- DSH 与豆包 worker 可访问授予它们的工作区；敏感项目应使用单独 worktree 和最小权限。
- 豆包 CDP 可访问当前登录会话。停止使用后，应正常退出并重新启动豆包以关闭调试端口。
- DSH 官方仍标注为 developer preview。运行插件或命令前应检查权限与产物。
- 本项目不保存模型密钥、豆包会话数据或 DSH 凭据。
