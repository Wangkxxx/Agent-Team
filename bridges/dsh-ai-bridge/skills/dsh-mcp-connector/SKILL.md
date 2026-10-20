---
name: dsh-mcp-connector
description: 把外部 AI 客户端接到本机 DeepSeek Harness，以及用队列/派发器把活派出去时的**调用方法手册**。Use when an external AI client (Claude Code, Cursor, VS Code, Codex, Kimi Code, CodeBuddy, Qoder, TRAE, ZCode, Step Code, MiniMax Code, Coze) must send messages to a local DSH over MCP, when dsh tools are missing from a client's tool list, when registering the connector into a client, when queueing tasks for a client to pull, when dispatching work to the Doubao desktop app, or when asked how to use / 怎么调用 / 调用方法 for the DSH connector or bridge. 中文触发：怎么用 dsh 连接器、给 DSH 发消息、把任务派给豆包、外部 AI 接 DSH、注册 MCP 客户端、连接器自测、工具列表里看不到 dsh。
---

# DSH 桥 · 调用方法手册

**本机已有一份可用的实现，不要重写。** 这份手册解决一件事：重启之后不用重新推导怎么调用。

| 位置 | 路径 |
|---|---|
| 工作副本（实时） | `C:\tools\dsh-mcp-connector\`、`doubao-cdp\`、`dsh-ai-bridge\`（可发布副本） |
| 已发布仓库 | https://github.com/ganmayou2333/dsh-ai-bridge |
| 入口 | `dsh-mcp-connector/server.mjs`（零依赖，Node ≥ 20） |

---

## 0. 三十秒速查

```powershell
# 它还好不好？（不花模型额度）
cd C:\tools\dsh-mcp-connector ; node selftest.mjs      # 61 项断言，退出码 0
cd C:\tools\dsh-ai-bridge    ; npm test               # 六套，不需要 DSH 也能跑

# 派发前先识别（五维；0=可发 3=未就绪 8=无法识别，都拒绝发送）
cd C:\tools\doubao-cdp ; node cdp.mjs doctor

# 豆包的状态回报（工作开始/结束）→ 见第 6 节
node C:\tools\doubao-cdp\status.mjs list

# 注册进某个客户端（先 --dry-run 看要写什么）
node C:\tools\dsh-ai-bridge\scripts\register.mjs --list
node C:\tools\dsh-ai-bridge\scripts\register.mjs --client cursor --dry-run

# 给 DSH 发一条消息（外部 AI 通过 MCP 调 dsh_ask；直接命令行验证则用 headless）
dsh --profile headless --json -    # 任务走 stdin，最后一行是 {type:"final", text}

# 把任务排进队列，让 MCP 客户端来领
node C:\tools\dsh-mcp-connector\queue.mjs add "任务文本"

# 把任务派给豆包（带副作用校验，只在队列记录到完成时才算成功）
cd C:\tools\doubao-cdp
node dispatch.mjs "任务文本" --queue --timeout 300000

