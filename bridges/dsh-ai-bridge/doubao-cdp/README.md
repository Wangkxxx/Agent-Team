# doubao-cdp

用 Chrome DevTools Protocol 驱动**豆包桌面版**（Electron），把任务直接下发到它的聊天框，并读回回复。

零依赖：Node 24 自带全局 `WebSocket`，直接跟 CDP 通信，不需要 puppeteer / playwright。

## 前提：豆包必须带调试端口启动

CDP 只在启动时决定，运行中的实例无法挂载。所以需要（一次）：

```powershell
Get-Process Doubao -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "E:\Doubao\app\Doubao.exe" -ArgumentList '--remote-debugging-port=9222','--remote-allow-origins=*'
```

验证：

```powershell
Invoke-WebRequest http://127.0.0.1:9222/json/version
```

恢复常态（关掉调试端口）：退出豆包后正常启动即可，不要带参数。

## 同一套工具也能驱动「豆包工作」（2026-10-16 实测）

豆包工作（`E:\DoubaoWork\app\DoubaoWork.exe`，Chromium 147）**同样认调试端口**，只是启动参数不同：

```powershell
Get-Process DoubaoWork -ErrorAction SilentlyContinue | Stop-Process -Force
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"E:\DoubaoWork\app\DoubaoWork.exe" --registry-web-browser --remote-debugging-port=9223 --remote-allow-origins=*'
}
```

（用 WMI 是为了让它**不在 DSH 进程树里**——DSH 重启不会带走它；`--registry-web-browser` 是它自己正常启动时带的参数。）

它的主聊天页是 `doubaowork://doubaowork-chat/chat`，所以**本目录的工具零改动就能用**，
加一个 `--target work` 即可（`--target` 压过环境变量；`--port/--match` 又能压过 `--target`）：

```powershell
node cdp.mjs state  --target work   # 本地电脑（work）· 命令能力 yes · 豆包 2.1 Lite · 档位 低
node cdp.mjs models --target work   # 豆包 2.1 Lite(0921 新版, 当前) / 2.1 Pro / 2.1 Turbo(即将下线)
node cdp.mjs quota  --target work   # 0%（体验套餐）· 剩余重置 1 次 —— 它的界面没有个人版的额度页，所以是**降级读法**
node cdp.mjs doctor --target work   # 五维全过 → ✓ 可以发送（报告头会写明用的是哪个目标）
```

不带 `--target` 时默认个人版（9222）；老的环境变量用法（`CDP_PORT` / `CDP_MATCH`）仍然有效。

**移植现状（2026-10-16 实测，个人版的能力 → 豆包工作）**：

| 个人版的能力 | 豆包工作 |
| --- | --- |
| 读模式 / 模型 / 命令能力 | ✅ `state --target work` |
| 读模型清单 | ✅ `models --target work`（3 项，当前 2.1 Lite 带 `0921 新版`） |
| 调用前识别（五维） | ✅ `doctor --target work` → ✓ 可以发送 |
| **对话派发** | ✅ **实测**：`send "请只回答：2+2 等于几？" --target work` → `wait` 读到答复 **4** |
| **读上下文用量** | ✅ **纯读、不开菜单**：`usage --target work` 读取上下文圆环的角度，并按 `角度 / 360` 换算百分比。**两个 App 都有这个控件，但只在打开的对话里出现**；没开对话时会如实说「没有打开的对话」，而不是谎称「这台 App 没有」，并退 3。这个读数是**每次对话的上下文用量**，不是账户额度 |
| **读上下文明细** | ✅ `context-window --target work` 返回当前会话的上下文用量及分类明细；文档和测试使用合成样例 |
| 读额度 | ✅ **点开上下文窗口就能读**：`context-window --target work` 提供「当前时段」与「近 7 天」两个计数窗口。公开示例使用合成数字；`quota --target work`（账户菜单那条）仍是降级读法，两者语义不同，别混 |
| ~~读额度（旧结论）~~ | ⚠️ ~~只能降级~~：`quota --target work` 给账户菜单那一个数字（它的界面里没有个人版那个额度页） |
| 切模式（写操作） | ⛔ **不适用**：工作版是把个人版**去掉「对话」模式**构建的（不是菜单藏了、也不是选项名不同），所以没有「对话/工作」两态可切；`mode chat --target work` 如实报「菜单里没找到目标选项」并退 1，只读复核确认状态未被改动。注意「去掉对话」≠「不能收发消息」：工作会话照常收发（实测发「2+2」读回「4」）|
**想让它一直可读**（否则你正常启动它时端口是关的，读不到）：

