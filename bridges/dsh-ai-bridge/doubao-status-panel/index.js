/**
 * doubao-status-panel —— 宿主半：把 doubao-cdp 的状态文件暴露成一个**只读**接口。
 *
 * 为什么要有这一半：浏览器半拿不到文件系统，而状态文件是唯一可信的事实来源
 * （`status.jsonl` 是按 job 关联的追加型 JSONL）。所以宿主半只做一件事——读文件、
 * 折叠成「当前活跃 job」，再用 DSH 自己的 webServer 发出去。
 *
 * 纪律（对应验收标准）：
 *   - **只读**：只有 GET，其余方法一律 405；不接收任何请求体，不写任何文件。
 *   - **不新增端口**：注册在 DSH 自己的 webServer 上（本机就是 43120）。
 *   - 不引用任何 `@deepseek-ai/*` 运行时包：只 import node 内置与同工作区的
 *     `doubao-cdp/status.mjs`，这样它是「一个真实文件」的薄转换层，可以脱离
 *     DSH 直接做密封测试。
 *   - 读文件失败不是崩溃：接口返回 200 + 空 job 列表（面板据此隐藏）。
 *     只有真正的代码缺陷才返回 500，好让面板和后端日志能区分「没任务」和「坏了」。
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldByJob, loadConfig, openJobs, readStatusEvents } from '../doubao-cdp/status.mjs'

/** Cordis 插件名（与 package.json 的名字一致，便于在 profile 里定位）。 */
export const name = 'doubao-status-panel'

/** 本插件依赖的服务：DSH 的 HTTP 承载服务。 */
export const inject = ['webServer']

/** 只读接口路径。复用 DSH 自己的端口，不新开监听。 */
export const STATUS_API_PATH = '/doubao-status/api'

/**
 * 模式切换接口路径。**与只读接口分开**：只读那条继续只认 GET（其余 405），
 * 这条只认 POST——写操作各自一条路径，权限与语义不混在一起。
 */
export const STATUS_MODE_PATH = '/doubao-status/api/mode'

/** 允许切换到的模式（白名单：请求体里的值只能从这里选，绝不透传成命令）。 */
export const MODE_SWITCH_VALUES = new Set(['work', 'chat'])

/** 一次 `cdp.mjs mode` 的上限：它要点两下 UI 再轮询复核，比读快照慢。 */
const MODE_SWITCH_TIMEOUT_MS = 25_000

/** 请求体上限，防止有人往里灌东西。 */
const MAX_BODY_BYTES = 1024

/** 多久没有新事件就算「疑似卡死」，与 status.mjs 的默认值保持一致。 */
const STALE_AFTER_MS = 600_000

/**
 * 终态在面板上再留一会儿，让「已完成 / 失败」真的被看见。
 * 只留活跃 job 的话，done 一到就消失，用户看到的是「徽章闪一下没了」。
 */
export const TERMINAL_LINGER_MS = 60_000

/** 豆包运行时快照（模式 + 模型）的缓存时长：面板每 2 秒轮询，但一次 CDP 往返不该每 2 秒做一次。 */
export const DOUBAO_STATE_TTL_MS = 15_000

/**
 * 额度 / 模型清单的缓存时长。
 *
 * 为什么比 state 长得多（60 秒）：这两个**不是无副作用查询**——它们必须点开豆包的
 * 菜单才读得到（额度在账户菜单里，模型清单在模型菜单里），读完再关掉。所以宁可少采、
 * 也不能每 2 秒开一次人家的菜单。它们是「60 秒采样」，不是逐秒实时。
 */
export const DOUBAO_QUOTA_TTL_MS = 60_000
export const DOUBAO_MODELS_TTL_MS = 60_000

/** 一次 `cdp.mjs state` 子进程的上限；超时就杀掉并按「读不到」处理。 */
const DOUBAO_STATE_TIMEOUT_MS = 8_000

/**
 * 采样（quota / models）要开界面再读，给宽一点。
 *
 * 额度那条路是「账户菜单 → 设置 → 订阅与额度管理 → 读 iframe」，每一步都可能重试，
 * 最坏 ~30 秒（3 次点入口 + 找行 + 8 秒与 12 秒两轮等 iframe + 两次收尾）。
 * 上限必须比 cdp.mjs 自己的最坏情况更大，否则面板会先杀掉一个**正在正常推进**的读取，
 * 而那种失败看起来和「读不到」一模一样（真机上就踩过：窗口数恒为 0）。实测正常 ~2-4 秒。
 */
const DOUBAO_SAMPLE_TIMEOUT_MS = 45_000

/**
 * 采样间隔的下限/上限。面板的设置项可以把间隔调稀（菜单会闪），但**不允许调爆**：
 * 下限 30 秒（再密就是拿菜单刷屏），上限 1 小时（再稀就没有意义了）。
 */
export const SAMPLE_TTL_MIN_MS = 30_000
export const SAMPLE_TTL_MAX_MS = 3_600_000

