# Agent Team Workbench

Windows 本机多 agent 协作工作台。用户在一个窗口提交目标，由 Codex 负责协调和实际执行，按任务需要调用 DeepSeek Harness 与豆包桌面端。工作台展示计划、成员状态、交互请求、执行记录和任务产物。

## 功能

- **按专长协作**：Codex 负责拆解、代码修改和验收；DeepSeek Harness 负责方案规划与设计复核；豆包负责信息搜集与整理。简单任务可由 Codex 独立完成，不要求每个任务都调用所有成员。
- **复杂任务先确认计划**：工作台可以先展示目标、启用成员和工作区写入模式。用户可以批准执行、要求修改计划或放弃；计划获批前不会启动 agent。
- **任务与进度可追踪**：聊天区按用户消息、最终答复和必要过程信息展示；成员回复、工具调用和状态变化会进入本地活动与审计记录。根任务和已派发子任务的负责人、依赖、状态、尝试次数、验收条件和证据可通过 API 查询。
- **执行期间可以沟通**：用户可以在运行中追加指引，让 Codex 在当前回合中调整执行方向。成员邮箱支持留存给 Codex、DeepSeek 或豆包的留言，由 Codex 在后续协调时决定是否转达。
- **交互式提问**：需要用户决定时，Codex 可提交选项、文本、数字、布尔值或多选问题，并提供补充说明输入框。回答会回到等待中的会话。
- **三档执行权限**：新任务默认使用工作区写入；也可选择只读，或明确启用“完全权限”。既有对话可在聊天底部切换权限并点击“应用权限”；工作台会更新该对话原有的 Codex 线程，不需要新开任务。若当前回合仍在运行，新权限会在该回合结束后的下一次 Codex 回合生效，并用于之后新派发的成员任务；当前回合和已派发的成员任务保留启动时的权限，权限变更待生效期间不能追加新指引。完全权限需再次确认后启用。
- **停止与恢复**：停止会中断 Codex，并向本轮正在运行的 DeepSeek 与豆包任务发送停止信号；已经完成的文件修改不会撤销。停止后的任务可填写原因再恢复，明确停止的 worker 不会被悄悄重新启动。
- **长对话和长任务**：DeepSeek connector 提供短时等待、继续等待和取消工具，避免单次 MCP 超时被误认为任务失败；豆包未确认完成时沿用原 `conversationId`/`runId` 继续等待，不重复发送任务。工作台重启后通过 Codex app-server 的 `thread/resume` 复用保存的 `threadId`，后续消息继续进入原 Codex 对话，不会重放整段历史来创建新对话。
- **本地记录管理**：任务标题可修改；Markdown/GFM 消息可直接阅读；可查看事件审计和成员留言。删除工作台对话会永久删除其本地运行、审计和邮箱记录，不删除工作区内的代码文件，也不删除各 agent 客户端保存的原始会话。

## 近期更新（2026-10）

- **更安静的对话区**：任务完成通知仍保存在本地通知和审计数据中，但不再作为高优先级聊天卡片显示。历史记录中的同类通知也会自动隐藏。
- **面向任务的最终答复**：Codex 默认只汇报结论、实际改动或产物、必要的验证结果和未解决项。会话标识、运行标识、工具调用流水和成员讨论过程保留在本地活动与审计记录中，只有在明确询问时才展示。
- **可恢复的协作状态**：任务、子任务、依赖、尝试次数和验收证据会持久化；每次状态变化会追加到 JSONL 审计文件。复杂任务可先确认计划，暂停后需填写原因才可恢复。
- **连续会话与长任务等待**：同一工作台任务会复用 Codex、DeepSeek 和豆包的既有会话。DeepSeek 或豆包仍在执行时，工作台会继续等待同一任务，而不会把超时直接视为失败或重复派发。
- **运行中的交互控制**：任务执行期间可追加指引；需要人工决定时可显示选项和补充说明表单；停止按钮会向三个成员发送停止请求。
- **界面与记录管理**：支持 Markdown/GFM 渲染、可编辑对话标题、可折叠的右侧成员活动区、成员邮箱和审计浏览。删除对话会永久清除工作台保存的对话、审计和邮箱数据，不影响工作区文件。
- **可选项目记忆**：新对话默认关闭，可在发送第一条消息前用工作区旁的开关单独启用。开启后，工作台在所选工作区的 `.agent-team/conversations/<runId>.md` 创建并更新项目进展、计划、问题和下一步；关闭时不创建或更新文档，也不把记忆路径提供给 agent。已开启的文档路径显示在聊天标题下方；删除工作台对话会保留该文件。

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