```powershell
node ..\scripts\doubao-work-debug.mjs --status    # 只读：在跑吗？9223 通吗？
node ..\scripts\doubao-work-debug.mjs --restart   # 关掉再带端口拉起（会打断它正在做的事）
```
`doctor` 的报告头会打印「目标 · 端口 · 匹配 · 来源」，避免读错了 App 还不知道。

**能移植的现实**：读数（模式/模型/清单）、切模式、往对话里发任务并读回复，这套都成立；
额度只能拿到账户菜单那一个数字（个人版的多窗口额度页在它的界面里不存在，`quota` 会标 `degraded`）。
`9223` 与 `9222` 一样意味着**本机任意进程都能接管它**，不用时正常重启即可关闭。

## 用法

```powershell
cd <本目录>
node cdp.mjs targets              # 列出所有 CDP 目标
# 任何命令都可以带 --target personal|work 选 App（默认 personal = 豆包个人版）
node cdp.mjs state --target work  # 读豆包工作（9223）
node cdp.mjs doctor               # 连接前确认：豆包是否可被驱动（不连也行）
node cdp.mjs state [--json]       # 只读快照：当前模式 + 当前模型（给状态面板用；永远是读数，不是闸门）
node cdp.mjs mode work|chat       # 切换模式（写操作：点豆包 UI，点完用只读读数复核）
node cdp.mjs quota [--json]       # 只读采样：5h/7d 两个额度窗口 + 可重置次数 + 套餐（要走 App 内的额度页；读不到降级成账户菜单那一个数字）
node cdp.mjs models [--json]      # 只读采样：可选模型清单 + 当前项 + 状态标注（要点开模型菜单）
node cdp.mjs probe                # 找输入框候选
node cdp.mjs send "任务文本"      # 聚焦输入框 → 插入文本 → 点发送 → 确认已提交
node cdp.mjs wait 120000          # 等这一轮答复稳定，打印回复
node cdp.mjs read 6               # 读最近 n 条消息（标注 user / assistant）
node cdp.mjs click <x> <y>        # 真实鼠标点击
node cdp.mjs key s --ctrl --shift # 原生按键（合成 KeyboardEvent 会被应用忽略）
node cdp.mjs eval "<js>"          # 在页面求值
```

一次完整的下发：

```powershell
node cdp.mjs send "帮我查一下明天上海天气" ; node cdp.mjs wait 180000
```

`send` 成功时会打印 `sent via send button: ...`；若输入框没清空会直接报错，不会假装成功。

## 连接前先确认：`doctor` 与退出码 3

**每一条命令在连豆包之前都会先做一次启动确认。** 原因很实际：原来的失败长这样——

```
error: fetch failed
```

这句话没告诉用户任何事情，而实际上有三种完全不同的状态，处理方式也完全不同：

| 状态 | 说明 |
|---|---|
| 豆包没运行 | 去启动它 |
| **豆包在运行，但没开调试端口** | 它当初是正常启动的，**必须带参数重启**才能被驱动（最常见） |
| 端口通但没有匹配的页面 | 调试开着，但豆包停在别的视图（启动页 / 登录页） |

确认失败时打印的是这种可操作的报告，而不是 `fetch failed`：

