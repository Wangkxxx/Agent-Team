# 各客户端配置速查

统一替换：`<SERVER>` = `C:\tools\dsh-mcp-connector\server.mjs`
（若客户端 spawn 中文路径失败，把 `dsh-mcp-connector` 整个目录复制到纯英文路径后替换。）

标准 stdio 条目：

```json
{
  "dsh": {
    "command": "node",
    "args": ["<SERVER>"],
    "env": {
      "DSH_BIN": "%APPDATA%\\npm\\dsh.cmd",
      "DSH_WORKSPACE": "<DSH 会话的工作目录>"
    }
  }
}
```

`DSH_BIN` 用全局安装的稳定路径（`npm i -g @deepseek-ai/dsh`）。若沿用 npx 缓存里的 `...\_npx\<hash>\node_modules\.bin\dsh.cmd`，那个 hash 会随版本变化。

## 先检查是否已有实例在跑

同一台机器上可能已经有实例（本机实测过 stdio 与 HTTP 两种）：

```powershell
Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" | Select-Object ProcessId, CommandLine }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dsh-mcp-connector*' } | Select-Object ProcessId, CommandLine
```

已有 HTTP 实例时，客户端可以直接填 `http://127.0.0.1:8790/mcp` + `Authorization: Bearer <token>`，不必再起一个。**不要**为了「重来一次」而 kill 掉别人的实例——它可能是另一个客户端正在用的。

## 路径与顶层键

| 客户端 | 配置文件 | 顶层键 | 格式 | 证据 |
|---|---|---|---|---|
| Claude Code | `~/.claude.json`；项目 `.mcp.json` | `mcpServers` | JSON | 官方 |
| Cursor | `~/.cursor/mcp.json`；项目 `.cursor/mcp.json` | `mcpServers` | JSON | 官方 |
| VS Code / Copilot | 项目 `.vscode/mcp.json` | **`servers`** | JSON | 官方 |
| VS Code 可移植格式 | `%COPILOT_HOME%\mcp-config.json` 或 `~/.copilot/mcp-config.json` | `mcpServers` | JSON | 官方 |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.<名>]` | TOML | 本机配置实测 |
| Kimi Code CLI | `~/.kimi-code/mcp.json`；项目 `.kimi-code/mcp.json` | `mcpServers` | JSON | 官方 |
| Kimi CLI（旧版） | `~/.kimi/mcp.json` | `mcpServers` | JSON | 官方（旧版将停维护） |
| ZCode（智谱） | `~/.zcode/cli/config.json`；项目 `.zcode/config.json` | **`mcp.servers`** | JSON | 官方 |
| ZCode `.agents` 兼容层 | `~/.agents/mcp.json`；项目 `.agents/mcp.json` | `mcpServers` | JSON | 官方 |
| Step Code（阶跃） | `~/.stepcode/config.toml`；项目 `.stepcode/config.toml` | **`[mcp_servers.<名>]`** | **TOML** | 官方 |
| MiniMax Code | `~/.minimax/mcp.json`（`MINIMAX_DATA_DIR` 可改） | `mcpServers` | JSON | 官方 |
| Qwen Code（阿里） | `~/.qwen/settings.json`；项目 `.qwen/settings.json` | `mcpServers` | JSON | 官方页面存在 + 第三方复述 |
| Qoder CLI（通义灵码 → Qoder CN） | `~/.qoder/settings.json`；项目 `.mcp.json`；本地 `.qoder/settings.local.json` | `mcpServers` | JSON | 官方 |
| CodeBuddy CLI（腾讯） | `~/.codebuddy.json`；项目 `.mcp.json`；本地 `~/.codebuddy.json#/projects/<path>` | `mcpServers` | JSON | 官方 |
| TRAE（字节） | 设置面板（头像 > 设置 > MCP），磁盘路径未文档化 | `mcpServers` | JSON | 官方 |
| 豆包工作（字节，本机桌面 App） | **无本地文件**，App 内「技能 · 连接器 · 伙伴」→ 新建自定义连接器 | `mcpServers` + `url` | JSON | 第三方接入文档 + 本机进程观察；**未本机实测** |
| 扣子 Coze（字节） | 无本地文件，网页/桌面端粘贴 JSON | `mcpServers` + `url` | JSON | 官方：**不支持 STDIO** |
| 讯飞星辰 Agent 平台 | 无本地文件，表单填 Server URL | — | — | 官方：仅远程 |
| 百度 Comate | 未证实 | 未证实 | — | 官方 PDF 含 stdio，正文未取到 |

## 各客户端片段