# 派给「会来领活的 MCP 客户端」（豆包工作这类）：拉取式，先体检再派
# 体检退出码 0 就绪 / 3 未就绪 / 8 无法判定
node <repo>\scripts\check-doubao-work.mjs
# 派发器：先前置确认再入队（确认不过退 3 且**不留孤儿任务**）
# 退出码 0 完成 / 2 超时未核实（不是成功）/ 3 未就绪或报错 / 5 无此 id
node <repo>\scripts\dispatch-work.mjs "任务文本" --timeout 600000
# 一条命令验收：接线就绪 + 任务真被完成 + **结果带回 ACCEPT- 标记**才算通过
# 退出码 0 通过 / 2 未完成（不是成功）/ 3 未就绪或没带标记 / 5 无此 id
node <repo>\scripts\accept-doubao-work.mjs --timeout 600000
```

---

## 1. 八条 MCP 工具（客户端看到的就是这些）

| 工具 | 作用 |
|---|---|
| `dsh_ask` | 投一条消息给 DSH，返回最终答案 + `sessionId`；把该 id 传回来可续接同一会话 |
| `dsh_cli_info` | 自检：解析到的 dsh 可执行文件与 `dsh --version` 退出码 |
| `connector_status` | 自观测：版本、传输、队列路径与计数、**哪些客户端连过**（名字/版本/次数/最后活动） |
| `task_publish` | 入队一条任务（生产者） |
| `task_claim` | 领取最老的待办任务（消费者），返回 id 与任务文本 |
| `task_complete` | 回报结果（幂等，可安全重试） |
| `status_report` | **状态回报通道**：`start`/`progress`/`need-input`/`done`/`fail` + `job` 写进 DSH Web 豆包徽章读的 `status.jsonl`（内部 spawn `doubao-cdp/status.mjs`）。客户端干了活要出现在徽章上就调它——只在对话里说「已完成」不算证据 |
| `task_list` | 查队列状态 |

**客户端侧工具清单是懒加载的**（实测：同一个豆包工作连接器先是只列 3 个、后来列 6 个，而服务端一直是 8 个）；
**改完服务端要让它重连**（新开对话 / 关开连接器），否则它继续用旧快照。
工人配方按它**看得见**的工具选：有 `task_claim` 就 `claim → 干活 → status_report → task_complete`；
**没有 `task_claim` 也能干**——`task_list state=pending` 拿 id → 干活 → `task_complete`
（不 claim 直接 complete 是允许的，已密封测试；claim 只用于多消费者互斥）。
若 `status_report` 也看不见，干活过程就进不了徽章，除非它有终端能力直接跑 `status.mjs`。

三件事必须记住：

1. **投递进来的消息和真人输入不可区分**（源都是 `{kind:"user"}`）——任务文本里要自带来源标记。2. **headless 是一次性的**，不能往正在跑的 `dsh web` GUI 会话里实时注入。
3. **队列是拉取式的**：MCP 工具只在客户端自己的回合里执行，所以服务端没法「推」任务给客户端。

---

## 2. 三条常见调用路径

### A. 让某个 AI 客户端能给 DSH 发消息

```powershell
node <repo>\scripts\register.mjs --client <cursor|vscode|codex|zcode|kimi-code|codebuddy|minimax|qwen|qoder|stepcode|doubao-work> [--dry-run]
```

统一形状是「命令 `node` + 参数 `<abs>/server.mjs` + 环境 `DSH_BIN` / `DSH_WORKSPACE`」，差别只在各家顶层键：

`doubao-work`（**豆包工作**，字节另一个本机桌面 App，和 CDP 驱动的豆包个人版不是同一个）
是唯一一个**不写文件**、也不走 stdio 的：它在 App 内「技能 · 连接器 · 伙伴」里配置，
传输类型选 HTTP（streamable-http）+ 自定义 Headers，所以脚本只打印要粘贴的
`{"mcpServers":{...}}`、启动命令与验证方法；本机 App 用 `http://127.0.0.1:8790/mcp` 即可，不需要隧道。

| 客户端 | 坑 |
|---|---|
| ZCode（智谱） | 顶层是 `mcp.servers`，**不是** `mcpServers` |
| Step Code / Codex | **TOML** `[mcp_servers.dsh]`；Step Code 里工具名会变成 `dsh__dsh_ask` |
| MiniMax / CodeBuddy | stdio 条目要显式 `"type": "stdio"` |
| VS Code | 项目级 `.vscode/mcp.json`，键是 `servers` |
| Coze / 讯飞星辰 | 官方**不支持 stdio**，只能走 HTTP |
| Claude Code | 配置由 CLI 管理，脚本不写文件，只打印 `claude mcp add` 命令 |

云端客户端用 HTTP 模式：`node server.mjs --http --port 8790 --token <t>`，端点 `POST /mcp`，头 `Authorization: Bearer <t>`；跨机必须加 HTTPS 隧道。详见 `references/client-configs.md`。

### B. 把活排进队列，等客户端来领

```powershell
node queue.mjs add "整理这份清单"        # 或 POST /tasks（HTTP 模式）
node queue.mjs list                      # 看状态
# 派出去并等它干完（拉取式这条线的 `dispatch --queue` 等价物）
# 只看队列里的 complete 事件，不采信客户端自述；退出码 0 完成 / 2 超时未核实 / 3 完成但报错 / 5 无此 id
node queue.mjs add "整理这份清单" --wait --timeout 600000
node queue.mjs wait <id> --timeout 600000
# 客户端侧：task_claim → 干活 → task_complete
```

队列文件：`$DSH_HOME/mcp-connector/tasks.jsonl`，没有 `DSH_HOME` 时退回 `~/.dsh-mcp-connector/tasks.jsonl`；**生产者与消费者必须解析到同一个文件**。它是追加型事件日志，状态由事件折叠得出；领取语义是最老优先、不会重复发放、重复完成幂等。

### C. 把任务派给豆包桌面版

```powershell
cd C:\tools\doubao-cdp
node cdp.mjs doctor                          # 先确认豆包可被驱动（就绪退 0，未就绪退 3）
node dispatch.mjs "任务"                     # 聊天模式：发进去、读回回复
node dispatch.mjs "任务" --queue --timeout 300000   # 队列模式：入队→指令→轮询队列直到完成
node dispatch.mjs "任务" --queue --no-send   # 只验校验逻辑，不碰聊天（这条不需要豆包）
```