```
豆包启动确认
  调试端口 127.0.0.1:9222 : 未监听（ECONNREFUSED）
  豆包进程                 : 运行中 (14 个进程，主进程 PID 35792)
  可执行文件               : E:\Doubao\app\Doubao.exe  (来源: 运行中的进程)

  ✗ 不能连接：豆包正在运行，但没有开调试端口。
    也就是说它当初是正常启动的，需要带参数重启才能被驱动：
      1) 退出豆包
      2) 运行：
         "E:\Doubao\app\Doubao.exe" --remote-debugging-port=9222 --remote-allow-origins=*
```

- 退出码 **3 = 豆包未就绪**，与 `1`（一般错误）、`2`（等待超时）区分开，方便脚本判断。
- `node cdp.mjs doctor` 单独跑这段确认（就绪退 0，未就绪退 3）。
- 确认只**检测与说明，不会去结束或重启豆包**——那属于你的操作。
- `--no-preflight` 可跳过（不推荐；跳过后又会退回 `error: fetch failed`）。
- **从 DSH 的会话里启动豆包会被一起结束**（实测）：用工具调用里的 `Start-Process` 拉起来的豆包挂在
  DSH 的作业对象下，**DSH 一重启它就随进程树消失**（第二天实测到：进程没了、9222 变 `ECONNREFUSED`）。
  要么让用户自己启动，要么用一次性计划任务启动（`Register-ScheduledTask` + `Start-ScheduledTask`，
  跑完删掉任务）——它不在 DSH 的进程树里，重启 DSH 不受影响。
- 端口用 `DOUBAO_CDP_PORT`（兼容旧的 `CDP_PORT`）覆盖，可执行文件路径用 `DOUBAO_BIN` 指定。

派发器同样受这条闸门保护，而且**确认在任何副作用之前**：队列模式下如果确认不过，**不会往队列里留下任何任务**（这一点有断言钉着）。`--no-send` 的密封模式不需要豆包。

## 这个应用的 DOM 锚点（2026-10-01 实录，豆包 Chromium 147）

| 用途 | 锚点 |
|---|---|
| 聊天页面 target | url 含 `doubao-chat/chat`（另有 `doubao-launcher/chat`、`doubao-background`、drive iframe，别选错） |
| 输入框 | `.tiptap.ProseMirror`（contenteditable） |
| 发送按钮 | `.send-btn-wrapper` |
| 消息容器 | `[data-testid="message-list"]` |
| 单条消息 | `[data-testid="union_message"]` |
| 用户消息 | `[data-testid="send_message"]` |
| 助手消息 | `[data-testid="receive_message"]` |
| 消息正文 | `[data-testid="message_text_content"]` |

## `dispatch.mjs`：带副作用校验的派发器

```powershell
# 聊天模式：把任务发进去，返回它的回复
node dispatch.mjs "用一句话说明你在做什么"
node dispatch.mjs "做个调研" --status        # 聊天模式也带上状态契约（默认不带）

# 队列模式：入队 → 让豆包通过 MCP 连接器领取并回报 → 轮询队列直到完成为止
# （队列模式**自动**附带状态回报契约，不需要手动粘贴模板）
node dispatch.mjs "整理这份清单" --queue --timeout 300000 --worker doubao

# 只验证校验逻辑，不打扰聊天（正式回归测试用）
node dispatch.mjs "..." --queue --no-send
```

退出码：`0` 已派发并通过队列核实；`2` 超时/未核实；`1` 硬错误；`3` 豆包未就绪；`8` 无法识别。

**为什么需要它**：客户端可以回复「已调用 task_claim，status 为 ok」而实际上什么都没调。2026-10-01 实测就是这样——它这么说了，而队列里那条任务仍是 `pending`，豆包的 `agent_infra` 也没有任何任务执行记录。**信聊天回复的派发器会静默丢活。**