/**
 * 解析采样相关的查询参数（面板的设置项通过它把「采样间隔」传下来）。
 *   - `quotaTtlMs` / `modelsTtlMs`：采样间隔，夹在 30 秒..1 小时之间；
 *   - `sample=0`：**不主动采样**——过期也不刷新，只交已有的旧值（「仅悬停时采样」用）。
 * 参数非法时一律回退到默认值，绝不因为一个坏参数就报错。
 *
 * 入参可以是完整 `req.url`（`/doubao-status/api?sample=0`）也可以是纯查询串——
 * 注意 `new URLSearchParams('path?sample=0')` 会把整串当查询串（键名变成 `path?sample`），
 * 所以这里**先切掉 `?` 之前的部分**。这个坑真机踩过一次，测试里也钉住了。
 */
export function parseSampleQuery(urlOrQuery) {
  const raw = String(urlOrQuery ?? '')
  const query = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw
  let params
  try {
    params = new URLSearchParams(query)
  } catch {
    params = new URLSearchParams()
  }
  const clampTtl = (value, fallback) => {
    // 注意 `Number(null) === 0`：参数缺席时 get() 返回 null，若直接 Number() 就会
    // 被当成「用户传了 0」而被夹到下限。所以缺席/空串必须先判掉，回退默认值。
    if (value === null || value === undefined || String(value).trim() === '') return fallback
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(SAMPLE_TTL_MAX_MS, Math.max(SAMPLE_TTL_MIN_MS, Math.round(parsed)))
  }
  return {
    quotaTtlMs: clampTtl(params.get('quotaTtlMs'), DOUBAO_QUOTA_TTL_MS),
    modelsTtlMs: clampTtl(params.get('modelsTtlMs'), DOUBAO_MODELS_TTL_MS),
    allowRefresh: params.get('sample') !== '0',
  }
}

/** 复用 cdp.mjs 这一份实现（DOM 选择器只有一份），宿主半自己不连 CDP。 */
const CDP_SCRIPT = fileURLToPath(new URL('../doubao-cdp/cdp.mjs', import.meta.url))

/** 读不到时的降级值：面板据此显示「豆包未连接」，而不是 500。 */
function doubaoStateUnavailable(error) {
  return {
    connected: false,
    mode: 'unknown',
    modeRaw: '',
    capability: 'unknown',
    model: '',
    modelLevel: '',
    at: Date.now(),
    ...(error === undefined ? {} : { error: String(error) }),
  }
}

/**
 * 解析 `cdp.mjs state --json` 的输出。不是合法 JSON / 不是对象 → null（按失败处理）。
 * 抽成纯函数是为了能密封测试：不用起豆包、不用连 CDP。
 */
export function parseDoubaoState(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return {
    connected: parsed.connected === true,
    mode: typeof parsed.mode === 'string' ? parsed.mode : 'unknown',
    modeRaw: typeof parsed.modeRaw === 'string' ? parsed.modeRaw : '',
    capability: typeof parsed.capability === 'string' ? parsed.capability : 'unknown',
    model: typeof parsed.model === 'string' ? parsed.model : '',
    modelLevel: typeof parsed.modelLevel === 'string' ? parsed.modelLevel : '',
    at: Number.isFinite(parsed.at) ? parsed.at : Date.now(),
    ...(typeof parsed.error === 'string' && parsed.error.length > 0 ? { error: parsed.error } : {}),
    // 上下文用量（`cdp.mjs state --json` 里带出来的）：**只在打开的对话里读得到**。
    // percent 缺失就保持 null 并带上原因——不能把它当成 0%。
    ...(parsed.usage !== undefined && parsed.usage !== null && typeof parsed.usage === 'object'
      ? {
          usage: {
            percent: Number.isFinite(parsed.usage.percent) ? parsed.usage.percent : null,
            found: parsed.usage.found === true,
            reason: typeof parsed.usage.reason === 'string' ? parsed.usage.reason : null,
            contextOpen: parsed.usage.contextOpen === true,
          },
        }
      : {}),
  }
}

/**
 * 跑一次 `cdp.mjs <args>` 并收集输出。**从不 reject**：
 * 启动失败、超时、非零退出都变成一个结果对象，由调用方决定怎么降级。
 *
 * 抽出来是因为现在有四条路要 spawn：`state`（纯读）、`quota` / `models`（采样）、
 * `mode`（写）。重复四份 spawn+计时器代码是最容易写出「超时不杀进程」这类 bug 的做法。
 */
export function spawnCdpJson(args, { timeoutMs = DOUBAO_STATE_TIMEOUT_MS, script = CDP_SCRIPT, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let timer
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }

    let child
    try {
      child = spawnImpl(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ failed: true, error: String(error?.message ?? error) })
      return
    }

    let stdout = ''
    let stderr = ''
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出了 */
      }
      finish({ failed: true, timedOut: true, stdout, stderr, error: `超时（${timeoutMs}ms）` })
    }, timeoutMs)

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on?.('data', (chunk) => {
      stderr += chunk
    })
    child.on?.('error', (error) => finish({ failed: true, error: String(error?.message ?? error) }))
    child.on?.('close', (code) => finish({ failed: false, code, stdout, stderr }))
  })
}

/**
 * 读豆包当前的模式 + 模型：spawn `cdp.mjs state --json` 并解析。
 *
 * 为什么用子进程而不是 import：cdp.mjs 是 CLI（`main()` + CDP 连接），跑在独立的
 * 进程里，卡住或崩掉都不会拖累 DSH 的 web 服务；而且 DOM 选择器只有它那一份。
 * **任何失败都降级成 connected:false**——「豆包没开」是正常状态，不是接口错误。
 */
