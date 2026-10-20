# Agent Team Workbench

Windows 本机多 agent 协作工作台。用户在一个窗口提交目标，由 Codex 负责协调和实际执行，按任务需要调用 DeepSeek Harness 与豆包桌面端。工作台展示计划、成员状态、交互请求、执行记录和任务产物。

## 功能

- **按专长协作**：Codex 负责拆解、代码修改和验收；DeepSeek Harness 负责方案规划与设计复核；豆包负责信息搜集与整理。简单任务可由 Codex 独立完成，不要求每个任务都调用所有成员。
- **复杂任务先确认计划**：工作台可以先展示目标、启用成员和工作区写入模式。用户可以批准执行、要求修改计划或放弃；计划获批前不会启动 agent。
- **任务与进度可追踪**：成员回复、工具调用和状态变化进入时间线；任务结构区显示根任务和已派发子任务的负责人、依赖、状态、尝试次数、验收条件和证据摘要。
- **执行期间可以沟通**：用户可以在运行中追加指引，让 Codex 在当前回合中调整执行方向。成员邮箱支持留存给 Codex、DeepSeek 或豆包的留言，由 Codex 在后续协调时决定是否转达。
- **交互式提问**：需要用户决定时，Codex 可提交选项、文本、数字、布尔值或多选问题，并提供补充说明输入框。回答会回到等待中的会话。
- **操作确认有边界**：所选工作区内符合规则的常规操作可自动继续；高风险命令、工作区外访问和未识别操作仍请求用户确认。Codex、DeepSeek 和豆包是否可修改所选工作区由任务写入开关决定。
- **停止与恢复**：停止会中断 Codex，并向本轮正在运行的 DeepSeek 与豆包任务发送停止信号；已经完成的文件修改不会撤销。停止后的任务可填写原因再恢复，明确停止的 worker 不会被悄悄重新启动。
- **长对话和长任务**：DeepSeek connector 提供短时等待、继续等待和取消工具，避免单次 MCP 超时被误认为任务失败；豆包未确认完成时沿用原 `conversationId`/`runId` 继续等待，不重复发送任务。工作台重启后可继续已保存的 Codex 对话上下文。
- **本地记录管理**：任务标题可修改；Markdown/GFM 消息可直接阅读；可查看事件审计和成员留言。删除工作台对话会永久删除其本地运行、审计和邮箱记录，不删除工作区内的代码文件，也不删除各 agent 客户端保存的原始会话。

## 快速开始

需要 Windows 10 或更新版本、Node.js 22 或更新版本、Git、Codex 桌面端、DeepSeek Harness CLI，以及已登录的豆包桌面端。DSH 和豆包 MCP server 必须先在 Codex 中配置。

克隆后在项目根目录运行：

```powershell
npm ci
npm ci --prefix .\bridges\codex-doubao-desktop-gateway
npm run setup:doubao
```

桥接项目的源码和各自许可证已直接纳入仓库，不需要 `git submodule update`。`setup:doubao` 只安装固定版本的豆包 CLI 依赖，不会启动或重启豆包。

启用豆包 CDP 前，先保存豆包中的未发送内容。下面将重启豆包并在本机启用调试端口；将路径替换为本机实际安装路径：

```powershell
$env:DOUBAO_APP = 'C:\Path\To\Doubao.exe'
$env:DOUBAO_DATA_DIR = "$env:LOCALAPPDATA\Doubao\User Data"
$env:DOUBAO_CLI_ENTRY = (Resolve-Path .\bridges\codex-doubao-desktop-gateway\deps\doubao-cli\bin\doubao.mjs).Path
$env:DOUBAO_CLI_CONFIG_DIR = (Join-Path (Get-Location) 'bridges\codex-doubao-desktop-gateway\data')
node $env:DOUBAO_CLI_ENTRY --app doubao cdp launch --yes --json
```

确认输出包含 `"available": true` 后，配置 Codex MCP servers。以下命令会修改当前 Windows 用户的 Codex MCP 配置：

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

在 Codex 中重载 MCP servers。DSH 的 headless profile 需要配置可用模型和对应认证；本项目不会读取或复制 DSH、豆包或 Codex 的凭据。

## 启动和使用

每次开机后，先手动启动并登录三个 agent。豆包需已经通过上节命令启用本机 CDP。然后双击 [启动 Agent Team.cmd](./启动%20Agent%20Team.cmd)，或在 PowerShell 运行：

```powershell
npm run start:team
```

启动器会复用已有工作台，或在后台启动 API 并打开 <http://127.0.0.1:4174>；不会启动、重启或控制 agent 客户端。新建任务时，输入一个存在的工作区绝对路径和任务目标。工作区路径初始为空，避免使用开发者电脑的本地路径。

开发模式运行 `npm run dev`，页面位于 <http://127.0.0.1:5173>，API 监听 `127.0.0.1:4174`。也可以运行 `npm run build` 后用 `npm start` 启动生产构建。

