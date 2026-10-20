# 豆包控制器（Doubao Controller）—— DSH Web 里的豆包控制台

> 包 id（bundle id）仍是 `@local/doubao-status-panel`：**声明**是「豆包控制器」，
> 但改包名要重装插件 + 重启 DSH Web，所以 id 和路由路径都没动（免得把已经装好的那份弄坏）。
> 目录名同理。

**它是什么**：把豆包桌面端接进 **DSH Web 界面侧栏底部** 的一块控制台。四件事：

1. **看状态**——派发出去就显示「已接收」，豆包开工显示「工作开始」，然后「进行中 40%」，
   最后「已完成」/「失败」（**最多三行**：任务那一行只在有活跃/刚结束的 job 时出现）；
2. **看运行时**（常驻）：当前**模式**（`本地电脑` / `对话`）+ 当前**模型**（例如「豆包 2.1 Lite」）
   + 模型**状态标注**（`0921 新版` / `即将下线`）。「是不是工作模式」直接决定豆包能不能回报状态——
   派发之前就该看得见，而不是被拒之后才知道；
3. **切模式**——不是工作模式时，徽章上出现一个 `切到工作` 按钮，点一下真的把豆包切过去
   （走 `cdp.mjs mode`，切完用只读 `state` 复核，**失败就照实说失败**，不假装成功）；
4. **看额度**（常驻，**一个窗口一行**）：5h 与 7d 两个窗口的已用百分比 + 套餐名（+ 可重置次数），
   每行下面一条 **5px 进度条**，阈值变色（≥80% 琥珀 / ≥95% 红）。这几行是**采样**——
   数字只在豆包那个额度网页里，要读就得短暂打开一次界面；采样频率在设置里可调
   （1/5/15 分钟，或「仅鼠标悬停时」完全不主动采），见「限制」。

以前只能 `node status.mjs list` 看状态、只能 `node cdp.mjs doctor` 看模式、只能点开豆包菜单看额度；
这个插件把这三步搬进界面。

## 它长什么样

侧栏底部、设置按钮旁边一枚小徽章（`sidebar.footer.action` 槽）。宽栏最多三行，窄栏（56px）只有一个色点。

**注意行数**：任务那一行**只在有活跃 job、或刚才 60 秒内结束过 job 时**才出现。
所以平时是**三行**（运行时 + 5h 额度 + 7d 额度），刚跑过任务时是四行；额度读到降级载荷时
（额度页没读到）就只有一行额度，总共两行。**行数会随「有什么数据」变，这不是缺行。**
（真机踩过一次：我把它描述成「三行」，结果没任务时看到两行像是坏了。）

任务那一行：

| 状态 | 显示 | 颜色来源（主题 token） |
| --- | --- | --- |
| `received` | 已接收 | `--dsw-alias-state-idle-primary` |
| `started` | 工作开始 | `--dsw-alias-brand-primary` |
| `progress` | 进行中 40% | `--dsw-alias-brand-primary` |
| `need_input` | 需要确认 | `--dsw-alias-state-warn-primary` |
| `done` | 已完成 | `--dsw-alias-state-success-primary` |
| `failed` | 失败 | `--dsw-alias-state-error-primary` |

运行时那一行（常驻）：

| 情况 | 显示 | 色点 |
| --- | --- | --- |
| 工作模式 | `本地电脑 · 豆包 2.1 Lite · 0921 新版` | 绿（`state-success-primary`） |
| 对话模式 | `对话（不回报状态） · 豆包 快速` **+ `切到工作` 按钮** | 琥珀（`state-warn-primary`，就是会被派发拒绝的那档） |
| 模型标注含「即将下线」 | 同上，但**整行变琥珀**提醒你该换模型 | 琥珀（`state-warn-primary`） |
| 豆包没带调试端口 | `豆包未连接` | 灰（`state-idle-primary`） |

额度那几行（**一个额度窗口一行**，常驻；读不到就整行不显示）：

| 情况 | 显示 | 色点 |
| --- | --- | --- |
| 5h 窗口（页面原文「当前时段」） | `5h 额度 {页面百分比}` + 一条 5px 进度条 | 绿 / ≥80% 琥珀 / ≥95% 红 |
| 7d 窗口（页面原文「近 7 天」） | `7d 额度 {页面百分比}` + 一条 5px 进度条 | 同上 |
| **降级**（额度页没读到，只有账户菜单那一个数字） | `额度 {页面百分比} · {套餐名} · 可重置 {次数}` + 一条条 | 按该数值分级 |
| 读不到（豆包没开 / 改版） | 不显示这些行，原因写在悬停提示里 | — |