export async function readDoubaoState(options = {}) {
  const args = ['state', '--json']
  // 目标（personal / work）：读的是哪个 App 必须显式带上，绝不靠环境变量碰运气。
  if (typeof options.target === 'string' && options.target.length > 0) args.push('--target', options.target)
  const run = await spawnCdpJson(args, { timeoutMs: DOUBAO_STATE_TIMEOUT_MS, ...options })
  if (run.failed === true) return doubaoStateUnavailable(run.error)
  const parsed = parseDoubaoState(run.stdout)
  if (parsed === null) {
    return doubaoStateUnavailable(run.stderr.trim() || `state 输出无法解析（退出码 ${run.code}）`)
  }
  return parsed
}

/**
 * 快照缓存（stale-while-revalidate）：
 *   - TTL 内直接用缓存，不打 CDP；
 *   - 过期后**先把旧值回给面板**，后台刷新一次——面板每 2 秒轮询，不该被一次
 *     最长 8 秒的 CDP 往返拖住；
 *   - 首次没有任何值时，才等这一次刷新；
 *   - 失败也进缓存（带 error），免得豆包没开时每 2 秒 spawn 一个进程。
 *
 * 调用时可以带 `{ ttlMs, allowRefresh }`：
 *   - `ttlMs` 允许请求方（面板的设置项）覆盖默认采样间隔，用来把「菜单闪烁」调稀；
 *   - `allowRefresh: false`（设置成「仅悬停时采样」的普通轮询）时**过期也不刷新**，
 *     直接把旧值给出去；一次都没采过就返回 undefined，由调用方决定怎么显示。
 */
export function createDoubaoStateCache({ read = readDoubaoState, ttlMs = DOUBAO_STATE_TTL_MS, now = Date.now } = {}) {
  let cached
  let inflight
  const readCached = async ({ ttlMs: ttlOverride, allowRefresh = true } = {}) => {
    const ttl = Number.isFinite(ttlOverride) ? ttlOverride : ttlMs
    if (cached !== undefined && now() - cached.at < ttl) return cached.state
    // 「不主动采样」：过期也不刷新。没有旧值就交 undefined，让调用方显示「尚未采样」。
    if (allowRefresh !== true) return cached === undefined ? undefined : cached.state
    if (inflight === undefined) {
      inflight = Promise.resolve()
        .then(() => read())
        .catch((error) => doubaoStateUnavailable(error?.message ?? error))
        .then((state) => {
          cached = { at: now(), state }
          return state
        })
        .finally(() => {
          inflight = undefined
        })
    }
    return cached !== undefined ? cached.state : inflight
  }
  // 切换模式之后必须立刻失效，否则面板还会显示 15 秒的旧模式——那正是
  // 「点了没反应」的观感来源。
  readCached.invalidate = () => {
    cached = undefined
  }
  return readCached
}

/* ------------------------------------------------- 额度 / 模型清单（只读采样） */

/**
 * 额度窗口的归一化：只保留能确定的东西，缺字段给安全默认值。
 * `usedPercent` 夹到 0..100；`approximate`（页面写「<1%」这种）原样带出，
 * 让界面显示原文，而不是把「不到 1%」显示成 1%。
 */
function normalizeQuotaWindow(window) {
  const label = typeof window?.label === 'string' ? window.label.trim() : ''
  const short = typeof window?.short === 'string' && window.short.trim().length > 0 ? window.short.trim() : label
  if (label.length === 0 && short.length === 0) return null
  const usedText = typeof window?.usedText === 'string' ? window.usedText.trim() : ''
  const percent = Number(window?.usedPercent)
  return {
    id: typeof window?.id === 'string' && window.id.length > 0 ? window.id : 'window',
    short: short.length > 0 ? short : label,
    label: label.length > 0 ? label : short,
    ...(usedText.length > 0 ? { usedText } : {}),
    usedPercent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
    approximate: window?.approximate === true,
    ...(typeof window?.resetText === 'string' && window.resetText.trim().length > 0
      ? { resetText: window.resetText.trim() }
      : {}),
  }
}

/**
 * 解析 `cdp.mjs quota --json`。
 *
 * `ok` 只在**真的读到百分比**时为 true——读不到就是读不到，绝不猜一个 0 或 100。
 *
 * 兼容两种载荷：
 *   - 有 `windows`（额度页读到的 5h/7d 两个窗口，首选）；
 *   - 只有扁平的 `usedPercent`（降级到账户菜单那一个数字时）。
 * 两种情况下都给 `usedPercent`（取第一个窗口），老调用方不用改。
 */