退出码：`0` 已核实 / `2` 未核实 / `1` 硬错误 / **`3` 豆包未就绪**。

**每条命令连接前都会先做启动确认**，失败时会给可操作的报告（原来的报错只有一句 `error: fetch failed`，什么也说明不了）。三种状态处理方式不同：

| 状态 | 怎么办 |
|---|---|
| 豆包没运行 | 带参数启动它 |
| **豆包在运行但没开调试端口**（最常见） | 正常启动的豆包驱动不了，**必须退出后用 `--remote-debugging-port=9222` 重启** |
| 端口通但没有匹配页面 | 豆包停在别的视图，`node cdp.mjs targets` 看现有页面 |

确认只检测与说明，**不会替你结束或重启豆包**。跳过用 `--no-preflight`（不推荐）。队列模式下确认在**入队之前**跑，所以确认失败不会留下孤儿任务。

---

## 3. 唯一可信的验证方式：看副作用

**客户端会编造工具调用。** 实测：豆包回复「已调用 task_claim…status 为 ok」，而队列里那条任务仍是 `pending`、没有任何 claim/complete 事件。根因是连接器没在该会话启用——让它列工具时返回的清单里**根本没有 `dsh_ask` / `task_claim`**。

所以：

- 说「我调用了」→ **不算证据**。要看队列事件、`clients.json`、文件、日志。
- 派发器已内置这条规则（只在队列记录到完成时才退出 0），并在发送前按 `clients.json` 预检。
- `connector_status` 里的「有客户端记录」只证明**连接发生过**，不证明该会话里能用这些工具。

排查顺序：

```
1. node selftest.mjs                         # 桥本身是否完好（61 项）
2. 客户端里能否列出 dsh_* 工具                 # 列不出来 = 连接器没启用
3. connector_status / clients.json           # 到底有没有客户端连过来
4. 队列事件                                   # 活到底有没有被领走、有没有完成
```

---

## 4. 这台机器上的既有事实

- 已发布仓库：`ganmayou2333/dsh-ai-bridge`，主分支 `main`；提交邮箱用 GitHub noreply（否则 push 会被 GH007 拒）。
- 真实握手证据：`claude-code@2.1.226` 曾完成 MCP 握手（记录在 `clients.json`，协议 `2025-11-25`）。
- **已验证（2026-10-16）**：真实客户端**成功调用工具** —— **豆包工作**按 HTTP 路径接上后调用 `task_publish`，
  `tasks.jsonl` 真的多了一条（id 与它回报的一致）。它在 `clients.json` 里自报名 **`rmcp 3.2.0`**、
  `transport: http`（**不是** `DoubaoWork`）。注意：它在会话里**只列出 3 个工具**
  （`dsh_ask` / `dsh_cli_info` / `task_publish`），服务端实际有 7 个——所以它目前只能**生产**任务，
  不能领队列活。配置见连接器 README 的 4.6.1。
- 测试规模：连接器 61 项（离线 58+2 跳过）、派发器 15 项、注册助手 41 项。
- **HTTP 端点已常驻**（2026-10-16）：`127.0.0.1:8790`，由启动文件夹
  `%APPDATA%\...\Startup\DSH-MCP-HTTP.vbs` → `%USERPROFILE%\.dsh\mcp-connector\start-http.cmd` 拉起，
  经 ASCII 联接 `%USERPROFILE%\.dsh\plugins`（用于兼容不支持非 ASCII 路径的命令行工具），启动器里带
  `--preserve-symlinks --preserve-symlinks-main`（否则 node 解析真实路径导致主模块检查失败、静默退出 0）。
  **启动器带自愈循环**（进程崩了 5 秒后自己回来，实测杀掉后 12 秒内新 PID 继续服务），
  输出与重启记录写在 `%USERPROFILE%\.dsh\mcp-connector\http-endpoint.log`。
  计划任务那条路需要管理员。详见连接器 README 4.6.3。
- **静默空转陷阱**：`server.mjs` 与 `doubao-cdp/status.mjs` 都有「主模块检查」
  （`import.meta.url === pathToFileURL(process.argv[1]).href`）。经符号链接/联接调用时 node 会把入口解析成
  真实路径，两边不等 → **退出 0 但什么都不做**。所以：跑 `server.mjs` 要 `--preserve-symlinks*`，
  而它 spawn `status.mjs` 时要用 `realpathSync` 后的真实路径（`resolveStatusScript` 已这么做）。
  **别只看退出码**——这个坑会让 `status_report` 报成功却没有事件落盘。