- **`<1%` 不会被读成 1%**：页面写「已用 <1%」时，文字原样显示 `<1%`，进度条按下界 0 画，
  并标 `approximate`。宁可条是空的，也不把「不到 1%」说成 1%。
- 窗口的**短名是我加的映射**（页面原文「当前时段 / 近 7 天」→ 界面上的 `5h` / `7d`）；
  悬停提示里给的是**页面原文 + 重置时间**，具体额度和时间由本机页面动态提供。

- **两条进度条**（都是 `<3px` 的细条，带 `role="progressbar"` 与 `aria-valuenow`，读屏可念）：
  1. **任务条**：跟任务那一行同一色，值取 `percent`；`done` 视为 100%；
     **`received`/`started`/`need_input`/`failed` 没有可靠百分比 → 不画条**（不编造进度）；
  2. **额度条**：值取本时段已用百分比，颜色跟阈值（绿 / ≥80% 琥珀 / ≥95% 红）。
- **`切到工作` 按钮只在「豆包在线且不是工作模式」时出现**：点它就把豆包切到「本地电脑」（工作模式），
  成功后立刻重取（不用等下一个轮询）。工作模式或未连接时它不显示——那种情况下它没有意义。
  切换失败按钮变红色「重试」，悬停能看到失败原因（**不假装成功**）。
- 鼠标悬停有完整提示：`job / 步骤 / 正文`、模式与「状态回报：可以/不行」、模型档位、
  **额度明细（含可重置次数）**、**可选模型清单（标出当前项与标注）**、读取失败原因。
- 状态变化后 `已完成` 会再留 60 秒（`TERMINAL_LINGER_MS`），否则一发终态徽章就消失，看不见结果。
- **采样间隔可以在设置里调**（设置 → 通用 → 「豆包状态面板：额度/模型采样间隔」）：
  每 1 / 5 / 15 分钟，或「仅鼠标悬停时」（平时一次菜单都不开）。
- 接口本身不通（宿主半没挂上）→ 徽章隐藏；**豆包没开**不算接口故障，会照实显示「豆包未连接」。

## 六个文件

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`exports` + `dsh.bundle.patch` + `dsh.client{platform:web, immediately:true, inject:["@deepseek-ai/dsh-client-ui-sidebar"]}` |
| `cordis.patch.yml` | 往 profile 插入一行插件行 `@local/doubao-status-panel` |
| `index.js` | **宿主半**：只读接口 `GET /doubao-status/api`（任务 + 快照 + 额度 + 模型清单 + **MCP 连接器客户端**）+ 模式切换 `POST /doubao-status/api/mode`，复用 DSH 自己的 webServer（不新开端口）；开菜单的三件事走同一条串行队列 |
| `client.js` | **浏览器半**：模块装载器格式，注册侧栏徽章（三行），每 2 秒轮询接口；不是工作模式时给出「切到工作」按钮；悬停提示里报告 MCP 侧有没有真实客户端接过 |
| `panel-selftest.mjs` | 密封测试：接口只读性、来源围栏、路径解析、状态折叠、运行时快照与缓存、模式切换端点、额度/模型解析与串行队列、采样设置、**MCP 连接器客户端读取器**，**以及用假 React 真跑 `client.js` 的渲染断言**（几条线、几条进度条、值是多少、提示里说了什么），不需要 DSH 也不需要豆包 |
| `README.md` | 本文件 |

宿主半**不引用任何 `@deepseek-ai/*` 运行时包**，只 import node 内置与同工作区的
`../doubao-cdp/status.mjs`（复用 `readStatusEvents` / `foldByJob` / `openJobs` / `loadConfig`）。
「模式 + 模型」「切换模式」「额度」「模型清单」则 **spawn `../doubao-cdp/cdp.mjs state|mode|quota|models`**
（DOM 选择器与点击逻辑只有那一份实现），宿主半自己不连 CDP。
客户端半也不 import 任何 DSH 客户端包，只用主题 token。

## 接口

```
GET /doubao-status/api
```