export function parseDoubaoQuota(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const windows = (Array.isArray(parsed.windows) ? parsed.windows : [])
    .map((window) => normalizeQuotaWindow(window))
    .filter((window) => window !== null)

  const flatRaw = Number(parsed.usedPercent)
  const flat =
    windows.length > 0
      ? windows[0].usedPercent
      : Number.isFinite(flatRaw)
        ? Math.max(0, Math.min(100, Math.round(flatRaw)))
        : undefined

  return {
    ok: parsed.ok === true && (windows.length > 0 || flat !== undefined),
    ...(flat !== undefined ? { usedPercent: flat } : {}),
    ...(windows.length > 0 ? { windows } : {}),
    ...(parsed.degraded === true ? { degraded: true } : {}),
    ...(typeof parsed.windowsError === 'string' && parsed.windowsError.length > 0
      ? { windowsError: parsed.windowsError }
      : {}),
    ...(typeof parsed.plan === 'string' && parsed.plan.length > 0 ? { plan: parsed.plan } : {}),
    ...(Number.isFinite(parsed.resets) ? { resets: parsed.resets } : {}),
    at: Number.isFinite(parsed.at) ? parsed.at : Date.now(),
    ...(typeof parsed.error === 'string' && parsed.error.length > 0 ? { error: parsed.error } : {}),
  }
}

/** 解析 `cdp.mjs models --json`。items 里的 name 为空或重复的会被丢掉/合并。 */
export function parseDoubaoModels(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const items = Array.isArray(parsed.items) ? parsed.items : []
  const seen = new Set()
  const cleaned = []
  for (const item of items) {
    const name = typeof item?.name === 'string' ? item.name.trim() : ''
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    cleaned.push({
      name,
      note: typeof item?.note === 'string' ? item.note.trim() : '',
      current: item?.current === true,
    })
  }
  return {
    ok: parsed.ok === true && cleaned.length > 0,
    ...(typeof parsed.current === 'string' && parsed.current.length > 0 ? { current: parsed.current } : {}),
    items: cleaned,
    at: Number.isFinite(parsed.at) ? parsed.at : Date.now(),
    ...(typeof parsed.error === 'string' && parsed.error.length > 0 ? { error: parsed.error } : {}),
  }
}

/** 额度采样（读不到返回 `ok:false` + 原因，不抛）。 */
export async function readDoubaoQuota(options = {}) {
  const run = await spawnCdpJson(['quota', '--json'], { timeoutMs: DOUBAO_SAMPLE_TIMEOUT_MS, ...options })
  if (run.failed === true) return { ok: false, error: run.error, at: Date.now() }
  const parsed = parseDoubaoQuota(run.stdout)
  if (parsed === null) {
    return { ok: false, error: run.stderr.trim() || `quota 输出无法解析（退出码 ${run.code}）`, at: Date.now() }
  }
  return parsed
}

/** 模型清单采样（读不到返回 `ok:false` + 原因，不抛）。 */
export async function readDoubaoModels(options = {}) {
  const run = await spawnCdpJson(['models', '--json'], { timeoutMs: DOUBAO_SAMPLE_TIMEOUT_MS, ...options })
  if (run.failed === true) return { ok: false, items: [], error: run.error, at: Date.now() }
  const parsed = parseDoubaoModels(run.stdout)
  if (parsed === null) {
    return { ok: false, items: [], error: run.stderr.trim() || `models 输出无法解析（退出码 ${run.code}）`, at: Date.now() }
  }
  return parsed
}

/**
 * 菜单互斥队列。
 *
 * 为什么必须串行：**额度采样、模型清单采样、模式切换都要点开豆包的菜单**。两个同时跑
 * 就会互相点错——A 刚打开的菜单被 B 的点击打断，然后 A 读到一个跟自己无关的面板，
 * 甚至可能点到菜单项上（那是写操作）。所以它们共用一条队列：同一时刻只有一个在跑。
 * 只读的 `state` 不排队（它不开菜单）。
 */
export function createSerialQueue() {
  let tail = Promise.resolve()
  return function enqueue(operation) {
    const result = tail.then(operation, operation)
    // 队列本身不因为一次失败而卡住：把拒绝吞掉，只保留顺序。
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** 宿主半默认用的那几份缓存 + 队列（整个进程一份）。 */
const menuQueue = createSerialQueue()
const defaultReadState = createDoubaoStateCache()
const defaultReadQuota = createDoubaoStateCache({
  read: () => menuQueue(() => readDoubaoQuota()),
  ttlMs: DOUBAO_QUOTA_TTL_MS,
})
const defaultReadModels = createDoubaoStateCache({
  read: () => menuQueue(() => readDoubaoModels()),
  ttlMs: DOUBAO_MODELS_TTL_MS,
})
/**
 * 豆包工作（9223）那一份运行时快照：**同一份实现**，只是带 `--target work`。
 *
 * 单独一份缓存的理由：两个 App 的连通性是独立的（豆包工作开了调试端口而个人版没开，
 * 或反过来），共用一个缓存会让其中一个的状态覆盖另一个。
 */
const defaultReadWorkState = createDoubaoStateCache({
  read: () => readDoubaoState({ target: 'work' }),
})
const defaultReadWorkQuota = createDoubaoStateCache({
  read: () => readDoubaoWorkQuota(),
  ttlMs: DOUBAO_QUOTA_TTL_MS,
})

/**
 * 解析 `cdp.mjs mode ... --json` 的输出。不是合法 JSON / 不是对象 → null。
 * 纯函数，便于密封测试。
 */
export function parseModeSwitch(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text ?? '').trim())
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return {
    ok: parsed.ok === true,
    changed: parsed.changed === true,
    modeBefore: typeof parsed.modeBefore === 'string' ? parsed.modeBefore : 'unknown',
    modeAfter: typeof parsed.modeAfter === 'string' ? parsed.modeAfter : 'unknown',
    ...(typeof parsed.option === 'string' && parsed.option.length > 0 ? { option: parsed.option } : {}),
    ...(typeof parsed.error === 'string' && parsed.error.length > 0 ? { error: parsed.error } : {}),
  }
}

