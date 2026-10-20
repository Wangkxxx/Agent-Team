# 设计说明

这套工具为什么长成现在这样。核对基准：**DSH `0.2.0-rc.2`**、2026-10-01。

文中引用一律用**包内稳定标识符**（`包/文件:行`），不用任何机器路径——装一份同版本 DSH 就能逐一复核。

---

## 1. 为什么必须有一个独立的桥

DSH 随发行体只带了 **MCP 客户端**，没有 MCP server 半区：

- `@deepseek-ai/` 下名字含 mcp 的包只有两个：`dsh-mcp-client`（连出去）、`dsh-mcp-resources`（读资源）。
- 没有 `dsh-mcp-server`，也没有任何包对外提供 MCP 服务。

它的 Web API 也不能直接给第三方程序用：

- `/api` 是 client-connection **独占注册的前缀路由**（`dsh-client-connection/lib/index.js`：`const API_PATH = "/api"`、`kind: "prefix"`）。
- 两道闸：`Host`/`Origin` 信任围栏失败返回 **403**，浏览器会话 cookie 校验失败返回 **401**（cookie 由 `GET /?token=` 换取，`HttpOnly; SameSite=Strict`，绑定 host+port）。

**结论**：想让别的 AI 程序给 DSH 发消息，必须自己提供一个桥。这就是 `dsh-mcp-connector` 存在的理由。

---

## 2. DSH 已有的机器入口面

| 入口 | 启动 | 协议 | 鉴权 | 关键限制 |
|---|---|---|---|---|
| **ACP** | `dsh --profile acp` | 标准 ACP v1：`initialize` / `authenticate` / `session/new` / `session/list` / `session/resume` / `session/close` / `session/prompt` / `session/cancel` | **无**（`authMethods: []`，文档称客户端即受信控制者） | 不支持 `session/load`、fork、modes、terminals、client fs 等 |
| **SDK stdio** | `dsh --profile sdk` | JSON-RPC：`initialize` / `session/prompt` / `shutdown`；通知 `session.event` / `session.status`（`dsh-sdk-protocol/lib/types/types.d.ts:98-113`） | 无（stdio 即边界） | 无 per-prompt 结果，无 session close/cancel |
| **headless** | `dsh --profile headless [task]`；`-` 读 stdin | 默认 stdout 只出最终答案；`--json` 出 NDJSON 事件流 | 无（进程内自驱动） | 一次性；`--json` 是有损投影 |
| **Webhook runtime** | 需挂 `@deepseek-ai/dsh-webhook` | `register(rule)` / `dispatch(delivery)` → **新建**会话 | 由适配器负责 | 只能新建会话；fire-and-forget，无去重、无回执 |
| **Web API** | `dsh web` | `/api` + Typert Remote + WebSocket | cookie + Host/Origin 围栏 | 第三方进程难以持有 cookie |

现成的 webhook 适配器只有 GitHub 一个：`dsh-webhook-github` 要求 `secretEnv`（credential-ref，必填）、`maxBodyBytes`（必填）、头 `x-hub-signature-256`，用 `ctx.webServer.register` 注册路由（`dsh-webhook-github/lib/index.js:170-190`）。

---

## 3. 为什么桥选了 headless

三个候选里，headless 是唯一「一行命令拿到答案」的：

- **Web API** —— 要 cookie、要过 Host/Origin 围栏，且绑定的是「浏览器客户端」语义，不是给机器用的。
- **ACP / SDK** —— 都是一等公民的机器接口，但需要常驻进程 + 完整握手 + 事件消费，对「投一条消息、拿回答案」这个最小诉求过重。
- **headless** —— `dsh --profile headless --json -`：任务走 stdin，事件走 stdout，最后一行是 `{type:"final", text}`。

**一个刻意的设计**：任务文本**永远走 stdin**（传 `-`），绝不进 argv。这样含空格、引号、换行的中文任务在 Windows 上不会被 cmd 的引号规则破坏。

代价也明确：headless 是**一次性**的，做不到「往正在跑的 GUI 会话里实时投递」——那需要 `/ext/bridge` 一类的常驻桥或自写 host 插件。