### 状态契约是自动带的

队列模式下，发给豆包的指令由 `buildQueueInstruction()` 拼装，包含两段：**走队列**（task_claim → 干活 → task_complete）和**状态回报契约**（动手前 `start`、结束 `done`/`fail`、可选 `progress`/`need-input`，job 就是本次派发标记）。措辞只有一份（`status-contract.mjs`），派发器与文档引用同一处，不会漂移。

由此派发器多出两个能力：

- **等待期间实时打印状态**：`[状态] 工作开始 · …`、`[状态] 工作结束 · …`，不用等超时才看到进展；
- **完成后核对状态**：队列说完成、但状态文件里没有 `started` 事件 → 明确点出「这条完成的成色要打折」——它没按契约先报开工。

### 密封测试（不需要豆包、不连 CDP）

```powershell
npm test          # 等价于 node dispatch-selftest.mjs
```

四个场景、共 22 项断言：

1. **指令内容**：入队指令必须同时含「走队列」与「状态契约」（含本次 job id 与五条命令）；
2. **成功路径**：一个脚本化 worker 照契约先报 `started`、再回报 → 派发器退出 `0`、打印 `VERIFIED`，并**实时打出状态变化**；
3. **没报状态的完成**：worker 直接完成、不发 `started` → 必须点出来；
4. **失败路径**：没人领取（复现豆包那种「嘴上说做了」）→ 退出 `2`、`UNVERIFIED`，并说明聊天回复不算证据。

因为 `--no-send` 让派发器完全不碰聊天，而失败路径对 CDP 不可达是容错的，所以这个测试在**没有豆包的机器和 CI 上都能跑**。

### 发送前预检

队列模式下，派发器会先读连接器的客户端记录（`clients.json`），把结论明写在输出里：

```
连接器记录到的客户端：无（它从未收到过任何 MCP 客户端的 initialize）
警告：没有任何 MCP 客户端连接过这个连接器，客户端很可能调不到这些工具，
      它回复"已完成"不可信。请先在客户端里启用该连接器，本次结果以队列记录为准。
```

这不是装饰：**超时 45 秒之后才发现「它根本没调工具」，等于每次失败都白等一轮**。有一条记录时它会打印该客户端与最后活动时间，也不再报警告——所以这行输出本身就是判断「连接器到底有没有被接上」的快速信号。

## 为什么豆包会说「做了」而其实没做

**根因：连接器没有在会话里启用，所以那些工具根本不在它的可调用列表里。**

让豆包如实列出工具即可当场证伪：

```powershell
node cdp.mjs send "请如实回答：你当前这个会话里有哪些可调用的工具或已启用的连接器？逐个列名字；一个都没有就直接说「没有」。"
node cdp.mjs wait 120000
```

2026-10-01 实测返回的是：

```
general_search、web.fetch、scholar_search、image_zoom_in、image_search、
visual_search、image_rotate、image_grounding、image_point、calculator、
doubao_code_interpreter、operate_saved_memory、poi.route_plan、medical_search
```

**里面没有 `dsh_ask` / `task_claim`。** 模型在工具不可用时不会报错，而是**编一个成功的调用记录**——所以：

1. 派发前先确认连接器已启用：侧栏 **「插件 · 技能 · 伙伴」** 里找到该连接器并启用（视版本可能还需要在会话里勾选）。
2. 任何「我已经调用 X 了」都必须回到**副作用**去核实——队列事件、文件、日志。这也是 `dispatch.mjs --queue` 存在的理由。

## 两种模式：对话 vs 工作任务（**工具集不同**）

豆包桌面版不是一个模式。输入框左侧的模式切换器（`[data-testid="chat_input_action_mode"]`）点开后是一个 `role="menu"`，四个选项：

```
对话 | 工作任务·本地电脑 | 工作任务·<本机名> | 工作任务·云电脑
```