/**
 * 切豆包模式：spawn `cdp.mjs mode <work|chat> --json` 并解析。
 *
 * 成败**以 cdp.mjs 的只读复核为准**（它点完会重新读模式，读不到目标就报 ok:false）。
 * 这里不做任何「我认为点成功了」的推断：拿不到可解析的输出就是失败。
 */
export async function switchDoubaoMode({ mode, timeoutMs = MODE_SWITCH_TIMEOUT_MS, ...options } = {}) {
  const failed = (error, extra = {}) => ({
    ok: false,
    changed: false,
    modeBefore: 'unknown',
    modeAfter: 'unknown',
    error: String(error),
    ...extra,
  })
  if (!MODE_SWITCH_VALUES.has(mode)) {
    return failed(`mode 只能是 ${[...MODE_SWITCH_VALUES].join(' 或 ')}`)
  }

  const run = await spawnCdpJson(['mode', mode, '--json'], { timeoutMs, ...options })
  if (run.failed === true) {
    // 超时**不代表失败**：cdp 可能已经点成功了。明确说「结果未知」，
    // 让面板去读一次 state 再说，而不是谎报成失败。
    return run.timedOut === true
      ? failed(`切换结果未知：超时（${timeoutMs}ms）`, { unsettled: true })
      : failed(run.error)
  }
  const parsed = parseModeSwitch(run.stdout)
  if (parsed === null) {
    return failed(run.stderr.trim() || `mode 输出无法解析（退出码 ${run.code}）`)
  }
  return parsed
}

/** 读取请求体（有上限、有超时）；空体当 `{}`。 */
function readJsonBody(req, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let text = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('读取请求体超时')), timeoutMs)
    req.setEncoding?.('utf8')
    req.on?.('data', (chunk) => {
      text += chunk
      if (text.length > MAX_BODY_BYTES) {
        finish(reject, new Error('请求体过大'))
        req.destroy?.()
      }
    })
    req.on?.('end', () => {
      if (text.trim().length === 0) {
        finish(resolve, {})
        return
      }
      try {
        finish(resolve, JSON.parse(text))
      } catch {
        finish(reject, new Error('请求体不是合法 JSON'))
      }
    })
    req.on?.('error', (error) => finish(reject, error))
  })
}

/**
 * 构造模式切换路由：`POST /doubao-status/api/mode`，体 `{"mode":"work"|"chat"}`。
 *
 * 纪律（写操作比读操作更严）：
 *   - **只认 POST**（其余 405 + `Allow: POST`）；
 *   - **只放行本机**（同一个来源围栏——这条会动你的豆包界面，LAN 来源绝不放）；
 *   - **模式白名单**：取值只能 work / chat，非法的直接 400，且**不会**去点任何东西；
 *   - 成败以 `cdp.mjs mode` 的只读复核为准，返回里带 modeBefore / modeAfter；
 *   - 成功后**立刻让快照缓存失效**，否则面板还会显示 15 秒的旧模式。
 */
export function createModeRoutes({
  switchMode = switchDoubaoMode,
  path = STATUS_MODE_PATH,
  fence = isLoopbackRequest,
  invalidate = () => {},
} = {}) {
  const handler = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
      res.end('method not allowed')
      return
    }
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, error: String(error?.message ?? error) })
      return
    }
    const mode = typeof body?.mode === 'string' ? body.mode.trim() : ''
    if (!MODE_SWITCH_VALUES.has(mode)) {
      writeJson(res, 400, { ok: false, error: `mode 只能是 ${[...MODE_SWITCH_VALUES].join(' 或 ')}` })
      return
    }

    let result
    try {
      result = await switchMode({ mode })
    } catch (error) {
      result = { ok: false, changed: false, modeBefore: 'unknown', modeAfter: 'unknown', error: String(error?.message ?? error) }
    }
    if (result?.ok === true) invalidate()
    // 切换失败是**预期结果**（豆包没开 / 菜单没找到），不是服务器内部错误：
    // 200 + ok:false + error，让面板把原因显示出来，而不是当成接口坏了。
    writeJson(res, 200, { ...result, mode })
  }
  return [{ kind: 'exact', path, handler }]
}

/** 状态标签（宿主半只用于日志/调试，界面文案在客户端半）。 */
export const STATE_LABELS = {
  received: '已接收',
  started: '工作开始',
  progress: '进行中',
  need_input: '需要确认',
  done: '已完成',
  failed: '失败',
}

/** 从时间线里取「最后已知」的正文/步骤/百分比（后到者胜，缺省则沿用早先的值）。 */
function latestExtras(events) {
  let message
  let step
  let percent
  for (const event of events) {
    if (typeof event.message === 'string' && event.message.length > 0) message = event.message
    if (typeof event.step === 'string' && event.step.length > 0) step = event.step
    if (Number.isFinite(event.percent)) percent = event.percent
  }
  return { message, step, percent }
}