- 豆包的 9222 调试端口意味着**本机任意进程都能接管它**，不用时退出豆包正常启动即可关闭。
- npx 缓存里的 `dsh.cmd` 路径带版本号、不稳定；优先用全局安装的 `%APPDATA%\npm\dsh.cmd`。

## 5. 合规红线（不要跨越）

- 方向 A（外部 AI → DSH 投消息）合规。
- 方向 B（把订阅登录态当第三方 harness 的模型后端）**违规**：Anthropic 明令禁止代他人经订阅凭证中转；Google 对第三方 harness 走 OAuth 有封号先例。要给 DSH 换模型，走 API key。

## 6. 豆包状态回报（工作开始 / 结束）与调用前识别

### 6.1 硬规则：每次派发前先识别

```powershell
cd C:\tools\doubao-cdp
node cdp.mjs doctor          # 五维：连通 / 模式 / 命令能力 / 忙闲 / 通道
```

| 退出码 | 含义 | 怎么办 |
|---|---|---|
| `0` | 可以发 | 正常派发 |
| `3` | 未就绪 | 报告里逐条写了原因，修完重跑 |
| `8` | **无法识别** | 读不到模式等关键信息——**同样拒绝发送**，不要猜 |

**识别不过就不要发。** 确实要发才加 `--force`，它会在状态文件里留一条 `override` 记录（事后能回答「为什么这次没拦住」）。

忙闲的依据是状态文件：**有 `started` 没有 `done/failed` = 忙**，此时拒绝并发注入（会与人工操作互相干扰，且回复归属不清）。超过 10 分钟无事件则标为「疑似卡死」。

### 6.2 状态契约：队列模式**自动带**，手动派发用下面的模板

```powershell
# 队列模式：契约由 buildQueueInstruction() 自动拼进指令，不用手贴
node dispatch.mjs "任务" --queue --timeout 300000

# 聊天模式：默认不带，需要时加 --status
node dispatch.mjs "任务" --status
```

手动派发（或想自己发指令）时，把下面这段连同任务一起给它（`<JOB>` 用派发标记，如 `DISPATCH-a1b2c3`）：

> **开始真正执行命令之前**，先运行这条命令（不要只在回复里说"我开始"）：
> `node "C:\tools\doubao-cdp\status.mjs" start --job <JOB>`
>
> 干活过程中要报进度：`… progress --job <JOB> --percent 50 --step "步骤名"`
> 需要我确认才继续：`… need-input --job <JOB> --message "在等什么"`
> 结束时：`… done --job <JOB> --message "结果摘要"`
> 出错时：`… fail --job <JOB> --message "错误摘要"`
>
> 结论必须由事件体现：**只回复"已完成"不算数**。做不到（比如这个模式没有 PowerShell）就直说做不到。

**对话模式下没有 PowerShell**，这套状态回报不成立——识别会直接拦下来（`3`）。

派发器在等待期间会**实时打印** `[状态] 工作开始 · …`；完成后若队列说完成、但状态文件里没有 `started`，它会点出「这条完成的成色要打折」。

### 6.3 读取与推送

```powershell
node status.mjs list              # 时间线（可按 --job 过滤）
node status.mjs open              # 谁还在跑；退出码 6 = 有未结束
node status.mjs last <JOB>        # 最后状态；未知 job 退 5
node status-push.mjs --once       # 把阶段转换推进 DSH 工作台会话
```

推送**只推阶段转换**（`started` / `need_input` / `done` / `failed`），`progress` 留在文件里——每次推送都是一次真实模型调用，一个 10 分钟任务约 4 次而不是几百次。没配会话时它会明确报错，不会静默丢。

### 6.4 配置：`doubao-status.ini`

放在状态文件同目录（默认 `$DSH_HOME\mcp-connector\`），改完**立即生效**，不用重启。样例见 `doubao-status.ini.sample`。控制项：状态文件路径、启用哪些状态、正文上限、限流间隔、推送开关与目标会话。

- 找不到/读坏 ini → 用内置默认值 + **明确告警**，不会因为配置问题丢状态。
- 被 ini 关掉的状态：调用它是**静默 no-op**（退出 0、无输出），不打断豆包干活。
- `started` / `done` / `failed` **永不因限流被丢弃**。

### 6.5 默认数值

| 项 | 默认 |
|---|---|
| 正文上限 | 500 字符 |
| 同状态最小间隔 | 2 秒（`progress` 放宽到 10 秒） |
| 忙闲判定 | 有 `started` 无终态即算忙；10 分钟无事件算疑似卡死 |
| 识别缓存 | 模式读取 30 秒内可复用（连通性/忙闲每次重算） |

---

逐客户端的完整路径、片段与「已证实/未证实」分级见 `references/client-configs.md`。