**Windows 上还多一层麻烦**：CLI 是 `.cmd` shim，Node 必须经 shell 启动；而 shell 报错时吐的是**控制台代码页**（中文系统上是 GBK），按 UTF-8 解会变成乱码——用户看到的是 `ϵͳ�Ҳ���ָ����·����` 而不是「系统找不到指定的路径。」。所以 stderr 以字节收集，仅在 UTF-8 解码出现替换字符时改用 GBK 重解。

---

## 4. 为什么队列是「拉」而不是「推」

MCP 工具**只在客户端自己的回合里被调用**。服务端没有任何办法唤醒客户端去执行一条工具调用——所以「推任务给客户端」在协议层就不成立。

能自动化的唯一形状是**拉取**：

```
生产者（DSH / 脚本 / HTTP）──入队──▶ tasks.jsonl
                                        ▲
消费者（任意 MCP 客户端）──task_claim───┘──工作──task_complete──▶ 结果回传
```

存储选的是一条**追加型 JSONL 事件日志**（`publish` / `claim` / `complete`），状态由事件折叠得出：崩在写入中途最多丢最后半行，不会破坏已有历史。写入前会检查日志是否停在行边界并补上缺失的换行——否则崩溃留下的半行会把**下一条**事件也粘坏，那就不是「丢半行」而是丢两条。跨进程互斥用日志旁的原子锁目录，锁陈旧 30 秒可被抢占。

领取语义是被自测钉住的：**最老的待办优先**、**一条任务不会被发两次**（6 路并发领取拿到 6 个不同任务）、**重复完成是幂等的**（重试安全）。

---

## 5. 两个方向，合规结论相反

**方向 A：外部 AI 当客户端连你的 MCP server —— 合规。** 自定义远程 MCP 连接器、Claude Code 的 HTTP hook、各编辑器的 MCP 客户端，都是官方文档明确支持的功能。

**方向 B：把订阅登录态当第三方 harness 的模型来源 —— 违规。**

- Anthropic 官方文档明确 Free/Pro/Max 的 OAuth token 只能用于 Claude Code 与原生应用，**不允许第三方开发者代他人经订阅凭证中转请求**；2026-04 起第三方工具需额外付费，2026-05 推出 Agent SDK credits。
- Google 的 Gemini CLI 条款逐字禁止用第三方 harness（点名 OpenClaw）走其 OAuth，写明「可能导致账号暂停或终止」；2026-02 已有封号先例。

**因此本仓库的两个工具都只做「消息投递」**，不碰模型后端。要给 DSH 换模型，走 API key 或厂商官方 credits 通道。

---

## 6. 各 MCP 客户端的配置差异

已核对的国产官方客户端**全部支持本地 stdio**，区别只在配置文件位置与顶层键。完整矩阵（17 家，含证据等级与「未证实」标注）见
[`skills/dsh-mcp-connector/references/client-configs.md`](../skills/dsh-mcp-connector/references/client-configs.md)。

最容易抄错的三处：

| 客户端 | 坑 |
|---|---|
| ZCode（智谱） | 顶层键是 **`mcp.servers`**，不是 `mcpServers` |
| Step Code（阶跃） | **TOML** `[mcp_servers.<名>]`；工具名会变成 `dsh__dsh_ask` |
| 扣子 Coze / 讯飞星辰 | 官方**不支持 stdio**，只能走远程 HTTP |

---

## 7. 已知失败模式

**客户端会「编造工具调用」。** 实测：把任务投进队列，通过 CDP 让豆包「用 task_claim 领取并 task_complete 回报」，它回复

> 已调用 dsh 连接器 task_claim 领取队列任务，执行完毕后通过 task_complete 上报 status 为 ok

而事实是：队列里那条任务仍是 `pending`、没有任何 claim/complete 事件；豆包的 `agent_infra` 目录里没有任何任务执行记录；让它列出自己的工具，返回的是

```
general_search、web.fetch、scholar_search、image_*、calculator、
doubao_code_interpreter、operate_saved_memory、poi.route_plan、medical_search
```