```json
{
  "ok": true,
  "file": "C:\\Users\\<you>\\.dsh\\mcp-connector\\status.jsonl",
  "now": 0,
  "doubao": {
    "connected": true,
    "mode": "work",
    "modeRaw": "本地电脑",
    "capability": "yes",
    "model": "豆包 2.1 Lite",
    "modelLevel": "低",
    "at": 0
  },
  "quota": {
    "ok": true,
    "usedPercent": 0,
    "plan": "示例套餐",
    "resets": 3,
    "at": 0
  },
  "models": {
    "ok": true,
    "current": "豆包 2.1 Lite",
    "items": [
      { "name": "豆包 2.1 Lite", "note": "0921 新版", "current": true },
      { "name": "豆包 2.1 Pro", "note": "", "current": false },
      { "name": "豆包 2.1 Turbo", "note": "即将下线", "current": false }
    ],
    "at": 0
  },
  "jobs": [
    {
      "job": "SAMPLE-01",
      "state": "progress",
      "phase": "started",
      "terminal": false,
      "percent": 40,
      "step": "拉取",
      "message": "正在拉取",
      "receivedAt": 0,
      "startedAt": 0,
      "lastAt": 0,
      "idleMs": 0,
      "stale": false
    }
  ]
}
```

- **只读**：只有 `GET`，其余方法一律 `405` + `Allow: GET`，不解析请求体。
- **来源围栏**：只放行**本机**请求（回环 socket + 回环 `Host`，非跨站）。理由是真机实测：
  DSH 的 web 服务监听 `0.0.0.0:43120`，而 GUI 页面本身对非本机访问要鉴权（`GET /` 返回 `401`）；
  插件路由跑在鉴权之前，没有围栏就等于**绕过 GUI 的鉴权**，把 job id / 正文 / 结果摘要
  暴露给同网段的人。非本机来源返回 `403 {"ok":false,"code":"forbidden"}`，且**不读数据**。
  代价：从 LAN 地址打开 GUI 时徽章会隐藏（拿不到数据就隐藏，见「限制」）。
- **不新增端口**：注册在 DSH 自己的 webServer 上（本机是 43120），路径是相对路径。
- `doubao` = 豆包运行时快照，来自 `cdp.mjs state --json`（只读两个 `data-testid` 的文字，
  不点、不改）。**带 15 秒缓存**（`DOUBAO_STATE_TTL_MS`）：面板每 2 秒轮询，但不会每 2 秒
  连一次 CDP；缓存过期时**先把旧值交出去**再后台刷新，所以响应不会被一次 CDP 往返拖住。
  豆包没开时是 `{"connected":false,"mode":"unknown","error":"..."}`——**降级，不是 500**。
- `quota` = 额度采样，来自 `cdp.mjs quota --json`。**这不是无副作用查询**：要看一眼就得
  走豆包自己的入口（见「限制」）。**60 秒缓存**（`DOUBAO_QUOTA_TTL_MS`）。
  读不到时 `ok:false` + `error`，**不会**编一个 0% 或 100% 出来。载荷两种形态：
  - **首选**：`windows: [{id, short, label, usedText, usedPercent, approximate, resetText}]`
    （额度页里的 5h/7d 两个窗口）；
  - **降级**：没有 `windows`，只有扁平的 `usedPercent`（账户菜单里那一个数字），
    并带 `degraded: true` + `windowsError`（说明为什么没读到页面）。
  两种情况下都给 `usedPercent`（取第一个窗口），老调用方不用改。
- `models` = 模型清单采样，来自 `cdp.mjs models --json`。同样要开一次模型菜单，**60 秒缓存**。
  每项是 `{name, note, current}`：`note` 就是菜单里的状态标注（`0921 新版` / `即将下线`）。
  同名项在宿主半按名字去重。
- **额度采样与模型采样共用一条串行队列**（`createSerialQueue`），模式切换也走它：这三个动作
  都要点开豆包菜单，并发就会互相点错（A 刚开的菜单被 B 的点击打断）。所以同一时刻只允许一个在跑。
  只读的 `state` 不排队（它不开菜单）。
- `jobs` = 还占着的 job（`received` / `started` / `progress` / `need_input`，含疑似卡死）
  **加上** 60 秒内刚终结的 job（让「已完成」看得见），按 `lastAt` 升序。