**两种模式下它可调用的工具完全不同。** 2026-10-02 实测（同一条问题「请如实列出你可调用的工具」）：

| 模式 | 工具集 |
|---|---|
| **对话** | `general_search`、`web.fetch`、`scholar_search`、`calculator`、`doubao_code_interpreter`、`image_*`、`medical_search`、`read_skill`、`list_and_search_skills` 等——**纯检索与生成** |
| **工作任务·本地电脑** | 上面之外**多出本机操作能力**：`Bash`、`PowerShell`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`FileBatchUpload`、`Wait`、`TaskOutput`、`TaskStop`，以及 `computer_use_tool`、`interact` |

**实测它自称处于「完全访问」执行模式（无沙箱，命令直接在真实系统上执行）**——工作模式 + 本地电脑时，它是真的能在你机器上执行命令的。这既是能力也是风险。

**我们的 `dsh_*` 连接器工具在两种模式下都没有出现**，所以「让豆包通过 MCP 调我们的连接器」这条路，卡点始终是连接器没在该会话启用，而不是模式问题。

**但工作模式给了一条完全不同的路**：它自带 `Bash` / `PowerShell`，所以可以直接让它执行 `dsh --profile headless --json -`（任务走 stdin），而不必依赖我们的 MCP 工具。这条路的代价是「完全访问」——它同时也能执行别的命令。

## 状态回报：工作开始 / 结束 / 各种中间状态

`status.mjs` 让豆包（或任何调用方）在关键节点留下**可核对的副作用**，而不是只回一句「已开始」。

```powershell
node status.mjs received    --job DISPATCH-a1b2c3              # 派发器自己写：指令已送出（不是豆包的回报）
node status.mjs start       --job DISPATCH-a1b2c3              # 真正开始执行命令之前
node status.mjs progress    --job DISPATCH-a1b2c3 --percent 50 --step "拉取数据"
node status.mjs need-input  --job DISPATCH-a1b2c3 --message "要确认哪一步"
node status.mjs done        --job DISPATCH-a1b2c3 --message "结果摘要"
node status.mjs fail        --job DISPATCH-a1b2c3 --message "错误摘要"

node status.mjs list [--job <id>]     # 时间线
node status.mjs open                   # 谁还在跑（退出码 6 = 有未结束）
node status.mjs last <id>              # 最后状态（未知 job 退 5）
node status.mjs config                 # 打印生效配置（排查用）
```

状态写**独立文件**（默认队列同目录的 `status.jsonl`），**不污染任务队列**：`queue.mjs list` 的任务数不会因为状态而变。

### 行为由 `doubao-status.ini` 驱动

配置放在状态文件同目录，**改完立即生效**（脚本每次重读，不用重启）。带注释的样例见 `doubao-status.ini.sample`。

- 只认**固定词表**：`received` / `started` / `progress` / `need_input` / `done` / `failed`（别名 `start`/`finish`/`fail` 只是输入便利）。`received` 由**派发器**在指令真的发出去之后写，是发送侧事实，不是豆包的回报。
- 找不到或读坏 ini → 用内置默认值并**打印明确告警**，不会因为配置问题丢状态。
- 被 ini 关掉的状态：调用它是**静默 no-op**（退出 0、无输出），不打断豆包的工作。
- `received` / `started` / `done` / `failed` **永不因限流丢弃**；`progress` 默认 10 秒一次防刷。
- `started` 会覆盖 `received`（`received` 不是终态）；只要 job 还没到终态，`received` 或 `started` 都算「还占着」。
- 终态之后不再接受新状态；超长正文按 ini 截断。

### 推到 DSH 工作台会话（可选）

```powershell
node status-push.mjs --once                 # 处理积压后退出
node status-push.mjs                        # 常驻轮询
node status-push.mjs --dry-run --once       # 只打印要推什么
node status-push.mjs --create-session       # 没有会话时先建一个并打印 id
```

