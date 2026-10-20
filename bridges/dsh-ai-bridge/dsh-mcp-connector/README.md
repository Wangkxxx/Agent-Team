# dsh-mcp-connector

把外部 AI 客户端（Claude Code / Cursor / VS Code / Codex / Kimi Code / CodeBuddy / Qoder / TRAE / ZCode / Step Code / MiniMax Code）接到**本机 DeepSeek Harness（DSH）**的 MCP 服务器 demo。

- **零依赖**：MCP 的 stdio 传输就是「一行一个 JSON-RPC 2.0 消息」，协议半区直接手写，不需要装任何 SDK。
- **不改 DSH**：走随 CLI 发货的 `dsh --profile headless` 一次性 profile。
- **不动正在运行的服务**：不会碰你现在跑着的 `dsh web`（43120）。
- **已固化为 skill**：`~/.dsh/skills/dsh-mcp-connector/`（含各客户端配置速查与「未证实项」清单）。任何会话让 agent「把外部 AI 接到 DSH」时会自动命中它，不必重新调研。

---

## 1. 本机实测结果（2026-10-01）

| 验证项 | 结果 |
|---|---|
| 密封 `DSH_HOME` 下 `dsh --profile headless --help` | exit 0，profile 首次自动初始化成功 |
| MCP stdio `initialize` / `tools/list` / `tools/call` 往返 | 全部通过 |
| Streamable HTTP 传输（401 / 403 / 404 / 405 / 202 / initialize / tools/list） | 8 项断言全部通过 |
| 真实模型调用（`dsh_ask`） | **3.7 秒**返回「连接器已就绪」 |
| 返回的会话 id | `session-3075a35c-76c4-444e-b4e2-678c083273f9` |
| **续同一个会话**（带 `sessionId` 再发一条） | 同一 sessionId 返回「第二条也到」，exit 0 |
| 任务队列语义（领取顺序、不重复领取、幂等完成、未知 id 拒绝、状态折叠） | 通过 |
| 任务队列并发（**6 路并行领取拿到 6 个不同任务**，无碰撞） | 通过 |
| HTTP 生产者路由 `POST /tasks`（201 入队 / 无 token 401 / 入队后可被领取） | 通过 |
| 连接器自观测（`connector_status` 报出接入的客户端；**流水线发送也能正确记账**） | 通过 |
| **真实 MCP 客户端握手**（Claude Code 2.1.226，协商到协议 `2025-11-25`） | 通过；证据是连接器自己记下的 `clients.json`，不是它的自述。该客户端当时未登录，故工具调用未执行 |
| 边界与失败分支（允许的 Origin、`--tasks-path`、畸形请求体、`limit`、超大结果截断、**崩溃半行**、**陈旧锁抢占**、**超时杀进程**、**GBK 输出解码**、**空任务/非法 sessionId 前置校验**、**失控输出中止**、**不可解析行容忍**） | 通过 |
| 自测总计 | **61 项断言，`ALL CHECKS PASSED`，退出码 0**（离线模式 58 项 + 2 项跳过） |

复现命令：

```powershell
cd C:\tools\dsh-mcp-connector
node selftest.mjs                                   # 密封验证，不产生模型费用（61 项）
$env:DSH_MCP_CONNECTOR_LIVE="1"; node selftest.mjs  # 追加一次真实模型调用
$env:DSH_SELFTEST_OFFLINE="1"; node selftest.mjs    # 离线模式：跳过依赖本机 dsh 的 2 项（58 项，CI 用）
```

**用真实 MCP 客户端验证握手**（不改动客户端的任何配置）：写一个临时 MCP 配置指向本连接器，让客户端带上 `--mcp-config` + `--strict-mcp-config` 跑一次。Claude Code 上这样跑：

```powershell
# claude-e2e-mcp.json 里给 dsh 条目加上 DSH_QUEUE_FILE 指向临时目录，避免污染真实队列
claude -p "列出你能调用的工具" --mcp-config .\claude-e2e-mcp.json --strict-mcp-config
```

跑完检查 `clients.json`——**有没有这条记录才是客户端真的连上来的证据**，它的文字回复不是。本机实测结果：`claude-code@2.1.226 via stdio, protocolVersion 2025-11-25`。

离线模式跳过的是「密封启动 headless profile」与「`dsh_cli_info` 真的拉起 CLI」——这两项需要本机装好 DSH。协议面、HTTP 传输、任务队列仍然全测，所以没有 DSH 的机器也能守住这部分行为（`.github/workflows/ci.yml` 就是这么跑的）。

---

## 2. 它是怎么工作的

```
Claude Code / Cursor / VS Code / Codex / 豆包 / Kimi Code / CodeBuddy / Qoder / …
        │  MCP (stdio，或 Streamable HTTP)
        ▼
   server.mjs  ──spawn──▶  dsh --profile headless --json <task via stdin>
        │                              │
        │◀──── NDJSON 事件流 ───────────┘
        ▼
  {type:'session'} → sessionId
  {type:'text'/'thinking'/'tool_call'/'tool_result'} → 过程
  {type:'final', text} → 最终答案

  DSH / 脚本 / HTTP ──▶ tasks.jsonl（生产者入队）
                              ▲  豆包等客户端用 task_claim 领取、task_complete 回报
                              └── server.mjs 的队列工具
```

三个刻意的设计：

1. **任务文本永远走 stdin**（传 `-` 参数），绝不进 argv。这样带空格、引号、换行的中文任务文本在 Windows 上不会被 shell 引号规则破坏。
2. **`sessionId` 是唯一的会话句柄**：省略它 = 新建会话；带上它 = 往那个会话继续投递消息。
3. **队列是“拉”而不是“推”**：MCP 工具只在客户端自己的回合里被调用，所以推不进去；反转为「生产者入队 / 客户端领取」后，不需要任何额外通道。

---

## 3. 前置条件