- 状态文件不存在/无事件 → `200` + `jobs: []`；读取代码本身抛错才 `500`。
- `mcp` = **MCP 连接器的客户端记录**（`clients.json`，与状态文件同目录）。为什么徽章要知道这个：
  豆包本体那条线靠「模式 + 模型」就能看出执行端准备好没，而**走 MCP 的豆包工作那条线，
  徽章本来对它一无所知**（它报的 job 能显示，但看不出 MCP 侧接上没有）。两条诚实处理：
  - **自检/测试名会被滤掉**（`dsh-setup-check`、`local-check`、`selftest-*`）——否则
    「我自己探过端点」会被说成「有客户端接上了」；
  - 文件不存在是**正常状态**（连接器没跑过）→ `missing: true` 且**不报错**；文件在但读坏才带 `error`。
- `work` = **豆包工作（9223）那一份运行时快照**，走同一份实现：宿主半 spawn
  `cdp.mjs state --json --target work`。它和个人版**用各自的缓存**——两个 App 的连通性独立，
  共用一个会被互相覆盖。读得到（它带 `--remote-debugging-port=9223` 启动时）时徽章多一行
  `豆包工作 · 本地电脑 · 豆包 2.1 Lite`；；若读到了上下文用量（``state`` 里带出来的 ``usage``），就追加 `` · 上下文 N%``——**读不到就不写，绝不用 0% 充数**。读不到时**一个字都不加**，只在悬停提示里说明
  「要带调试端口启动才能读，不是坏了」——不把「没开端口」画成故障。

### 采样设置（查询参数）

面板的**设置项**通过查询参数告诉宿主半「这次要不要开菜单、间隔多长」：

| 参数 | 含义 |
| --- | --- |
| `quotaTtlMs` / `modelsTtlMs` | 采样间隔，**夹在 30 秒..1 小时**（防止有人传 0 把菜单刷爆）；缺席或非法 → 回退默认 60 秒 |
| `sample=0` | **这次不要开菜单**：过期也不刷新，只交已有旧值；一次都没采过就回 `{ok:false,error:"尚未采样…"}` |

设置项在 **设置 → 通用**，标题「豆包状态面板：额度/模型采样间隔」，位置在
「回车发送行为」与「性能与用量」之间（`order: 25`）。提供 4 档：
**每 1 分钟 / 每 5 分钟 / 每 15 分钟 / 仅鼠标悬停时（零打扰）**。
前 3 档正常轮询并按该间隔采样；「仅悬停」档平时发 `sample=0`（**一次菜单都不开**），
只有鼠标移到徽章上才发 `sample=1` 采一次。偏好存在浏览器 `localStorage`
（`doubao-status-panel:sample`），属于**显示偏好**，不进宿主配置。

### 模式切换（写端点，单独一条路径）

```
POST /doubao-status/api/mode
Content-Type: application/json

{"mode": "work"}      # 或 "chat"
```

```json
{ "ok": true, "changed": true, "modeBefore": "chat", "modeAfter": "work",
  "option": "工作任务\n本地电脑", "mode": "work" }
```

**写操作比读操作严**（这条会点你的豆包界面）：

- **单独路径**：只读接口继续只认 `GET`，这条只认 `POST`（其余 `405` + `Allow: POST`）。
- **只放行本机**：同一个来源围栏；LAN 来源 `403` 且**根本不会去点**。
- **模式白名单**：只接受 `work` / `chat`，其它值 `400`，**不会**透传成任何命令。
- **成败以只读复核为准**：底层 `cdp.mjs mode` 点完之后会重新读一次模式，读不到目标就算失败；
  接口原样返回 `modeBefore` / `modeAfter`，让你能看出到底发生了什么。
- 切换失败是**预期结果**（豆包没开 / 菜单没找到）：返回 `200` + `ok:false` + `error`，
  不是 500——「豆包没开」不是「接口坏了」。
- 成功后立刻让快照缓存失效，面板下一次轮询就能看到新模式（否则还会显示 15 秒旧模式）。
- 超时**不当成失败**：返回 `unsettled:true` + 「结果未知」，因为 `cdp` 可能已经点成功了——
  这时该做的是去读一次 `state`，而不是谎报失败。

命令行等价物（双向都能切；面板 UI 只提供「切到工作」这一个方向）：

```powershell
node ..\doubao-cdp\cdp.mjs mode work [--json]
node ..\doubao-cdp\cdp.mjs mode chat [--json]
```