**只推阶段转换**（`started` / `need_input` / `done` / `failed`），`progress` 永远留在文件里——**每次推送 = 一次真实模型调用**，一个 10 分钟的任务约 4 次而不是几百次。没有配置目标会话时它会**明确报错**，绝不静默丢状态。游标存在 `.push-cursor.json`，重启不会重复推。

## 调用前五维识别

`doctor` 不只看端口，还会回答「现在**能不能**发」：

| 维度 | 判定依据 |
|---|---|
| 连通性 | 调试端口 + 目标页面 |
| **模式** | 页面上模式控件的文字（`对话` / `本地电脑`）；读不到就是 unknown，绝不猜 |
| **命令能力** | 由模式推导：工作模式有 shell，对话模式没有 |
| **忙闲** | 状态文件里「有 `received` 或 `started`、无终态」的 job；超 10 分钟无事件标为疑似卡死 |
| **通道** | 状态目录能否真的写进去 |

**忙闲这一维的连带影响**（真机踩到）：`cdp.mjs` 对除 `doctor` / `targets` 以外的**每个命令**都做调用前识别，而判定是「只要有一条 reason 就 `not-ready`」。于是有未终结 job 时，连 `wait` / `read` 都会被挡。派发器发送之后的 `wait` / `read` 因此带 `--no-preflight` 跳过识别——否则 chat 模式会被**自己刚写的 `received`** 挡住，每次都在拿到回复前先失败。发送前派发器已用自己的 `identify()` 判过一遍，发送后的读操作是对已发出消息取回复，再判一次没有意义。

### `state`：模式 + 模型的只读快照

```powershell
node cdp.mjs state          # 人类可读
node cdp.mjs state --json   # 结构化
```

一次 CDP 往返读两处，**全是只读**（只读文字，不点控件、不切模式、不换模型）：

| 读什么 | 选择器 | 真机注意 |
| --- | --- | --- |
| 模式 | `[data-testid=chat_input_action_mode]` | 文字形如 `本地电脑` / `对话`，交给 `mapModeText` 判 |
| 模型 | `[data-testid=chat_input_action_model]` | `innerText` 是 `豆包 2.1 Lite低` —— **末尾那个「低」是同一层里的档位 span**（`text-dbx-text-tertiary`），不是模型名的一部分；`splitModelText` 负责把它剥掉 |

**它不做调用前识别、也永远退出 0**（与 `doctor` 同族）：它是诊断读数，不是放行闸门——豆包没开时正需要它报告 `connected:false`，不能因为 `not-ready` 就先自己失败。`--json` 字段：`{connected, mode, modeRaw, capability, model, modelLevel, at, error?}`。

### `mode`：切换工作模式（写操作，点 UI 后按只读读数复核）

```powershell
node cdp.mjs mode work [--json]   # 切到「本地电脑」（工作模式，有 shell，能回报状态）
node cdp.mjs mode chat [--json]   # 切回「对话」
```

真机背景：豆包**每次启动默认是「对话」模式**，而对话模式没有 shell，契约里的 `status.mjs`
执行不了，派发器会（也应该）拒绝发送。所以「切到工作」是个高频动作。

纪律：

- **每一步都用只读读数复核**：先读当前模式（已经是目标就 `changed:false`，不白点一次）→ 点模式控件 →
  等菜单出现 → 点目标选项 → **轮询只读模式直到它真的等于目标**。点完读数没变就是失败，
  绝不因为「我点过了」就报成功；返回里带 `modeBefore` / `modeAfter`。
- 菜单项的定位不能只看文字：**控件和菜单项都会出现「对话」**。实现先在浮层里定位
  （同时含「对话」与「本地电脑」、且不包含控件的最小容器），再只在浮层内部找行；找不到就按
  `Escape` 关掉菜单并报失败。
- 它同样**不做调用前识别**（预检要求「已是工作模式」才放行，而切模式恰恰是模式不对时才用的），
  自己先探连通性，连不上就明确报「豆包没在跑」。