每次开机后，豆包需已经通过上节命令启用本机 CDP。**Codex 和 DSH 不需要启动**。然后双击 [Agent Team.cmd](./Agent%20Team.cmd)，或在 PowerShell 运行：

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

API 在 [server/index.mjs](./server/index.mjs) 中实现。包括 `POST /api/runs` 新建任务、`POST /api/runs/:id/permission` 更新既有任务的后续执行权限、`GET /api/runs` 与 `GET /api/events` 获取列表和实时事件，以及 `/api/runs/:id` 下的计划、追加指引、暂停恢复、停止、标题更新、成员留言、提问回答、审批、子任务、审计事件和删除接口。API 与豆包 CDP 都只应绑定 loopback；MCP server 使用本机 stdio。

Codex 是外层协调者。DeepSeek Harness 的原生 Agent Teams 只管理 DSH 自己的进程，因此本工作台通过 stdio MCP bridge 将 DSH 和豆包作为外部成员接入，不会把它们伪装成 Codex 的原生 roster。

### 当前限制

Codex、DeepSeek Harness 和豆包各自官方客户端中的原生子智能体能力尚未统一接入工作台。成员在其自身运行时内部创建的子智能体，会由该运行时自行管理；工作台目前只能显示对应一级成员的整体任务状态，不能单独查看、指挥或停止其内部子智能体。

## 本地数据和安全

- 工作台运行状态保存在 `data/runs.json`，追加审计事件保存在 `data/events/<runId>.jsonl`，成员邮箱保存在 `data/mailbox/`。这些运行数据、依赖目录、豆包 CLI 数据目录和 `.env` 文件由 `.gitignore` 排除。
- 删除对话会永久删除工作台保存的相应数据；不删除工作区里的文件，也不删除 Codex、DSH 或豆包客户端自己的聊天记录。
- 启用项目记忆的对话会在所选工作区的 `.agent-team/conversations/` 保存文档，由工作区内的 `.agent-team/.gitignore` 排除在 Git 提交之外。关闭项目记忆的对话不创建该文档；删除对话不会删除已有记忆文档。
- 默认只使用本机 MCP stdio 和 `127.0.0.1` API。不要将豆包 CDP 端口、工作台 API 或凭据暴露到局域网或公网。
- 完全权限会授予各 agent 当前 Windows 用户可访问的文件和操作权限；它不突破 Windows 账户本身的权限。敏感项目应保持工作区写入模式，并逐项检查实际 diff 和产物。
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

## 导航、工作区与桌面入口

Windows 启动和配置脚本需要 PowerShell 7（`pwsh`）。

- 左上角按钮可展开或收起任务导航。桌面端新建、切换任务保留侧栏状态；小屏幕选择后关闭抽屉。
- 工作区可以手动输入绝对路径，也可以点击“选择文件夹”浏览本机目录。两种方式使用同一输入值；任务建立后工作区锁定。
- 生成带专用图标的项目快捷方式：`npm run setup:shortcut`。同时创建桌面入口：`npm run setup:shortcut -- -Desktop`。
- 生成的 `Agent Team.lnk` 使用当前项目绝对路径；移动项目后重新生成。发送到桌面时选择这个快捷方式，而非 `.cmd`，后者使用 Windows 默认脚本图标。
- Windows 本地 API 测试：`npm test`（隔离临时数据，不调用模型）；生产构建：`npm run build`。