## 安装 / 回滚

```powershell
# 安装（link: 指向本目录，改代码即改插件，不需要重新发布）
dsh plugin --profile web add link:<本目录的绝对路径>

# 回滚
dsh plugin --profile web remove @local/doubao-status-panel
```

装完**刷新或重启 DSH Web**。真机实测：宿主半的**模块代码在进程启动时就已加载**，改源码后
连「禁用再启用插件」都不会重新 import（Node 的模块缓存），所以改了宿主半必须**重启 DSH Web**，
只刷新页面只能更新客户端半。

前提：`doubao-status.ini` 的 `enabled` 列表必须包含 `received`，否则状态脚本会按设计
**静默 no-op**，面板就看不到「已接收」这一步。默认值已包含；用旧 ini 的话手动加一项。

## 验证（只信副作用）

```powershell
node panel-selftest.mjs        # 只读性 / 围栏 / 路径 / 折叠 / 快照与缓存 / 采样设置 / **渲染断言**（假 React 真跑 client.js）
node ..\doubao-cdp\status-selftest.mjs    # received 的写入、折叠、忙闲
node ..\doubao-cdp\dispatch-selftest.mjs  # --no-send 不写 received；started 覆盖 received
node ..\doubao-cdp\preflight-selftest.mjs # 模式/模型文字的拆分；state 是读数不是闸门；mode 的非法目标与离线语义
```

**渲染断言怎么做的**（这条值得单独说）：`panel-selftest.mjs` 用**假 React**（`createElement` +
够跑一次的 hooks）、假 `window.__ModuleLoader__`、假 `fetch` 把 `client.js` 真跑起来，
然后断言渲染出的节点树：没有任务时**只有 1 条** `progressbar`（额度）；`progress 55%` 时**有 2 条**（55 与 0）
且三行文字齐全；`started` 无百分比时**不画**任务条；`done` 满格；额度 ≥95% 用 error 色。
写它的原因很直接：行数/进度条这种问题 grep 源码验不出来，而真机上已经因它误会过一次。

只看「模式 + 模型」、以及切换模式（不经过界面，直接问 cdp）：

```powershell
node ..\doubao-cdp\cdp.mjs state          # 人类可读
node ..\doubao-cdp\cdp.mjs state --json   # 结构化（面板宿主半用的就是这条）
node ..\doubao-cdp\cdp.mjs quota          # 额度采样（会点开账户菜单，读完自动关）
node ..\doubao-cdp\cdp.mjs models         # 模型清单采样（会点开模型菜单，读完自动关）
node ..\doubao-cdp\cdp.mjs mode work      # 切到「本地电脑」（工作模式）
node ..\doubao-cdp\cdp.mjs mode chat      # 切回「对话」
```

接口通不通、能不能切（DSH Web 起着的时候）：