| 条件 | 说明 |
|---|---|
| Node ≥ 20 | 本机 v24.18.0 |
| `dsh` 在 PATH | 本机解析为 npx 缓存里的 `…\node_modules\.bin\dsh.cmd` |
| 首次运行会自动建 profile | 在 `$DSH_HOME/profiles/headless` 写 4 个文件：`package.json`（bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`）、`cordis.yml`、`cordis.patch.yml`、`pnpm-workspace.yaml`。**无网络、无 pnpm install**。本机已创建完毕。 |

建议显式固定 dsh 路径（npx 缓存路径会随版本变化）：

```powershell
$env:DSH_BIN = "%APPDATA%\npm\dsh.cmd"
```

---

## 4. MCP 配置方法

统一约定：`server.mjs` 的绝对路径为

```
C:\tools\dsh-mcp-connector\server.mjs
```

### 4.0 图形界面客户端：「新建自定义连接器」对话框怎么填

很多客户端（包括国产 AI 客户端）用的是同一个表单，字段一一对应如下：

| 表单字段 | 填什么 |
|---|---|
| 服务器名称 | `dsh` |
| 传输类型 | `STDIO`（保持默认） |
| 命令 | `node`（若客户端找不到 node，改填绝对路径 `node`） |
| 参数 | `C:\tools\dsh-mcp-connector\server.mjs` |
| 环境变量 1 | `DSH_BIN` = `%APPDATA%\npm\dsh.cmd` |
| 环境变量 2 | `DSH_WORKSPACE` = `C:\tools` |

说明：

- **参数只填脚本路径这一项**，不要加 `--http` 之类；「命令 + 参数」等价于命令行的 `node <参数1> <参数2> …`。
- 表单提示「自定义连接器仅支持在本地电脑中使用」——这与我们默认的 stdio 传输完全一致。
- **`DSH_WORKSPACE` 建议填**：不填时 DSH 会话的工作目录会跟随客户端的启动目录，可能是任意位置。
- 路径里有中文（`插件`）。绝大多数情况没问题；万一客户端 spawn 失败，把整个目录复制到纯英文路径（如 `%USERPROFILE%\dsh-mcp-connector\`）再把参数改过去即可。

### 4.1 Claude Code（本机已安装，`claude` 在 PATH）

用户级（所有项目可用，推荐）：

```powershell
claude mcp add dsh -s user -- node "C:\tools\dsh-mcp-connector\server.mjs"
```

项目级（只在该项目可用，写入 `.mcp.json`）：

```powershell
claude mcp add dsh -s project -- node "C:\tools\dsh-mcp-connector\server.mjs"
```

需要传环境变量时：

```powershell
claude mcp add dsh -s user -e DSH_BIN="C:\...\dsh.cmd" -- node "C:\tools\...\server.mjs"
```

验证 / 移除：

```powershell
claude mcp list
claude mcp remove dsh -s user
```

等价的 `.mcp.json`（放项目根，与原生命令二选一）：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

### 4.2 Claude Desktop（本机未安装）

配置文件：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

改完需要完全退出并重启 Claude Desktop。

### 4.3 Cursor（本机已安装，尚无 `mcp.json`）

全局：`%USERPROFILE%\.cursor\mcp.json`；项目级：`<项目>\.cursor\mcp.json`

```json
{
  "mcpServers": {
    "dsh": {
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

### 4.4 VS Code / Copilot Chat

项目级 `.vscode/mcp.json`（VS Code 原生格式，顶层是 `servers`）：

```json
{
  "servers": {
    "dsh": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"]
    }
  }
}
```

可移植格式（多个 Copilot 工具共用，顶层是 `mcpServers`）：`%COPILOT_HOME%\mcp-config.json`，未设时用 `%USERPROFILE%\.copilot\mcp-config.json`。

### 4.5 Codex CLI（本机已安装）

追加到 `%USERPROFILE%\.codex\config.toml`（该文件的 `[mcp_servers.*]` 结构已在本机确认）：

```toml
[mcp_servers.dsh]
command = 'node'
args = ['C:\tools\dsh-mcp-connector\server.mjs']
enabled = true
```

### 4.6 远程 / 云端官方 agent：Streamable HTTP 模式

**云端托管的 agent 无法启动你本机的进程**（网页端产品都属于这一类），本地 stdio 对它们无效，必须给一个 HTTP 端点：

```powershell
node server.mjs --http --host 127.0.0.1 --port 8790 --token <你的token>

# 不传 --token 时自动生成一枚并打印到 stderr（先这样跑一次，记下 token 再固定）
node server.mjs --http --port 8790
```

| 项 | 值 |
|---|---|
| 端点 | `POST http://127.0.0.1:8790/mcp`（路径可用 `--path` 改） |
| 鉴权 | `Authorization: Bearer <token>`；缺失或错误返回 **401** |
| Origin | 未列入白名单的 `Origin` 头返回 **403**；`--allow-origin https://你的域名` 放行 |
| 其他方法 | `GET`/`DELETE` 返回 **405**；路径不符返回 **404** |
| 通知 | 只含通知的 POST 返回 **202**，无 body |
| 传输语义 | Streamable HTTP（MCP 2025-11-25 规范），无状态，不下发 `Mcp-Session-Id` |

以上每一条都有自测断言覆盖（`selftest.mjs` 第 4 步，8 项）。

要暴露到公网必须再套一层 **HTTPS 反向代理或隧道**（你已装好的 cloudflared 即可），并且：

1. token 用强随机值，别用示例值；
2. 若云端平台只支持 OAuth 接入，还需按 MCP 授权规范补 OAuth —— 本 demo 只实现了 Bearer；
3. 不要 `--host 0.0.0.0` 裸奔到公网。

### 4.6.1 豆包工作（DoubaoWork）—— App 内自定义连接器，走 HTTP

**它是什么**：豆包工作是字节另一个**本机桌面 App**（`E:\DoubaoWork\app\DoubaoWork.exe`，
Chromium 147，自带 `mcp_helper.dll` 与「技能 · 连接器 · 伙伴」），和 [第 8 章](#8-故障排查)里
用 CDP 驱动的豆包桌面版（个人版）**不是同一个东西**。

**它的接入方式**：在 App 内「新建自定义连接器」，传输类型选 **HTTP**（就是 MCP 的
streamable-http），并可填**自定义 Headers**。因为它跑在本机，URL 直接写 `127.0.0.1` 即可，
**不需要** 4.6 里那套 HTTPS 隧道。

```powershell
# 1) 先把 HTTP 端点跑起来（token 自己定一枚强随机值）
node dsh-mcp-connector\server.mjs --http --host 127.0.0.1 --port 8790 --token <你的token>

# 2) 打印要粘贴到 App 里的内容（两种方式 + 启动命令 + 验证方法）
node scripts\register.mjs --client doubao-work --token <你的token>
```

打印出来的东西包含两条路：

- **方式一（推荐）**：把那段 `{"mcpServers":{"dsh":{"type":"streamable-http",...}}}` 连同
  「帮我安装一个本机 DeepSeek Harness 的 MCP 连接器」一起发给豆包工作，它自己装；
- **方式二**：手动添加 —— 服务名称 `dsh` / 传输类型 `HTTP` / 服务器 URL `http://127.0.0.1:8790/mcp` /
  自定义 Headers `Authorization = Bearer <token>`。

**怎么确认真的接上了**（照 3 章的规矩：不信自述，看副作用）：

1. 端点 stderr 打印 `streamable HTTP MCP endpoint: http://127.0.0.1:8790/mcp`；
2. 握手发生过 → `clients.json`（`$DSH_HOME\mcp-connector\clients.json`）里出现该客户端记录；
3. 在对话里让它**列出工具**，能看到 `dsh_ask` / `task_*`，才算**那个会话**真能用
   （只看到 `clients.json` 里有记录只证明连过，不证明某个会话里工具可用）。

**证据等级（本机已实测，2026-10-16）**：

- **连接成立**：`clients.json` 出现新记录 —— 客户端自报名 **`rmcp 3.2.0`**（Rust MCP SDK 的默认名，
  不是 `DoubaoWork`）、`transport: "http"`、`initializations: 1`；时间与本机操作对得上，
  且 `127.0.0.1:8790` 上有来自本机的 TCP 连接痕迹。
- **工具调用成立**：在豆包工作对话里调用 `task_publish` 后，队列文件 `tasks.jsonl` 真的多了一条
  `{"type":"publish","id":"t-mvaq1avr-3d95f7","task":"来自豆包工作的握手测试 MARKER-DBW-1016","source":"mcp"}` ——
  id 与它回报的一致。**这是本桥第一次有真实 MCP 客户端成功调用工具**（此前一直是「未验证」）。
- **它只列出 3 个工具**：豆包工作会话里看到 `dsh_ask` / `dsh_cli_info` / `task_publish`，
  而服务端 `tools/list` 实测返回 **7 个**（另有 `connector_status`、`task_claim`、`task_complete`、
  `task_list`）。**能力边界因此很具体**：豆包工作能**生产**任务、能给 DSH 发消息，
  但看不到「领取 / 回报完成」那两个工具，暂时不能当队列消费者。筛选发生在客户端侧，
  原因未查明（可能是它的工具策略、模型自己没列全，或连接器设置里的逐工具开关）。
  **待办**：让它再列一次工具、或直接调 `task_list`，就能分清「真过滤」还是「没列全」。
- **它的状态回报通道已补齐（2026-10-16）**：豆包桌面版靠 `status.mjs` 把
  `started/progress/done/failed` 写进 `status.jsonl`，DSH Web 的豆包徽章就是读这个文件——
  普通 MCP 客户端没有这条通道，所以它干的活只留在自己对话里。现在连接器多了一个
  **`status_report`** 工具（第 8 个），内部 spawn 现有的 `doubao-cdp/status.mjs`（**不复制**事件契约），
  于是任何 MCP 客户端都能像豆包本体那样把状态报进徽章。已实测：三次工具调用
  （`start` → `progress 55` → `done`）让 `status.jsonl` 从 67 行变 70 行，
  且用 `status.mjs last MCP-STATUS-TEST` 独立复核得到 `done`。
- App 内的入口名称与「传输类型 HTTP / 自定义 Headers」来自第三方厂商接入文档
  （[草料 MCP 的「在豆包工作中使用」](https://cli.im/open-api/agent/open-platform-mcp/doubao-work.html)，
  2026-10-16 查阅）；**入口的确切文案未在本机核对**（本机版本 2.32.12），
  但按文档步骤操作确实接通了，所以这条路径本身已被证实可用。

### 4.6.2 让客户端当工人：两条配方（按它**看得见**的工具选）

客户端侧的工具清单是**懒加载**的：同一个豆包工作连接器，实测出现过只列 3 个、后来列 6 个，
而服务端 `tools/list` 一直返回 8 个。**改完服务端要让它重连**（新开对话或关/开连接器），
否则它会继续用旧快照（实测：端点 16:50 重启并加了新工具，客户端仍拿着 16:39 的清单）。

| 它能看到的工具 | 配方 |
|---|---|
| 有 `task_claim` | `task_claim`（拿 id）→ 干活 → `status_report start/progress` → `status_report done` → `task_complete`。这是完整闭环，`claim` 的作用是**多消费者之间互斥** |
| **没有** `task_claim`（豆包工作当前就是这种） | `task_list state=pending` 拿 id → 干活 → `task_complete id result`。**不 claim 直接 complete 是允许的**（已密封测试：complete 事件自己就折成 `done`，不需要 claim 事件）——单工人场景下不影响正确性 |
| 上面两种都没有 `status_report` | 干活过程**进不了徽章**（徽章只读 `status.jsonl`）。两条替代：①让它重连后再列一次工具；②它若自带终端能力，直接跑 `doubao-cdp/status.mjs start --job <id>`，那正是豆包本体的做法 |

正在跑的队列 worker 约定：`task_list` 看有没有 pending → 有就干 → `task_complete` 回报，
**结果里带上任务文本里的标记**（例如 `DISPATCH-xxxx`），这样派发方才能把回报对上号。

**派发侧（发起方）怎么等结果**——这是豆包本体 `dispatch.mjs --queue` 在拉取式这条线上的等价物：

```powershell
# 一条命令：先前置确认（端点通 + 有过客户端握手），再入队并等到被完成
node scripts\dispatch-work.mjs "任务文本" --timeout 600000

# 只想入队/等待的话（没有前置确认）
node queue.mjs add "任务文本" --wait --timeout 600000
node queue.mjs wait <id> [--timeout <ms>] [--interval <ms>]
```

`dispatch-work.mjs` 照抄了豆包本体那条线的纪律：**前置确认在入队之前**（确认不过就退出 3，
**一条任务都不入队**，不留孤儿任务），判定**只看队列里的 `complete` 事件**，
不采信任何客户端说「我做完了」；跳过确认才用 `--no-preflight`，且输出里会明确标出「未核实」。退出码：

| 码 | 含义 |
|---|---|
| `0` | 完成且 `status=ok` |
| `2` | 超时未核实（任务还在 pending/claimed——**不是成功**） |
| `3` | 未就绪（前置确认不过）／完成但 `status=error` |
| `5` | 没有这个 id（从未入队） |

### 4.6.3 让 HTTP 端点常驻（**不需要管理员**）

豆包桌面版本体是靠计划任务常驻的；但本机上 `Register-ScheduledTask` 与 `schtasks /SC ONLOGON`
都被**拒绝访问**（需要管理员，而受限会话无法提权）。所以用**当前用户的启动文件夹**：

| 件 | 位置 |
|---|---|
| 启动器 | `%USERPROFILE%\.dsh\mcp-connector\start-http.cmd`（**纯 ASCII**，token 在这里；**带自愈循环**） |
| 自启动 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DSH-MCP-HTTP.vbs`（隐藏窗口调用启动器） |
| ASCII 联接 | `%USERPROFILE%\.dsh\plugins` → 插件工作区（用于兼容不支持非 ASCII 路径的命令行工具） |
| 日志 | `%USERPROFILE%\.dsh\mcp-connector\http-endpoint.log`（端点输出 + 「退出→重启」记录） |

**自愈**：启动器是个循环——端点进程无论正常退出还是崩掉，**5 秒后自己拉回来**，
不再等到下次登录。已实测：直接杀掉服务进程 → 12 秒内出现**新的 PID**（父进程是循环的 cmd）
并继续服务 8 个工具，日志里留下 `server exited, restarting in 5s` 与新的启动块。
`check-doubao-work.mjs` 的「常驻」维度会连日志一起检查。

两个**踩出来的**必要细节：

1. **必须经 ASCII 联接**：批处理携带非 ASCII 路径不可靠（`Set-Content -Encoding ASCII` 会把「插件」
   写成 `??`；`-Encoding utf8` 又受 cmd 代码页影响）。联接用 `mklink /J`，不需要管理员。
2. **必须加 `--preserve-symlinks --preserve-symlinks-main`**：否则 node 会把入口模块解析成**真实路径**，
   而 `server.mjs` 的主模块检查比较的是 `import.meta.url`（真实路径）与 `process.argv[1]`（联接路径），
   两者不等 → **主函数不执行、静默退出 0**（实测：没有任何输出，端口也不起）。这个坑很难猜，所以写下来。
3. **它 spawn 的 `status.mjs` 反过来必须用真实路径**：`status.mjs` 有同样的主模块检查，
   经联接路径调用时同样**空转退出 0**。后果很隐蔽：`status_report` 只看退出码，于是**报成功却一条事件都没写**
   （真机实测：工具回 `exit code: 0`，`status.jsonl` 行数不变）。所以 `resolveStatusScript()` 现在先
   `realpathSync()` 再 spawn，并且自测里用**目录联接**复现了这个场景——去掉解析那条回归测试立刻红。

**已实测**：杀掉实例后用启动文件夹里那个 VBS 重新拉起 → 端口恢复、`tools/list` 返回 **8 个工具**，
进程链为 `node ← cmd.exe`（父进程已退出、**顶层不是 DSH**），所以 **DSH 重启不会带走它**。

卸载：删掉 Startup 里的 `DSH-MCP-HTTP.vbs` 与 `start-http.cmd`；联接用 `rmdir "%USERPROFILE%\.dsh\plugins"` 删除。
确实需要计划任务（开机/登录触发）时，用管理员执行：
`schtasks /Create /TN DSH-MCP-HTTP /TR "%USERPROFILE%\.dsh\mcp-connector\start-http.cmd" /SC ONLOGON /F`

| 豆包工作「领活→完成→回报」闭环 | 集成检查覆盖 `task_list` 与 `task_complete` 调用，并确认队列记录从接收推进到完成 |

### 4.6.4 体检：`scripts/check-doubao-work.mjs`

与豆包本体那条线的 `cdp.mjs doctor` 对等：**只读、只报告，不改任何东西**，一次看完五维。

```powershell
$env:DSH_MCP_TOKEN='<token>'
node scripts\check-doubao-work.mjs          # 人读
node scripts\check-doubao-work.mjs --json   # 机器读
```

| 维 | 看什么 |
|---|---|
| 端点 | `initialize` + `tools/list`：连得上吗、鉴权过不过、advertise 几个工具。**401 单独报 `unauthorized`**——端点活着但 token/Header 不对，绝不冒充「就绪」 |
| 客户端 | `clients.json` 里的**真实客户端**（自检与测试用的名字会被排除，否则会把「我自己测过」当成「App 连过」） |
| 状态通道 | `status.jsonl` 事件总数与最近几条——客户端回报落在这里，徽章也读它 |
| 队列 | pending / claimed / done |
| 常驻 | 启动器 / 启动文件夹 / ASCII 联接 / 日志 四件套在不在 |
| 推送 | ini 的 `[push]` 段：是否启用、目标会话、只推哪些状态；**每次推送都是一次真实模型调用** |

退出码沿用 doctor 的语义：**0 就绪 / 3 未就绪 / 8 无法判定**。

### 4.6.5 状态事件去哪了：徽章 + DSH 会话

客户端经 `status_report` 写下的事件，和豆包本体 `status.mjs` 写的是**同一个文件里的同一种事件**，
所以下游两条路对工作应用**同样适用**（不必再实现一遍）：

| 下游 | 由谁做 | 说明 |
|---|---|---|
| DSH Web 徽章 | `doubao-status-panel` | 读 `status.jsonl`（15 秒缓存），客户端一报就能看到；悬停提示里还会报告 MCP 侧有没有真实客户端接过 |
| 推进 DSH 会话 | `doubao-cdp/status-push.mjs` | 按 ini 的 `[push]` 段：**只推阶段转换**（`started` / `need_input` / `done` / `failed`），`progress` 不推 |

**成本提醒（重要）**：每次推送都是**一次真实模型调用**——这正是它只推阶段转换的原因。
请按需在本机配置 `[push]` 段。`check-doubao-work.mjs` 会检查推送是否启用、是否填写目标会话，
也会报告「启用但没目标会话」这种未完成配置状态。

### 4.6.6 最终验收：一条命令，只认带标记的完成

```powershell
$env:DSH_MCP_TOKEN='<token>'
node scripts\accept-doubao-work.mjs --timeout 600000

# 正式验收前先看一眼「现在就绪吗」——只查就绪，**连一条任务都不入队**
node scripts\accept-doubao-work.mjs --preflight-only
```

它做四件事，每件都是副作用证据：

1. **接线就绪**：端点（要求 advertise 8 个工具）+ 至少一个真实客户端握手（自检名已滤）；
2. **派出去的任务真被完成**：入队后等队列记到 `complete` 事件；
3. **完成的是这条任务**：结果里必须**原样带回**我们放进去的标记 `ACCEPT-<时间戳>`。
   **只有 complete 事件、却没有标记 → 验收不通过**（它可能做完了别的事，或没照做）；
4. **状态通道**：验收期间 `status.jsonl` 新增了几条事件（客户端报状态就有）。

退出码：`0` 通过 / `2` 时限内未完成（**不是成功**）/ `3` 未就绪或结果里没标记 / `5` 队列里找不到该任务。
就绪检查不过时**先不入队**（与 `dispatch-work.mjs` 同一条纪律：不留孤儿任务）。

### 4.7 Claude.ai 自定义连接器

Claude 的自定义连接器要求填 **HTTPS** 地址，官方文档没有 localhost 选项；私有网络要企业版 MCP tunnels。所以：

- **本机开发**：用 4.0–4.5 这些**允许 localhost 的 stdio 客户端**。
- **要接云端 Claude**：用 4.6 的 HTTP 模式 + 隧道，并把地址填成 `https://<隧道域名>/mcp`；token 走 `Authorization: Bearer`。

### 4.8 国产大模型官方客户端

**结论：已核对的国产官方客户端全部支持本地 stdio，所以「命令 `node` + 参数 `server.mjs`」这一套原样可用**，区别只在配置文件写在哪、顶层键叫什么（均为厂商自家文档站，2026-10-01 核验）。

| 客户端（厂商） | 配置文件 | 顶层键 | 格式 |
|---|---|---|---|
| **Kimi Code CLI**（月之暗面） | `%USERPROFILE%\.kimi-code\mcp.json`；项目级 `<项目>\.kimi-code\mcp.json` | `mcpServers` | JSON |
| **Kimi CLI**（旧版 Python，官方已声明将停维护） | `%USERPROFILE%\.kimi\mcp.json` | `mcpServers` | JSON |
| **ZCode**（智谱 / Z.ai） | `%USERPROFILE%\.zcode\cli\config.json`；项目级 `<项目>\.zcode\config.json` | **`mcp.servers`** | JSON |
| ZCode 的 `.agents` 兼容层 | `%USERPROFILE%\.agents\mcp.json`；项目级 `<项目>\.agents\mcp.json` | `mcpServers` | JSON |
| **Step Code**（阶跃星辰，`step`） | `%USERPROFILE%\.stepcode\config.toml`；项目级 `<项目>\.stepcode\config.toml` | **`[mcp_servers.<名称>]`** | **TOML** |
| **MiniMax Code**（桌面 / CLI） | `%USERPROFILE%\.minimax\mcp.json`（`MINIMAX_DATA_DIR` 可改根目录） | `mcpServers` | JSON |
| **Qwen Code**（阿里，Gemini CLI fork） | `%USERPROFILE%\.qwen\settings.json`；项目级 `<项目>\.qwen\settings.json` | `mcpServers` | JSON |
| **Qoder CLI**（阿里通义灵码，已改名 Qoder CN） | 用户级 `%USERPROFILE%\.qoder\settings.json`；local `<项目>\.qoder\settings.local.json`；项目级 `<项目>\.mcp.json` | `mcpServers` | JSON |
| **CodeBuddy CLI**（腾讯） | 用户级 `%USERPROFILE%\.codebuddy.json`；项目级 `<项目>\.mcp.json`；local `~/.codebuddy.json#/projects/<工作区路径>` | `mcpServers` | JSON |
| **TRAE**（字节） | 官方走设置面板（头像 > 设置 > MCP），磁盘路径未文档化 | `mcpServers` | JSON |
| **Comate 文心快码**（百度） | 官方手册确认支持 stdio，**路径未证实** | 未证实 | — |

**仅支持远程、本地 stdio 直接排除的两家**：

| 客户端 | 情况 |
|---|---|
| **扣子 Coze**（字节） | 官方**明确「暂不支持 STDIO 协议」**，只支持 Streamable HTTP / SSE，且只能在网页/桌面端创建自定义 MCP → 用 4.6 的 `--http` 模式 + 隧道 |
| **讯飞星辰 Agent 平台** | 只能用 **Server URL** 远程接入，无 stdio |

要点：

- **MiniMax Code 的 stdio 条目必须显式写 `"type": "stdio"`**，缺了它可能按远程处理。
- **ZCode 原生键是 `mcp.servers` 而不是 `mcpServers`**——最容易抄错的一处。另外：同一作用域内只要 `.zcode` 里配了任意 MCP 服务，同作用域的 `.agents/mcp.json` 会被**整体跳过、不合并**。
- **Step Code 是 TOML**，且明确**不支持旧式 SSE**（只有 stdio 与 Streamable HTTP）。
- **Qwen Code 虽然是 Gemini CLI 的 fork，但配置目录是 `~/.qwen`，不复用 `~/.gemini/settings.json`**；它的远程写法是 `httpUrl` + `headers`（不是 `url`）。
- **CodeBuddy CLI 与 Qoder CLI 属「Claude Code 兼容」类**：项目级都用 `.mcp.json`、同一份文件格式、同样的 `mcp__server__tool` 权限语法。但用户级是各自的 `~/.codebuddy.json` / `~/.qoder/settings.json`，**不直接复用 `~/.claude.json`**。
  - 实际好处：**同一个项目里的 `.mcp.json` 可以同时服务 Claude Code、CodeBuddy CLI、Qoder CLI**。
  - 坑（**未获第二个来源确认**）：有文档镜像称 **CodeBuddy 的项目级 `.mcp.json` 默认不生效**，需要放行——`"enableAllProjectMcpServers": true`，或用白名单 `"enabledMcpjsonServers": ["dsh"]`。独立复核时未能在另一份文档中找到该说法，官方只写「项目作用域首次连接需用户审批」。**走 user 作用域可以完全绕开这个不确定性。**
- **TRAE 的路径可用变量、超时也可控**：`args` 支持 `${workspaceFolder}`；`env` 里可设 `START_MCP_TIMEOUT_MS` / `RUN_MCP_TIMEOUT_MS`（stdio 启动慢时有用）。
- **Qoder CLI 是唯一列出 `ws` 传输的**（`-t stdio|sse|http|ws`），其余各家基本只有 stdio / SSE / Streamable HTTP。
- **没有任何一家官方文档声称会读 `~/.claude.json` 或 `~/.gemini/settings.json`**：真正可跨客户端复用的只有**项目级 `.mcp.json`**。
- Kimi 有两套并存文档（旧 Python 版 `~/.kimi`、新 Node 版 `~/.kimi-code`），别抄混。**通义灵码已更名为 Qoder CN**（文档域名仍是 `/help/zh/lingma/`），按新旧名字搜索都能找到。
- 扣子/豆包侧：**豆包客户端是否支持 MCP 未找到官方文档**，只有第三方 bridge。

照抄片段（Kimi Code CLI / MiniMax Code 通用，JSON 顶层 `mcpServers`）：

> **关于 `type` 字段**：MiniMax 与 CodeBuddy 的 stdio 条目需要显式写 `"type": "stdio"`；但 **Kimi 的官方 schema 并未收录 `type`**（有 `command` 即视为 stdio），另一份文档示例却写了它。两处均未实测，稳妥做法是**按各客户端官方文档写**，Kimi 先省略 `type`。下面片段保留 `type` 是为了覆盖 MiniMax/CodeBuddy 这类客户端。

```json
{
  "mcpServers": {
    "dsh": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"],
      "env": {
        "DSH_BIN": "%APPDATA%\\npm\\dsh.cmd",
        "DSH_WORKSPACE": "C:\\tools"
      }
    }
  }
}
```

ZCode 原生写法（注意是 `mcp.servers`）：

```json
{
  "mcp": {
    "servers": {
      "dsh": {
        "command": "node",
        "args": ["C:\\tools\\dsh-mcp-connector\\server.mjs"],
        "env": {
          "DSH_BIN": "%APPDATA%\\npm\\dsh.cmd",
          "DSH_WORKSPACE": "C:\\tools"
        }
      }
    }
  }
}
```

Step Code 写法（TOML）：

```toml
[mcp_servers.dsh]
command = "node"
args = ["C:\\tools\\dsh-mcp-connector\\server.mjs"]

[mcp_servers.dsh.env]
DSH_BIN = "%APPDATA%\\npm\\dsh.cmd"
DSH_WORKSPACE = "C:\\tools"
```

**智谱 Managed Agents（托管 Agent API 平台）只支持远程 MCP**——它的 `mcp_servers` 里 `type` 只能填 `"url"`（Streamable HTTP，必须公网 HTTPS），没有任何 stdio 字段。这类云端 agent 用 4.6 的 HTTP 模式 + 隧道。

### 4.9 别搞混：「厂商自己的 agent」vs「拿第三方客户端接国产模型」

| 厂商 | 官方文档让用哪个第三方客户端 | 关键端点 |
|---|---|---|
| 月之暗面 | Claude Code、OpenCode、Codex、Hermes Agent | `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/` |
| 智谱 / Z.ai | Claude Code、Codex、Cursor、Cline、Roo、TRAE、CodeBuddy、Lingma、Qoder、Zed 等 | `https://open.bigmodel.cn/api/anthropic` |
| MiniMax | Claude Code、Codex、Cursor、TRAE、OpenClaw 等 | `https://api.minimax.cn/anthropic` |
| 阶跃星辰 | Claude Code、Codex CLI、OpenCode、Cursor、Zed、Cherry Studio 等 | Step Plan 端点 |
| DeepSeek | Claude Code、Codex、OpenCode、Qoder 等 | `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` |

走这一类时，**MCP server 仍然配在 Claude Code 自己的配置里**（见 4.1），跟厂商文件无关。厂商文档里给的 `claude mcp add ...` 命令，接入的是**厂商发布的远程 MCP server**（如智谱 `web-search-prime`、阶跃 StepSearch），客户端还是 Claude Code —— 那不是「厂商 agent 支持了 MCP」。

两个实操提醒：

1. **智谱的 Gemini CLI 路径依赖第三方 fork**（官方明说 Gemini CLI 官方仓库只支持 Google 模型），不算原生兼容；其余国产厂商官方文档里没有 Gemini CLI 接入页。
2. **GLM Coding Plan 有风控**：官方限定套餐只能用于「官方支持的指定工具与环境」，非受支持工具调用可能被限流，多次违规可能封号。换客户端前先看官方支持列表。

### 4.10 本节未证实的内容（别当事实用）

- **智谱清言（chatglm.cn）、AutoClaw、跃问（阶跃 App）是否支持接入自定义 MCP**：未找到官方文档。
- **AutoGLM 方向相反**：智谱发布的是 `autoglm-mcp-server`（把 AutoGLM-Phone 暴露为 MCP **server**），不是客户端；来源为 npm / GitHub，非文档站收录，只算半官方。
- **商汤日日新 / 零一万物 / 昆仑万维天工 / 面壁智能**：未找到厂商官方 MCP 客户端文档。网上搜到的 `deepseek-mcp-server`、`glm-mcp`、`kimi-api-mcp` 等一律是第三方社区项目，**不能当厂商官方支持**。
- **DeepSeek 官方 App / 开放平台 API 明确不支持 MCP**：Anthropic 兼容端点的 `mcp_servers` 字段被忽略，`mcp_tool_use` / `mcp_tool_result` 内容块也不支持。
- **文档不一致处**：ZCode 的配置目录在自家文档里同时出现 `~/.zcode/cli/config.json` 与 `~/.zcode/v2/config.json`；Step Code 项目级 MCP 的两种说法冲突；Kimi 新旧两套文档并存（旧版官方已声明将停维护）。用之前以客户端实际读取结果为准。

**已核对完毕**（2026-10-01）。补充两条未证实项：

- **百度 Comate 文心快码**：官方手册 PDF 确认支持 STDIO / SSE / Streamable HTTP，但**配置文件路径与顶层键名未证实**（文档正文依赖 JS，抓取失败）。
- **讯飞 iFlyCode**：IDE 插件是否为 MCP 客户端**未证实**；已证实的只有「讯飞星辰 Agent 开发平台」支持接入 MCP Server，且**只填 Server URL（远程），不支持本地 stdio**。

多数国产 CLI 都提供 `mcp add` 子命令（`kimi mcp add`、`qwen mcp add`、`qoder mcp add`、`codebuddy mcp add`、`step mcp add`）。参数顺序各家不同，用 `<cli> mcp add --help` 确认后再抄——**改配置文件往往比记命令更省事**。

---

## 5. 工具说明

| 工具 | 参数 | 作用 |
|---|---|---|
| `dsh_ask` | `task`（必填）、`sessionId?`、`cwd?`、`timeoutMs?`（默认 900000）、`includeEvents?` | 把一条消息投给 DSH 并返回最终答案 |
| `dsh_cli_info` | 无 | 自检：报告解析到的 dsh 可执行文件与 `dsh --version` 退出码 |
| `connector_status` | 无 | 报告连接器自身状态：版本、传输、队列文件与任务计数、**哪些客户端连过（名字/版本/次数/最后活动时间）** |
| `task_claim` | `worker?` | 领取队列里最老的一条待办；空队列返回 `no pending task` |
| `task_complete` | `id`（必填）、`status?`（`ok`/`error`）、`result?` | 回报结果；**重复完成是幂等的**，所以重试安全 |
| `task_publish` | `task`（必填）、`source?` | 入队一条任务（生产者用） |
| `status_report` | `state`（必填：`start`/`progress`/`need-input`/`done`/`fail`）、`job`（必填）、`message?`、`step?`、`percent?` | **状态回报通道**：把一条状态事件写进 DSH Web 豆包徽章读的同一个 `status.jsonl`（spawn 现有的 `doubao-cdp/status.mjs`，不复制它的规则）。这是豆包桌面版本来就有的通道，普通 MCP 客户端没有——补上它，客户端干的活才会出现在徽章上，而不是只留在自己的对话里 |
| `task_list` | `state?`（`pending`/`claimed`/`done`/`all`）、`limit?` | 只读查看队列，不领取 |

`dsh_ask` 的返回末尾固定带一行 `sessionId: …`，把它记下来即可续会话。

在客户端里可以这样用（自然语言）：

> 用 dsh_ask 让本机 DSH 回答「仓库里有哪些包」，然后用返回的 sessionId 追加一句「只看前三个」。

### 5.1 任务队列：把「推送」变成「领取」

MCP 工具只在客户端自己的回合里被调用，**推不进去**。所以闭环做成拉取式：

```
生产者（DSH / 脚本 / HTTP）           消费者（豆包 / Kimi Code / 任意 MCP 客户端）
        │                                          │
        │  node queue.mjs add "任务"                │  task_claim    → 领到任务
        │  或 POST /tasks（--http 模式）             │  干活
        ▼                                          │  task_complete → 回报结果
   tasks.jsonl（追加型事件日志）  ◀─────────────────┘
```

生产端三种写法都行：

```powershell
node queue.mjs add "把 README 里的错别字改掉"     # CLI
node queue.mjs list pending                       # 查看
node queue.mjs file                               # 打印队列文件位置
```

```powershell
# --http 模式下，不必用 shell
curl -X POST http://127.0.0.1:8790/tasks `
  -H "Authorization: Bearer <token>" -H "content-type: application/json" `
  -d '{"task":"...","source":"dsh"}'
```

在客户端侧说一句「去任务队列领活干，干完回报」，它就会调 `task_claim` → 干活 → `task_complete`。

存储是**追加型 JSONL 事件日志**（`publish` / `claim` / `complete` 三类事件），状态由事件折叠得出：崩在写入中途最多丢最后半行，不会破坏已有历史。写入前还会检查日志是否停在行边界，**必要时补一个换行**——否则崩溃留下的半行会把下一条事件也粘成不可解析的一行（这个缺陷是被自测第 6 步抓出来的，先红后修）。跨进程互斥用日志旁边的原子锁目录，锁陈旧 30 秒可被抢占。

### 5.2 自观测：连接器知道自己被谁连过

每次收到 `initialize`，连接器会把客户端信息记到队列文件旁边的 `clients.json`（`clientInfo` 的名字/版本、传输、协议版本、连接次数、最后活动时间），`connector_status` 把它连同队列计数一起报出来：

```
connector: dsh-mcp-connector 0.1.0 (node v24.18.0, win32)
transport: stdio
queue file: ...\mcp-connector\tasks.jsonl
tasks: 0 total — pending 0, claimed 0, done 0
clients seen: 1
  - pipeliner@0.0.1 via stdio, 1x, last seen 0s ago
```

为什么值得记：**「我的连接器上到底有没有东西接着」从外面是看不出来的**。有了它，配置了五个客户端时能一眼看出谁真的连上了、谁只是配置里躺着。

**一个必须说清的边界**：客户端侧的 MCP 宿主进程可能在你没打开任何会话时就拉起连接器——所以「有客户端记录」只证明**连接发生过**，不证明**该会话里能用这些工具**。这正是在豆包上遇到的情形：连接器被拉起了，但会话的工具列表里没有它（详见 `doubao-cdp` 的说明）。

顺带修掉一个真竞态：早先版本里两条消息是并发处理的，客户端若**不等握手就继续发**（流水线），`connector_status` 会读到还没落盘的记账。现在 stdio 侧加了握手闸门——握手完成前到达的消息按顺序排队，之后恢复并发。

---

## 6. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BIN` | `dsh` | dsh 可执行文件路径；建议显式设置（npx 缓存路径会随版本变化） |
| `DSH_WORKSPACE` | 客户端启动目录 | DSH 会话的默认工作目录；建议显式设置 |
| `DSH_ASK_TIMEOUT_MS` | `900000` | 单次 `dsh_ask` 的默认超时 |
| `DSH_MCP_TOKEN` | 无 | `--http` 模式的 bearer token，等价于 `--token` |
| `DSH_MCP_HTTP_PORT` | `8790` | `--http` 模式的端口，等价于 `--port` |
| `DSH_MCP_TASKS_PATH` | `/tasks` | `--http` 模式的任务生产者路径，等价于 `--tasks-path` |
| `DSH_QUEUE_FILE` | `$DSH_HOME/mcp-connector/tasks.jsonl`，未设 `DSH_HOME` 时 `~/.dsh-mcp-connector/tasks.jsonl` | 任务队列的事件日志路径 |

---

## 7. 安全与限制（务必读）

1. **外部消息在 DSH 里看起来就是「用户本人发的」**。`session.prompt` 路径的 source 恒为 `{kind:'user'}`，DSH 的 `MessageSourceMap` 没有通用 plugin 来源。所以请在 `task` 文本里显式写明来源，例如 `[来自 Cursor 的外部请求] …`，否则会话历史里无法区分人与外部 AI。
2. **权限由 DSH profile 预设决定**。headless 会话默认继承 deployment 预设（本机是 `workspace-write`）。要让外部触发只读，需要在 profile 里配一个 `read-only` 预设，而不是靠这个 connector 控制。
3. **一次调用一个 DSH 进程**：没有会话池，长任务要用 `timeoutMs`；并发调用会各自新建会话。
4. **会话续接有前置条件**：`--session-id` 要求会话已持久化、cwd 与来源一致，否则 DSH 会报错。
5. **Windows 通过 cmd 启动** dsh（因为它是 `.cmd` shim）。任务文本不进 argv，所以不受引号规则影响。
6. **stdio 模式不鉴权，HTTP 模式强制 Bearer**：stdio 由客户端进程本身充当信任边界；`--http` 模式默认生成随机 token，且默认只绑 `127.0.0.1`，未列入白名单的 `Origin` 一律 403。要上公网请再套 TLS 反代/隧道，并换掉示例 token。
7. **队列不做鉴权，只做本地互斥**：任何能写 `DSH_QUEUE_FILE` 的本地进程都能入队或改状态。它是本机协作通道，不是权限边界；不要把队列文件放到共享目录。

---

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `spawn EPERM` | 你在受限沙箱里运行。自测需要管道捕获子进程输出，请在普通终端里跑 |
| `cannot run the dsh CLI (dsh)` | `dsh` 不在 PATH：设置 `DSH_BIN` |
| `unknown session id` | 会话 id 拼错、或不在同一个 `DSH_HOME`、或 cwd 不一致 |
| 超时被 kill | 调大 `timeoutMs`（长任务默认 15 分钟） |
| 返回空答案 | 结果里会附 stderr；多是模型/凭据未配置（headless 用的是你 DSH 账户的凭据） |
| 客户端列表里看不到 `dsh` 工具 | 先单独跑 `node server.mjs`，它应只在 stderr 打印一行 ready；若无输出，是命令/参数填错 |
| `--http` 起不来 | 端口被占：换 `--port`，或 `DSH_MCP_HTTP_PORT` |

---

## 9. 文件清单

| 文件 | 作用 |
|---|---|
| `server.mjs` | MCP 服务器（stdio + Streamable HTTP 双传输）+ headless 驱动 + 队列工具，零依赖 |
| `queue.mjs` | 任务队列模块与 CLI（追加型 JSONL 事件日志 + 原子锁），被 `server.mjs` 与命令行共用 |
| `selftest.mjs` | 自测：密封 profile 启动 + stdio 往返 + HTTP 传输 + 队列语义/并发 + 自观测，可选真实调用 |
| `package.json` | `npm start` / `npm test`（完整自测）/ `npm run test:offline`（CI 用）/ `npm run queue` |
| （运行时生成）`tasks.jsonl`、`clients.json` | 队列事件日志与客户端记录，都在 `DSH_QUEUE_FILE` 所在目录 |

已知边界：本 demo 驱动的是 `dsh --profile headless` 这条**一次性**通道，不具备「往 GUI 正在进行的那个会话实时投递」的能力。要做到后者需要 DSH 侧的常驻桥（`/ext/bridge`）或自写 host 插件。