- 非法目标（不是 `work` / `chat`）在连 CDP 之前就被挡住：退 1 + 用法。

`--json` 字段：`{ok, changed, modeBefore, modeAfter, option?, error?, target, at}`。
真机实测：`mode chat` 与 `mode work` 双向都成功，重复切同一模式返回 `changed:false`。

### `quota` / `models`：额度与模型清单（**只读采样**，要开界面）

```powershell
node cdp.mjs quota  [--json]   # {ok, plan, resets, windows:[{id, short, label, usedText, usedPercent, approximate, resetText}], at}
                               # 读不到额度页时降级：{ok, usedPercent, plan, resets, degraded:true, windowsError}
node cdp.mjs models [--json]   # {ok, current, items:[{name, note, current}], at, error?}
```

真机背景（2026-10-11 实测）：

- **额度**不在常驻 DOM 里。点开侧栏底部账户入口能看到一个 `当前时段额度用量` + `N%`
  （另有 `N 次额度重置`）；但**完整的两个窗口**（`当前时段` 与 `近 7 天`，
  各带百分比与重置时间）只在 **`https://www.doubao.com/member/quota-management`** 这个网页里，
  而豆包 App 是把它当 **iframe** 打开的。所以 `quota` 的默认路径是走 App 自己的入口：
  **账户菜单 → 设置 → 订阅与额度管理 → 读 iframe → `finally` 里 Escape ×2**。
- 模型清单同理，只在点开模型控件后出现
  （`豆包 2.1 Lite / 0921 新版`、`豆包 2.1 Pro`、`豆包 2.1 Turbo / 即将下线`）。

纪律：

- 这两个是**采样**，不是无副作用查询：**打开界面 → 读 → `finally` 里关掉**，成功也一样关，
  并再确认没有残留可见弹层。界面会闪一下（额度那条路是三次点击 + 设置面板闪开），这是它的代价。
- **找不到入口就失败，不做「点一下试试」的兜底**（侧栏乱点可能开出别的东西）；
  菜单/页面没出现 / 没有百分比 → 失败，**绝不猜一个 0%**。
- **降级是显式的**：额度页读不到时退回账户菜单那一个数字，并在返回里带
  `degraded: true` + `windowsError`——让调用方知道「只有一个窗口」是因为没读到页面。
- **`已用 <1%` 不能读成 1%**：解析成 `usedPercent: 0` + `approximate: true`，
  原文保留在 `usedText`。宁可条是空的，也不把「不到 1%」说成 1%。
- 全程只读：不选任何菜单项、不改任何设置。找不到 = 退 1 + 原因。
- **调用方必须自己串行化**：`quota`、`models`、`mode` 三者都会开界面，并发会互相点错
  （面板宿主半用一个串行队列保证同一时刻只有一个在跑）。
- 同名模型项会出现多行（行容器 + 内层），`models` 按**名字**去重，优先保留带标注的那条。

真机验证覆盖了 `quota` 与 `models` 的读取、降级路径、弹层清理和模式/模型保持不变。
公开测试使用合成额度数据，不包含账户额度、套餐或重置时间。

**为什么不用 `Target.createTarget` 直接开那个 URL**：实测它确实能用（一次调用、不靠坐标），
但它会挂在**一个 1051×677 的可见窗口**上（`Browser.getWindowForTarget` 返回
`windowState:"normal"`），比闪一下设置面板更扰人。所以选了 App 自己的 iframe 路径。

**这条路天生不稳，所以每一步都验证 + 整轮重试**。开调试开关能看到每一步的观察：