```powershell
curl.exe -s http://127.0.0.1:43120/doubao-status/api
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:43120/doubao-status/api   # 期望 405
# 围栏：伪造一个非回环 Host，期望 403（证明没有绕过 GUI 鉴权）
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 192.168.1.50:43120" http://127.0.0.1:43120/doubao-status/api   # 期望 403
# 模式切换端点（写操作）：只认 POST，且只放行本机
curl.exe -s -X POST -H "content-type: application/json" -d '{\"mode\":\"work\"}' http://127.0.0.1:43120/doubao-status/api/mode
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:43120/doubao-status/api/mode                                       # 期望 405
curl.exe -s -o NUL -w "%{http_code}`n" -H "Host: 192.168.1.50:43120" -X POST -d '{\"mode\":\"work\"}' http://127.0.0.1:43120/doubao-status/api/mode   # 期望 403
```

真机验证要「看到界面上的变化」，不是只看到 JSON：派发一条真任务，看徽章走
`已接收 → 工作开始 → 进行中 → 已完成`，并确认运行时那一行显示的正是豆包 App 里
选中的模式与模型。

### 实测记录（2026-10-10，本机）

| 项 | 结果 |
| --- | --- |
| 宿主半已挂载 | `GET /doubao-status/api` → `200` + JSON；`POST` → `405`；伪造非回环 `Host` → `403`（围栏生效） |
| 路径正确 | 接口返回 `file` = `%USERPROFILE%\.dsh\mcp-connector\status.jsonl`，`warnings` 为空（宿主进程没有 `DSH_HOME`，靠 `resolveStatusEnv` 回退；修之前它读的是 `~\.dsh-mcp-connector`） |
| 客户端半已注册 | `Slots` 查询 `sidebar.footer.action` 的占用者含 `doubao-status-panel`（order 5，active） |
| **界面渲染** | **已确认**：侧栏最底部（齿轮「设置」行上方）出现胶囊徽章，灰点 + 文字「已接收」 |
| 状态推进 | 用真实 `status.mjs` 写入一条合成 job（`PANEL-VISUAL-*`，5～7 个阶段、每阶段 20 秒），状态文件与接口逐条返回 `received → started → progress 35% → progress 70% → done`；界面上的**逐阶段切换**没有逐帧截图 |
| 真任务（对话模式） | **已完成**：chat 模式（带 `--force`，因为对话模式没有 shell）真发一条，豆包真回复「做不到 / 2+2 等于 4」，7 秒内状态文件写下 `received → done`，接口返回 `state:done`，退出码 0 |
| 模式 + 模型读取 | **已确认**（真豆包）：`cdp.mjs state --json` → `{connected:true, mode:"work", modeRaw:"本地电脑", capability:"yes", model:"豆包 2.1 Lite", modelLevel:"低"}`；宿主半走真实链路（真路由 + 真 spawn，`DSH_HOME` 清空模拟宿主进程）也拿到同一份快照 |
| 模式切换（写操作） | **已确认**（真豆包，双向）：`cdp.mjs mode chat` → `{ok:true, changed:true, modeBefore:"work", modeAfter:"chat", option:"对话"}`；`cdp.mjs mode work` → `{ok:true, changed:true, modeBefore:"chat", modeAfter:"work", option:"工作任务\n本地电脑"}`；再切一次 work → `changed:false`（幂等，不白点）。每次都再用 `state` 复核过 |
| 模式与模型是绑定的 | **实测**：对话模式是 `豆包 快速`，切到工作模式后变成 `豆包 2.1 Lite（档位 低）`——徽章上两行会一起变 |
| 快照缓存的真机行为 | **已确认**：切换后接口在 TTL 内仍返回旧的 `chat`，跨过 15 秒自动刷新为 `work`（正是设计行为） |
| 模式切换端点（真机） | **已确认**：`GET /mode` → 405；非回环 `Host` POST → 403；`{"mode":"bogus"}` → 400；`{"mode":"work"}` → 200 `changed:true` `chat → work`；`{"mode":"chat"}` → 200 `changed:true` `work → chat`。每次都用 `cdp.mjs state` 独立复核过真实模式 |
| 额度采样 | 真机验证了两个窗口的读取及降级路径；公开文档不保留账户额度、套餐或重置时间 |
| 「<1%」的处理 | **已确认**：解析成 `usedPercent: 0` + `approximate: true`，`usedText` 保留原文 `<1%`；进度条按下界画（测试钉住「不画成 1%」） |
| 多窗口渲染 | 合成测试覆盖两个窗口对应两条额度行和两条 5px 进度条；有任务时共 3 条，文字使用页面提供的百分比 |
| 模型清单采样（真机） | **已确认**：`cdp.mjs models --json` → `current:"豆包 2.1 Lite"`，items = `豆包 2.1 Lite(0921 新版, 当前)` / `豆包 2.1 Pro` / `豆包 2.1 Turbo(即将下线)`；同名去重后 3 项，当前项正确标出 |
| 接口载荷（真链路） | **已确认**：一次 `GET /doubao-status/api` 同时拿到 `doubao` + `quota` + `models`，冷缓存耗时 2.1 秒（三次 spawn 串行），之后走 15s/60s 缓存；`?sample=0` 走缓存 **22ms** 返回 |
| 请求级采样参数（真机） | **已确认**：`?sample=0` 冷缓存时返回 `{ok:false,error:"尚未采样…"}`（170ms 左右，**一次菜单都不开**）；`?quotaTtlMs=…` 被夹到 30 秒..1 小时 |
| **界面上的第三行（额度）与模型标注** | 合成示例覆盖模式、模型与额度信息的组合显示，账户数据不写入公开文档 |
| **采样设置项** | **已确认**（用户验收）：设置 → 通用里能看到「豆包状态面板：额度/模型采样间隔」，位置在「回车发送行为」附近。第一版它没画下边框、不像那一列的行，**用户报「没有设置」后修好**（见「踩过的坑」） |
| 界面行数的误会 | **已澄清**：任务那一行只在有活跃/刚结束 job 时出现。我最初把它描述成「三行」，导致用户以为第三行丢了——不是 bug，文档已改。**加上 5h/7d 两个窗口后，平时是三行**（运行时 + 两条额度） |
| 进度条（渲染层） | **已确认**（密封测试）：假 React 真跑 `client.js`，断言「没任务 = 1 条（额度 0%）」「progress 55% = 2 条（55 与 0）且三行齐全」「started 无百分比 = 不画任务条」「done = 满格 100%」「额度 96% = error 色」「两个额度窗口 = 两条行两条 5px 条、有任务时共 3 条」 |
| **5h/7d 两行 + 5px 条（界面）** | 侧栏底部按页面数据显示两个额度窗口，**各带一条 5px 进度条** |
| 面板侧读额度页（真链路） | **已确认**：`GET /doubao-status/api` 的原始 JSON 里 `quota.windows` 就是那两个窗口；`cdp.mjs quota` 连跑 **6/6 成功、2.3~3.8 秒/次**。定位过程见下面「踩过的坑」里的两条（读目标失败即放弃、动画期间就点） |
| **界面上的「模式 + 模型」** | **已确认**（用户操作）：徽章第二行显示的正是豆包 App 里的模式与模型，切模式后立刻跟着变 |
| **界面上的「切到工作」按钮** | **已确认**（端到端）：豆包在对话模式时徽章出现绿色边框的 `切到工作` 按钮；用户点击后整行变成 `本地电脑 · 豆包 2.1 Lite`，按钮消失。事后用 `cdp.mjs state` 独立复核：`本地电脑（work）`、能力 `yes`、模型 `豆包 2.1 Lite` —— 即「按钮 → POST → cdp 点 UI → 只读复核 → 徽章更新」整条链都成立 |
| 真任务（工作模式，完整四档） | **已完成**：工作模式下无 `--force` 真派发一条，状态文件写下 `received(派发器) → started(豆包执行 status.mjs) → done(豆包执行 status.mjs --message "2+2=4")`，退出码 0 |

## 踩过的坑

真机上踩出来的，都留了痕（测试或调试开关），免得下次再犯：

1. **设置行不能自造样式**：第一版那行用自造内联样式、**没画下边框**，在通用设置那一列里
   既不像设置项也容易被漏看，用户报「没有设置」。现在抄官方行的几何
   （`.5px` 分隔线、`space-between`、`gap 24px`、`padding 16px 0`），并把 order 提到 25。
2. **「三行」的说法会误导**：任务那一行只在有活跃/刚结束 job 时出现。我把徽章描述成「三行」，
   用户看到两行就以为坏了。文档现在写明「行数随有什么数据变」。
3. **额度页那条坐标链是「读目标失败即放弃」的受害者**：目标刚创建时连接会抛（还没就绪），
   异常把整条链带崩 → 表现成「窗口数恒为 0」，看起来像豆包没开。现在失败继续轮询。
4. **面板出场动画期间点的坐标是移动的**：轮询刚找到那一行就点 = 点空；日志里坐标全对、
   菜单也确实开了，但 iframe 永远不来。现在要求**连续两次量到同一坐标**才点。
   （3、4 两条是我的代码问题，不是豆包的问题——修完 6/6 成功、2.3~3.8 秒/次。
   定位靠 `cdp.mjs` 的 `DOUBAO_QUOTA_DEBUG=1` 调试开关。）
5. **`Number(null) === 0`**：查询参数缺席时 `get()` 返回 `null`，直接 `Number()` 会当成「用户传了 0」，
   把默认 60 秒压成下限 30 秒。
6. **`new URLSearchParams(req.url)`**：整串当查询串，键名变成 `path?sample` → `sample=0` 静默失效。

## 限制（第一版刻意不做的事）

- 界面文案硬编码中文，没有走 Client locale 服务——少一个可能不存在的依赖，
  界面的可用性优先。要多语言时再补 `ctx.locale.register`。
- 任务那一行不可点击（点开历史列表/详情是后续的事）；**只有「切到工作」按钮是可点的**。
- 轮询（2 秒）而不是事件推送：状态文件是本地追加型 JSONL，轮询足够且没有长连接风险。
- 只显示「最近一条」job，历史仍在 `node status.mjs list` 里。
- `stale`（>10 分钟无事件）在界面上只体现为「疑似卡死」后缀，不自动收尾——收尾是派发器的职责。
- **远程访问时徽章隐藏**：来源围栏只放行本机。想从 LAN / 手机看，就把 `index.js` 里
  `createStatusRoutes` 的 `fence` 换成 `() => true`——那等于把任务状态开给同网段，请先想清楚。
  改宿主半之后要重启 DSH Web（模块缓存）。
- **徽章常驻**：为了让你随时看到「是不是工作模式」，没有任务时也不隐藏（只剩运行时那一行）。
  想在豆包没连接时彻底隐藏，改 `client.js` 里 `runtimeText()` 返回空串的分支即可。
- **运行时快照依赖豆包的 DOM**：模型来自 `[data-testid=chat_input_action_model]`，档位来自它内部
  的 `text-dbx-text-tertiary` span。豆包改版换了选择器 → 模型会显示为空（不显示错的），
  模式读取则一直有 `cdp.mjs doctor` 那一套兜底。
- **模式切换也是在点豆包的 UI**（模式控件 → 菜单里选目标项），所以它跟 DOM 一样脆：
  豆包改版后 `cdp.mjs mode` 会报「找不到模式控件 / 菜单里没找到目标选项」而不是乱点。
  失败时**不会**有任何副作用被假装成成功：接口返回 `ok:false` + 原因，徽章按钮变红。真机上
  菜单项与控件都会出现「对话」两个字，所以实现是先在浮层里定位、再只在浮层内找行
  （见 `cdp.mjs` 的 `modeOptionRect`），避免误点页面别处的同名标签。
- **额度与模型清单是「采样」，不是无副作用查询**（这条最要紧）：这两个数字/清单**不在常驻 DOM 里**，
  只存在于点开菜单后的浮层/页面中。所以读它们必须**短暂打开界面再关掉**——界面上会闪一下。
  频率**由你在设置里调**（1/5/15 分钟，或「仅悬停时」完全不主动采），默认 60 秒。
  真正的实时读数只有 `state`（模式 + 模型名，纯读）。
- **额度为什么贵**（实测过每条路才选的）：5h/7d 两个窗口只在
  `www.doubao.com/member/quota-management` 这个**网页**里，而它是豆包 App 用 iframe 打开的。
  现在走的是 App 自己的入口：**账户菜单 → 设置 → 订阅与额度管理 → 读 iframe → Escape ×2**。
  代价是每次采样**设置面板会闪开一下**（约 2 秒），而且靠坐标点击，窗口布局变了会失效。
  实测过但**没有采用**的替代：`Target.createTarget` 直接开那个 URL——它稳、一次调用，
  但会挂在**一个 1051×677 的可见窗口**上（比闪一下设置面板更扰人）。
  失败时会**降级**成账户菜单里那一个数字（接口里带 `degraded: true`），不会因此整行消失。
- **三件开菜单的事共用一条串行队列**：额度采样、模型清单采样、模式切换。并发会让 A 刚开的菜单
  被 B 的点击打断，甚至误点到菜单项上（那是写操作）。所以同一时刻只有一个在跑，其余排队——
  冷启动时一次面板请求可能要等 2 秒左右（三次采样串行），之后走缓存。
- **额度/模型读不到时不会猜**：`ok:false` + 原因，界面把那一行藏起来、原因写进悬停提示。
  绝不显示一个编出来的 0%。
- **UI 只提供「切到工作」一个方向**：反向（切回对话）用 `cdp.mjs mode chat`。少一个按钮就少一次误点。
- **模型是「显示」不是「选择」**：面板不会替你换模型。真机上模式与模型绑定，切模式会连带换模型。
- **别从 DSH 的会话里启动豆包**（环境坑，实测）：用 `Start-Process` 从工具调用里拉起来的豆包会挂在
  DSH 的作业对象下，**DSH 一重启它就一起没了**（第二天就踩到：豆包进程消失、9222 变 ECONNREFUSED）。
  要么让你自己开，要么用一次性计划任务启动（`Register-ScheduledTask` + `Start-ScheduledTask`，
  跑完删掉任务），它不在 DSH 的进程树里，重启 DSH 不受影响。