**Kimi Code CLI**（`~/.kimi-code/mcp.json`）

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["<SERVER>"],
      "env": { "DSH_BIN": "%APPDATA%\\npm\\dsh.cmd", "DSH_WORKSPACE": "<WORKDIR>" }
    }
  }
}
```

支持字段：`command` / `args` / `env` / `cwd` / `enabled` / `startupTimeoutMs` / `toolTimeoutMs`。
**`type` 字段存疑**：官方 schema 未收录（有 `command` 即视为 stdio）；另一份文档示例写了 `"type": "stdio"`。两者都未实测。

**ZCode**（原生键是 `mcp.servers`）

```json
{ "mcp": { "servers": { "dsh": { "command": "node", "args": ["<SERVER>"] } } } }
```

同一作用域内只要 `.zcode` 里配了任意 MCP 服务，同作用域的 `.agents/mcp.json` 会被整体跳过、不合并。

远程形态（`url` + `headers`）**没有官方 JSON 样例，键名未证实**——stdio 形态有官方样例。验证：设置 → MCP 服务器 里出现 `dsh` 且为启用状态。

**Step Code**（TOML）

```toml
[mcp_servers.dsh]
command = "node"
args = ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
env = { DSH_BIN = "%APPDATA%\\npm\\dsh.cmd" }
startup_timeout_sec = 30
tool_timeout_sec = 900
enabled = true
```

明确不支持旧式 SSE，只有 stdio 与 Streamable HTTP。远程形态用 `url` + `http_headers`，或更安全的 `bearer_token_env_var`（从环境变量取 token，不写进文件）。
**注意工具命名**：Step Code 会把工具名拼成 `dsh__dsh_ask` / `dsh__dsh_cli_info`（客户端加的 server 前缀），和别家的 `dsh_ask` 不同。
验证：`step mcp list` / `step mcp list --json` / `step mcp get dsh`；会话内 `/mcp` 看 connecting|connected|failed。

**MiniMax Code**（stdio 必须显式声明 type）

```json
{ "mcpServers": { "dsh": { "type": "stdio", "command": "node", "args": ["<SERVER>"] } } }
```

**CodeBuddy CLI**（stdio 必须显式声明 type）

```json
{ "mcpServers": { "dsh": { "type": "stdio", "command": "node", "args": ["<SERVER>"] } } }
```

作用域优先级 local > project > user。权限规则名是 `mcp__dsh` / `mcp__dsh__dsh_ask`，**不支持通配符**。首次连接通常需交互批准一次——建议保留审批，因为外部 CLI 触发的 DSH 会话默认是 `workspace-write`。

**Qwen Code**（远程写法是 `httpUrl` 而非 `url`）

```json
{ "mcpServers": { "dsh": { "command": "node", "args": ["<SERVER>"] } } }
```

**Qoder CLI / Claude Code**：项目级 `.mcp.json` 三者格式相同，同一份文件可同时服务 Claude Code、CodeBuddy CLI、Qoder CLI。

## 远程模式（无 stdio 的客户端）

```powershell
node "<SERVER>" --http --host 127.0.0.1 --port 8790 --token <强随机 token>
```

- 端点 `POST /mcp`，`Authorization: Bearer <token>`
- 未列入白名单的 `Origin` 返回 403（`--allow-origin https://…` 放行）
- 公网必须再套 HTTPS 反向代理/隧道；云端平台若只支持 OAuth 接入，还需按 MCP 授权规范补 OAuth（本桥只有 Bearer）

适用：扣子 Coze、讯飞星辰、Claude.ai 自定义连接器（要求 HTTPS 且无 localhost 选项），
以及**豆包工作**（本机 App，用 `http://127.0.0.1:8790/mcp` 即可，**不需要**隧道）：

```json
{ "mcpServers": { "dsh": {
  "type": "streamable-http",
  "url": "http://127.0.0.1:8790/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "timeout": 60 } } }
```

豆包工作两条安装路：把上面这段（连同「帮我安装一个本机 DeepSeek Harness 的 MCP 连接器」）
发给它自己装，或在「技能 · 连接器 · 伙伴」里手填（传输类型 **HTTP**、服务器 URL、
自定义 Headers）。现成打印：`node scripts/register.mjs --client doubao-work --token <t>`。

## 未证实 / 别当事实断言

- Kimi 条目 `type` 字段（见上）
- CodeBuddy 项目级 `.mcp.json` 的放行开关（`enableAllProjectMcpServers` / `enabledMcpjsonServers`）：单一文档镜像所见，未获第二个来源确认；走 user 作用域可绕开
- Kimi VS Code 扩展是否读 `~/.kimi-code/mcp.json`：未证实（文档只覆盖 CLI）
- 百度 Comate 的配置文件路径与顶层键
- **豆包工作**：入口名称（「技能 · 连接器 · 伙伴」）、传输类型叫 `HTTP`、自定义 Headers 的存在
  —— 来自第三方厂商接入文档与本机进程观察（`mcp_helper.dll`），**本机尚未完成一次真实握手**；
  AI 安装路径里的 `headers` 字段是否被接受也未证实（手填「自定义 Headers」是更稳的一条）
- 智谱清言、AutoClaw、跃问、豆包客户端是否支持自定义 MCP：未找到官方文档
- AutoGLM 方向相反：智谱发布的是 `autoglm-mcp-server`（MCP **server**），不是客户端