```powershell
$env:DOUBAO_QUOTA_DEBUG='1'; node cdp.mjs quota --json
# [quota] openQuotaEntry: 菜单开了吗 = true
# [quota] openQuotaEntry: 设置 rect = {"x":62,"y":527}
# [quota] openQuotaEntry: 第 1 轮找到稳定额度行 = {"x":817,"y":503}
# [quota] readQuotaPageText: 第 2 次轮询，共 7 个目标，额度页 = https://www.doubao.com/member/quota-m…
```

两个真机踩出来的坑（**症状都是「窗口数恒为 0」，看起来像豆包没开，其实不是**）：

1. **读 iframe 目标不能失败即放弃**：目标刚创建时连接/求值会抛（还没就绪）。
   第一版让这个异常把整条链带崩，于是永远读不到；现在**失败就继续轮询**并记下最后错误
   （`readQuotaPageText` 里那个 `catch` 就是为此存在）。
2. **面板出场有动画，量到的坐标在动**：轮询刚找到那一行就点，点上去是**点空**——
   日志里每一步的坐标全对、菜单也确实开了，但 iframe 永远不来。现在要求
   **连续两次量到同一坐标**才认为面板停稳。

加上这两条后实测 **6/6 成功，单次 2.3~3.8 秒**；失败时才降级到账户菜单那一个数字。

**三态必须区分**：`0` 可以发 / `3` 未就绪（逐条给出原因）/ `8` **无法识别**（同样拒绝）。

- 任何一维不过就拒绝发送，且**不产生任何副作用**（队列里不会留下孤儿任务）。
- `--force` 可放行，但会在状态文件里留一条 `override` 记录，并在 stderr 明确告警。
- `--mode chat|work|unknown` 跳过 DOM 读取（诊断与测试用）。
- `doctor --json` 输出机器可读结果，派发器就是用它做前置判定的（只有一份实现）。

## 踩过的坑

1. **Enter 不提交**。ProseMirror 把 Enter 当换行；必须点发送按钮。而且要用 CDP 的**真实鼠标事件**（`Input.dispatchMouseEvent`），脚本 `.click()` 可能被 `isTrusted` 拦掉。
2. **文本要用 `Input.insertText`**，不要直接改 DOM 或 `innerText` —— ProseMirror 不认，发送后内容会被丢弃。
3. **回复可能在 `send` 的确认轮询期间就到达**。所以 `wait` 不能判「助手消息数是否增加」，要判「最后一条消息是不是助手消息」（`TURN_STATE`），再等文本稳定两拍，避免读到半截的流式回复。
4. **页面里有多个 target**（launcher / background / iframe），按 url 精确匹配。
5. 别用 `[class*=message]` 抓正文——会抓到「相关问题推荐」卡片。
6. **「正在思考」也是稳定文本**。工作模式下它会把这条占位放进助手槽位，`wait` 的「文本稳定两拍」判据会把它当成最终答复——实测真的发生过一次（派发器退出 0，答复却是「正在思考」）。现已用占位正则排除，并会在跳过时于 stderr 说明。
7. **提交确认不能只看用户消息计数**。工作模式渲染最新消息的方式不同，计数会滞后，于是发送其实成功了却被判「未提交」（实测退出 1、消息已送达）。现在的判据是「计数增加 **或** 输入框已空」——输入框空了才是真正的不变量。

## 安全

`--remote-debugging-port=9222` 意味着**本机任何进程都能接管你的豆包**：读全部聊天记录、以你的身份发消息。它只绑回环（外部网络进不来），但这仍是本地信任边界的扩大。

- 不用时：退出豆包并正常启动（去掉参数）。
- 不要把它和隧道/端口转发一起用。

## 局限

- **没有任何官方入站 API**：这条路是 GUI 自动化，不是受支持的集成。
- 上面所有选择器/锚点都是**版本相关**的，豆包升级后需要重新 `probe`。
- 与你手动操作豆包**会互相干扰**（同一个输入框、同一个会话）；不适合长期无人值守跑高频任务。
- 通过它下发的每一条都会**消耗你的豆包额度**，并留在你的会话历史里。