——**里面没有 `dsh_ask` / `task_claim`**。根因是连接器没在该会话里启用；模型在工具不可用时不会报错，而是编一个成功的调用记录。

由此定下一条硬规则：**任何「我已经调用 X 了」都必须回到副作用去核实**（队列事件、文件、日志）。`doubao-cdp/dispatch.mjs` 就是按这条写的——它只在队列记录到完成时才退出 0。

**其他已知边界**：

- 外部投递的消息在 DSH 内以 `{kind:"user"}` 进入会话，**与真人输入不可区分**。
- `connector_status` 里的「有客户端记录」只证明**连接发生过**，不证明该会话里能用这些工具。
- 用户级配置目录（`$DSH_HOME` 是否设置）会影响队列文件落点；生产者和消费者必须解析到同一个文件。
- 队列本身**不做鉴权**，只做本地互斥——它是本机协作通道，不是权限边界。

---

## 8. 未证实 / 易过期

- **ChatGPT / Codex 的 MCP 连接器细节**：核对期间 `openai.com`、`developers.openai.com`、`help.openai.com`、`platform.openai.com` 全部返回 403，**官方一手文档一条都没取到**，故本仓库不据此做任何承诺。
- **百度 Comate**：官方手册确认支持 STDIO/SSE/Streamable HTTP，但配置文件路径与顶层键名未证实。
- **讯飞 iFlyCode**：IDE 插件是否为 MCP 客户端未证实。
- **智谱清言 / AutoClaw / 跃问 / 豆包客户端**是否支持接入自定义 MCP：未找到官方文档。
- **AutoGLM 方向相反**：智谱发布的是 `autoglm-mcp-server`（MCP **server**），不是客户端。
- **厂商文档本身存在不一致**：ZCode 的配置目录在同站文档里出现两个路径；Step Code 项目级 MCP 有两种说法；Kimi 新旧两套文档并存。使用前以客户端实际读取结果为准。

---

## 9. 这套设计的验收方式

不靠人工确认，靠可复现的断言：

| 层 | 命令 | 覆盖 |
|---|---|---|
| 连接器 | `node selftest.mjs` | 61 项：profile 首次初始化、stdio 往返、HTTP 鉴权与生产者路由、队列语义与并发、自观测与握手闸门、边界与失败分支（允许的 Origin、自定义生产者路径、畸形请求体、`limit`、超大结果截断、崩溃半行、陈旧锁抢占、超时杀进程、GBK 输出解码、前置校验与失控输出中止） |
| 连接器（离线） | `node selftest.mjs --offline` | 58 项 + 2 跳过：不需要本机装 DSH |
| 派发器 | `node doubao-cdp/dispatch-selftest.mjs` | 22 项：成功路径必须 `VERIFIED`、失败路径必须 `UNVERIFIED`、发送前预检按客户端记录报警或放行 |
| 豆包启动确认 | `node doubao-cdp/preflight-selftest.mjs` | 14 项：端口关闭 / 端口通但无匹配页面 / 就绪 / `--no-preflight`，以及「确认失败不得留下孤儿任务」 |
| 注册助手 | `node scripts/register-selftest.mjs` | 41 项：每个客户端的键路径与条目形状、合并而非覆盖、重复注册不产生重复项、`--dry-run` 不落盘、TOML 段落替换与后续表格保全、`--client all` |
| 状态回报 | `node doubao-cdp/status-selftest.mjs` | 28 项：固定词表、ini 开关与静默 no-op、限流、截断、终态、崩溃半行、忙闲与疑似卡死 |
| 调用前识别 | `node doubao-cdp/preflight-selftest.mjs` | 23 项：五维 + 三态判定 + 模式不匹配/忙闲拒绝 + `--force` 留痕 |
| 状态推送 | `node doubao-cdp/status-push-selftest.mjs` | 16 项：只推阶段转换、游标幂等、缺会话明确报错、只建一次会话 |
| 全部 | `npm test`（仓库根） | 上面六套，退出码 0 |

后三项都不需要 DSH、也不需要豆包，所以在 CI 上跑得起来（`.github/workflows/ci.yml`）。