检查本机程序和配置：

```powershell
npm run check
```

该检查不发送模型请求，也不会重启应用；它不能证明模型账户授权有效。

## 架构与代码索引

| 路径 | 作用 |
| --- | --- |
| [`server/index.mjs`](./server/index.mjs) | 工作台协调服务、Codex app-server 事件、任务状态、计划确认、审批和提问、续接/停止/恢复、邮箱、审计持久化及 HTTP API。 |
| [`server/codex-app-server.mjs`](./server/codex-app-server.mjs) | 启动并连接 Codex app-server 的 JSON-RPC 客户端。 |
| [`src/App.jsx`](./src/App.jsx) | React 主界面：任务导航、计划确认、时间线、Markdown/GFM、表单提问、成员检查器、审计和邮箱面板。 |
| [`src/app.css`](./src/app.css) | 桌面和移动端布局、时间线层级、状态、抽屉、计划和交互卡片样式。 |
| [`src/main.jsx`](./src/main.jsx) 与 [`src/assets/`](./src/assets/) | 前端入口和三个成员的图标资源。 |
| [`bridges/dsh-ai-bridge/dsh-mcp-connector/server.mjs`](./bridges/dsh-ai-bridge/dsh-mcp-connector/server.mjs) | DeepSeek MCP connector；处理 `dsh_ask`、`dsh_wait`、`dsh_cancel`、队列和连接状态。 |
| [`bridges/dsh-ai-bridge/dsh-mcp-connector/selftest.mjs`](./bridges/dsh-ai-bridge/dsh-mcp-connector/selftest.mjs) | DSH connector 的离线及协议自测。 |
| [`bridges/codex-doubao-desktop-gateway/src/server.mjs`](./bridges/codex-doubao-desktop-gateway/src/server.mjs) | 豆包 MCP 工具：新建/继续会话、等待、停止、状态检查和读取消息。 |
| [`bridges/codex-doubao-desktop-gateway/patches/doubao-cli-windows.patch`](./bridges/codex-doubao-desktop-gateway/patches/doubao-cli-windows.patch) | 与 Windows 桌面端配套的 CLI 补丁。 |
| [`team/task-contract.schema.json`](./team/task-contract.schema.json) 与 [`team/tasks/TEMPLATE.md`](./team/tasks/TEMPLATE.md) | 任务合同字段、读写范围、验收、依赖、状态和记录模板。运行任务 JSON 不包含在公开源码中。 |
| [`scripts/start-agent-team.ps1`](./scripts/start-agent-team.ps1) 与 [`scripts/check-prerequisites.ps1`](./scripts/check-prerequisites.ps1) | 启动本地工作台及检查运行前置条件。 |

### 主要 API

API 在 [server/index.mjs](./server/index.mjs) 中实现。包括 `POST /api/runs` 新建任务、`GET /api/runs` 与 `GET /api/events` 获取列表和实时事件，以及 `/api/runs/:id` 下的计划、追加指引、暂停恢复、停止、标题更新、成员留言、提问回答、审批、子任务、审计事件和删除接口。API 与豆包 CDP 都只应绑定 loopback；MCP server 使用本机 stdio。

Codex 是外层协调者。DeepSeek Harness 的原生 Agent Teams 只管理 DSH 自己的进程，因此本工作台通过 stdio MCP bridge 将 DSH 和豆包作为外部成员接入，不会把它们伪装成 Codex 的原生 roster。

## 本地数据和安全

- 工作台运行状态保存在 `data/runs.json`，追加审计事件保存在 `data/events/<runId>.jsonl`，成员邮箱保存在 `data/mailbox/`。这些运行数据、依赖目录、豆包 CLI 数据目录和 `.env` 文件由 `.gitignore` 排除。
- 删除对话会永久删除工作台保存的相应数据；不删除工作区里的文件，也不删除 Codex、DSH 或豆包客户端自己的聊天记录。
- 默认只使用本机 MCP stdio 和 `127.0.0.1` API。不要将豆包 CDP 端口、工作台 API 或凭据暴露到局域网或公网。
- 允许工作区写入时，三个 agent 可依分配范围修改所选目录。敏感项目应使用独立工作副本，并逐项检查实际 diff 和产物。
- 顶层项目采用 MIT 许可证。两个 bridge 保留各自上游许可证；豆包 gateway 另附 [`THIRD_PARTY_NOTICES.md`](./bridges/codex-doubao-desktop-gateway/THIRD_PARTY_NOTICES.md)。产品名称和标志仍归各自权利人所有。

## 验证

```powershell
npm ci
npm run build
npm --prefix .\bridges\dsh-ai-bridge test
node --check .\server\index.mjs
node --check .\bridges\codex-doubao-desktop-gateway\src\server.mjs
```

完整 bridge 测试会运行本地确定性检查；`npm run check` 额外检查当前机器上的 CLI、MCP 配置和豆包 CDP 状态。