/** 折叠后的 job 条目 → 面板条目（只做形状转换，不做判断）。 */
export function summarizeJob(entry, { now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const receivedAt = entry.events.find((event) => event.state === 'received')?.at
  const startedAt = entry.events.find((event) => event.state === 'started')?.at
  const { message, step, percent } = latestExtras(entry.events)
  const idleMs = now - (entry.lastAt ?? now)
  return {
    job: entry.job,
    state: entry.state,
    // 阶段：派发器写的 received 在前，豆包写的 started 在后（started 覆盖 received）。
    phase: startedAt !== undefined ? 'started' : receivedAt !== undefined ? 'received' : 'unknown',
    terminal: entry.terminal === true,
    ...(message !== undefined ? { message } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(percent !== undefined ? { percent } : {}),
    receivedAt: receivedAt ?? null,
    startedAt: startedAt ?? null,
    lastAt: entry.lastAt ?? null,
    idleMs,
    stale: idleMs > staleAfterMs,
  }
}

/**
 * 解析读取状态文件要用的 env。
 *
 * 为什么要多这一步（真机实测，不是猜的）：`queue.mjs` 的解析顺序是
 * `DSH_QUEUE_FILE` → `$DSH_HOME/mcp-connector` → `~/.dsh-mcp-connector`。而
 * **DSH Web 的宿主进程里没有 DSH_HOME**（它只注入到 agent 的 shell 里），
 * 于是插件会去读 `~/.dsh-mcp-connector/status.jsonl`，而豆包桥实际写的是
 * `~/.dsh/mcp-connector/status.jsonl` —— 接口能返回 200，但面板永远是空的。
 *
 * 所以：只有两个环境变量都没给时，才把 DSH_HOME 补成 DSH 自己的默认 home
 * （`~/.dsh`），与 CLI 侧的默认行为对齐。显式配置永远优先，绝不被覆盖。
 *
 * @param env 进程环境
 * @returns 可用于 loadConfig 的 env
 */
export function resolveStatusEnv(env = process.env) {
  if (env.DSH_QUEUE_FILE?.trim() || env.DSH_HOME?.trim()) return env
  return { ...env, DSH_HOME: join(homedir(), '.dsh') }
}

/**
 * 读状态文件，给出面板要的 job 列表。
 *
 * 「面板要的」= 还占着的（received/started/progress/need_input，含疑似卡死）
 *            + 刚终结的（TERMINAL_LINGER_MS 之内，让「已完成」可见）。
 * 按 lastAt 升序返回，调用方取最后一条即「最近发生的」。
 *
 * @param env 环境覆盖（决定 ini 与状态文件位置；测试用）
 * @param now 当前时间（测试用）
 */
/**
 * 连接器自己的客户端记录（`clients.json`，与 status.jsonl 同目录）。
 *
 * 为什么要它：豆包本体那条线，徽章能告诉你「执行端准备好了没」（模式 + 模型）。
 * 工作应用那条线走 MCP，徽章本来对它一无所知——它报的 job 能显示，但看不出
 * 「MCP 侧到底接上没有」。这里把连接器记录的真实客户端读出来给悬停提示用。
 *
 * 两点诚实处理：
 *   - **过滤自检/测试用的名字**（`dsh-setup-check`、`local-check`、`selftest-*` …），
 *     否则「我自己探过端点」会被说成「有客户端接上了」；
 *   - 文件不存在是**正常状态**（连接器没跑过），标 `missing` 而不报错；
 *     文件存在但读坏才带 `error`。
 */
export const SELF_CHECK_CLIENT_NAMES = new Set(['dsh-setup-check', 'dsh-doctor', 'local-check', 'selftest'])

export async function readDoubaoConnectorClients({ env = process.env, now = Date.now() } = {}) {
  const config = loadConfig({ env: resolveStatusEnv(env) })
  const file = join(dirname(config.statusFile), 'clients.json')
  let parsed
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (String(error?.code ?? '') === 'ENOENT') return { file, clients: [], lastSeenAt: null, missing: true }
    return { file, clients: [], lastSeenAt: null, error: String(error?.message ?? error) }
  }
  const raw = Array.isArray(parsed?.clients) ? parsed.clients : []
  const clients = raw
    .filter((entry) => {
      const name = String(entry?.name ?? '')
      return name.length > 0 && !SELF_CHECK_CLIENT_NAMES.has(name) && !name.startsWith('selftest-')
    })
    .map((entry) => ({
      name: String(entry.name),
      version: typeof entry.version === 'string' ? entry.version : '',
      transport: typeof entry.transport === 'string' ? entry.transport : '',
      initializations: Number.isFinite(entry.initializations) ? entry.initializations : 0,
      lastSeenAt: Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : null,
      ageMs: Number.isFinite(entry.lastSeenAt) ? Math.max(0, now - entry.lastSeenAt) : null,
    }))
  const lastSeenAt = clients.reduce(
    (newest, client) => (client.lastSeenAt !== null && (newest === null || client.lastSeenAt > newest) ? client.lastSeenAt : newest),
    null,
  )
  return { file, clients, lastSeenAt, ...(clients.length === 0 ? { empty: true } : {}) }
}

/**
 * 豆包工作版的额度计数：点一次上下文圆环，读取「当前时段」与「近 7 天」窗口。
 *
 * 注意这是**会碰界面的读**（开一下弹层再收起），所以必须走缓存、而且遵守 `sample=0`（仅悬停才采样）——
 * 面板每 2 秒轮询，绝不能每 2 秒去点人家一次。
 */
export async function readDoubaoWorkQuota(options = {}) {
  const run = await spawnCdpJson(['context-window', '--json', '--target', 'work'], { timeoutMs: DOUBAO_SAMPLE_TIMEOUT_MS, ...options })
  if (run.failed === true) return { ok: false, error: run.error, at: Date.now() }
  const counters = (value) => {
    if (value === null || value === undefined) return null
    const used = Number(value.used)
    const limit = Number(value.limit)
    if (!Number.isFinite(used) || !Number.isFinite(limit)) return null
    return { used, limit, ...(typeof value.resetText === 'string' && value.resetText.length > 0 ? { resetText: value.resetText } : {}) }
  }
  let parsed
  try {
    parsed = JSON.parse(String(run.stdout ?? '').trim())
  } catch (error) {
    return { ok: false, error: `context-window 输出无法解析（退出码 ${run.code}）`, at: Date.now() }
  }
  const session = counters(parsed?.quota?.session)
  const week = counters(parsed?.quota?.week)
  // 上下文（绝对值 + 百分比）与 4 条明细：截图里那一整块数据的来源
  const context =
    parsed?.context !== null && parsed?.context !== undefined && Number.isFinite(Number(parsed.context.used)) && Number.isFinite(Number(parsed.context.total))
      ? {
          used: Number(parsed.context.used),
          total: Number(parsed.context.total),
          percent: Number.isFinite(Number(parsed.context.percent))
            ? Number(parsed.context.percent)
            : Math.round((Number(parsed.context.used) / Number(parsed.context.total)) * 1000) / 10,
        }
      : null
  const breakdown = Array.isArray(parsed?.breakdown)
    ? parsed.breakdown
        .filter((item) => item !== null && typeof item?.label === 'string' && Number.isFinite(Number(item?.percent)))
        .map((item) => ({ label: String(item.label), percent: Number(item.percent) }))
    : []
  if (session === null && week === null && context === null && breakdown.length === 0) {
    return { ok: false, error: 'context-window 里没有读数（多半是没有打开的对话）', at: Date.now() }
  }
  return { ok: true, context, breakdown, session, week, at: Date.now() }
}

export async function readPanelJobs({ env = process.env, now = Date.now(), lingerMs = TERMINAL_LINGER_MS } = {}) {
  const config = loadConfig({ env: resolveStatusEnv(env) })
  const folded = foldByJob(await readStatusEvents(config.statusFile))
  const jobs = openJobs(folded, { now }).map((entry) => summarizeJob(folded.get(entry.job), { now }))
  const seen = new Set(jobs.map((job) => job.job))
  for (const entry of folded.values()) {
    if (entry.terminal !== true) continue
    if (seen.has(entry.job)) continue
    if (now - (entry.lastAt ?? 0) > lingerMs) continue
    jobs.push(summarizeJob(entry, { now }))
  }
  jobs.sort((left, right) => (left.lastAt ?? 0) - (right.lastAt ?? 0))
  return { file: config.statusFile, now, warnings: config.warnings, jobs }
}

/* ---------------------------------------------------------------- 来源围栏 */

/**
 * 为什么要有围栏：真机实测，DSH 的 web 服务**监听 0.0.0.0:43120**，而 GUI 页面
 * 本身对非本机访问是要鉴权的（`GET /` 返回 401）。插件路由跑在鉴权之前，
 * 所以一条不加围栏的只读路由 = **绕过 GUI 的鉴权**，把任务的 job id / 正文 /
 * 结果摘要暴露给同网段的人。dsh-update 的写接口就是因此加了同样的围栏。
 *
 * 语义（与 dsh-family 共用的 loopback 围栏一致，减少分叉）：
 * socket 地址属于 127/8、::1、或 IPv4-mapped ::ffff:127/8，**并且** Host 头
 * 也是回环地址（localhost / [::1] / 127/8），并且不是浏览器标记的跨站请求。
 * socket 地址是权威依据，永不信任 X-Forwarded-For。
 *
 * 代价（如实说明）：从**远程**（手机 / LAN 地址）打开 GUI 时，徽章拿不到数据会
 * 自动隐藏。想放开就把下方 `createStatusRoutes` 的 `fence` 换成 `() => true`，
 * 但要清楚那等于把任务状态开给同网段。
 */
function isIPv4Loopback(value) {
  const parts = String(value).split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** socket 地址是不是回环（127/8、::1、IPv4-mapped）。 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Host 头的主机名是不是回环（localhost、[::1]、127/8）。 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** 请求级围栏：回环 socket + 回环 Host + 非跨站标记。 */
export function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const host = req?.headers?.host
  if (typeof host !== 'string' || host.length === 0) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- 路由 */

/** 只写 JSON 响应体的小工具（不引入任何框架）。 */
function writeJson(res, status, body) {
  const text = `${JSON.stringify(body)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/**
 * 构造只读路由（测试缝：`read` / `readState` / `readQuota` / `readModels` / `fence`
 * 都可替换，于是密封测试不需要 DSH、不需要真文件、也不需要豆包）。
 *
 * 默认载荷 = 状态文件的 job 列表 + 豆包运行时快照（模式 + 模型）
 *          + 额度采样 + 模型清单采样。
 *
 * @param read 读 job 数据的方式，默认读真实状态文件（与快照/采样合成）
 * @param path 路由路径
 * @param fence 来源围栏，默认只放行本机
 * @param readState 读豆包运行时快照的方式，默认 spawn `cdp.mjs state`（带 15 秒缓存）
 * @param readQuota 读额度采样的方式，默认 spawn `cdp.mjs quota`（60 秒采样 + 菜单互斥）
 * @param readModels 读模型清单的方式，默认 spawn `cdp.mjs models`（60 秒采样 + 菜单互斥）
 * @returns 可直接交给 `ctx.webServer.register` 的路由数组
 */
export function createStatusRoutes({
  read,
  path = STATUS_API_PATH,
  fence = isLoopbackRequest,
  readState = defaultReadState,
  readQuota = defaultReadQuota,
  readModels = defaultReadModels,
  readWorkState = defaultReadWorkState,
  readWorkQuota = defaultReadWorkQuota,
  readClients = readDoubaoConnectorClients,
} = {}) {
  const readAll =
    read ??
    (async (req) => {
      // 采样间隔由请求方（面板设置项）用查询参数指定；`sample=0` 表示「这次别开菜单」。
      const sample = parseSampleQuery(req?.url)
      const unset = (what) => ({
        ok: false,
        ...(what === 'models' ? { items: [] } : {}),
        error: '尚未采样（面板设置为仅悬停时采样）',
        at: Date.now(),
      })
      // 五路并发：任务列表 / 运行时快照 / 额度 / 模型清单 / MCP 连接器客户端。
      // 额度与模型清单内部已经过菜单互斥队列，所以并发发起也不会互相点错。
      const [panel, state, quota, models, mcp, work, workQuota] = await Promise.all([
        readPanelJobs(),
        // 每个读取自己已经降级过一次；这里再兜一层：一个坏掉的读取
        // 绝不能把「任务列表」这个主功能一起带下去。
        readState().catch((error) => doubaoStateUnavailable(error?.message ?? error)),
        readQuota({ ttlMs: sample.quotaTtlMs, allowRefresh: sample.allowRefresh })
          .then((value) => value ?? unset('quota'))
          .catch((error) => ({ ok: false, error: String(error?.message ?? error), at: Date.now() })),
        readModels({ ttlMs: sample.modelsTtlMs, allowRefresh: sample.allowRefresh })
          .then((value) => value ?? unset('models'))
          .catch((error) => ({ ok: false, items: [], error: String(error?.message ?? error), at: Date.now() })),
        // 读不到就是没跑过连接器，是正常状态——所以这里不需要 catch 兜底，函数自己降级。
        readClients(),
        // 豆包工作那条线：读得到就显示，读不到（没带调试端口启动）也是正常状态。
        readWorkState().catch((error) => doubaoStateUnavailable(error?.message ?? error)),
        // 额度计数：会碰界面（点一次圆环），所以只在允许采样时刷（60 秒缓存）。
        readWorkQuota({ ttlMs: sample.quotaTtlMs, allowRefresh: sample.allowRefresh }).then((value) => value ?? unset('workQuota')),
      ])
      return { ...panel, doubao: state, quota, models, mcp, work, workQuota }
    })
  const handler = async (req, res) => {
    // 只读：GET 之外一律 405，且不解析请求体（POST 不可能有副作用）。
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
      res.end('method not allowed')
      return
    }
    // 非本机来源：拒绝（否则这条路由等于绕过 GUI 的鉴权）。
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden' })
      return
    }
    try {
      // 把请求（含查询串）交给 readAll：采样间隔与「这次要不要开菜单」由它解析。
      const data = await readAll(req)
      writeJson(res, 200, { ok: true, ...data })
    } catch (error) {
      // 真出错了就说清楚，不要伪装成「没有任务」。
      writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
  return [{ kind: 'exact', path, handler }]
}

/**
 * 宿主半入口：把只读路由与模式切换路由挂到 DSH 自己的 webServer 上。
 * 用 `ctx.effect` 管理生命周期，卸载插件时路由会被摘掉（不留下悬空 handler）。
 *
 * @param ctx 宿主插件上下文（需要 webServer 服务）
 */
export function apply(ctx) {
  ctx.effect(() => {
    const routes = [
      ...createStatusRoutes(),
      ...createModeRoutes({
        // 切模式也要排队：它同样要点开菜单，不能和额度/模型采样撞在一起。
        switchMode: (args) => menuQueue(() => switchDoubaoMode(args)),
        // 切换成功后让缓存立刻失效，否则面板还会显示旧模式/旧模型 15~60 秒。
        // 注意：真机上模式与模型是绑定的（切到工作模式会连带换成豆包 2.1 Lite），
        // 所以模型清单的缓存也必须一起失效。
        invalidate: () => {
          defaultReadState.invalidate()
          defaultReadModels.invalidate()
          defaultReadQuota.invalidate()
        },
      }),
    ]
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'doubao-status-panel: 只读状态接口 + 模式切换')
}
