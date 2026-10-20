#!/usr/bin/env node
/**
 * doubao.mjs — 连接豆包之前先「确认它确实可被驱动」。
 *
 * 原来的失败长这样：
 *     error: fetch failed
 * 这句话没告诉用户任何事情。实际上有三种完全不同的状态，处理方式也不同：
 *
 *   1. 豆包没运行                    → 去启动它
 *   2. 豆包在运行，但没开调试端口     → 必须带参数重启（本模块最常见的情形）
 *   3. 端口通但没有匹配的页面         → 调试开着，但不是我们要驱动的那个视图
 *
 * 本模块只做**检测与说明**，不会去结束或重启豆包——那属于用户的操作。
 */

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { resolveQueueDir } from '../dsh-mcp-connector/queue.mjs'
import { foldByJob, openJobs, readStatusEvents } from './status.mjs'

/**
 * 把「上下文用量」圆环的 DOM 读数解析成百分比。**纯函数**（自测用）。
 *
 * 用量画在 `conic-gradient` 的角度里：`角度 / 360 = 比例`。
 * 角度缺失 / 非法 / 越界 → percent 为 null（读不到就是读不到，**不猜 0**——猜错比没有更糟）。
 *
 * 注：这个控件**两个 App 都有，但只在打开的对话里出现**。所以「找不到」要分两种情况说，
 * 不能把「没打开对话」当成「这台 App 没有」——我一开始就是这么误判的。
 */
export function parseContextUsage(raw) {
  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { found: false, percent: null, angleDeg: null, contextOpen: false, reason: 'unreadable' }
    }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.found !== true) {
    // 读不到要分两种情况，否则会把「没打开对话」误报成「这台 App 没有这个控件」：
    //   - 页面上有消息 → 对话是开着的，那就是这台 App 真的没有这个控件；
    //   - 一条消息都没有 → 多半是没有打开的对话（控件只在打开的对话里出现）。
    const contextOpen = Number(parsed?.messageCount) > 0
    return {
      found: false,
      percent: null,
      angleDeg: null,
      contextOpen,
      reason: contextOpen ? 'unsupported' : 'no-open-conversation',
      messageCount: Number.isFinite(Number(parsed?.messageCount)) ? Number(parsed.messageCount) : null,
    }
  }
  const angle = Number(parsed.angleDeg)
  const valid = Number.isFinite(angle) && angle >= 0 && angle <= 360
  return {
    found: true,
    label: typeof parsed.label === 'string' ? parsed.label : '上下文用量',
    angleDeg: valid ? angle : null,
    percent: valid ? Math.round((angle / 360) * 10_000) / 100 : null,
    contextOpen: true,
  }
}

/**
 * 解析「上下文窗口」点开后的那坨文本（**纯函数**，自测用）。
 *
 * 测试用合成文本覆盖上下文摘要、分类占比和两个额度窗口。
 * 示例：12.5K/64K · 19.5%，当前时段 12/500，近 7 天 800/3,000。
 *
 * 它同时给了两样东西：**上下文明细**，以及**账户额度**（当前时段 / 近 7 天，计数形式）。
 * 所以额度不必去点「设置 → 订阅与额度」那条会闪菜单的长链——点这个圆环就够。
 * 解析不出就返回 found:false，绝不用 0 充数。
 */
export function parseContextPanel(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return { found: false }
  const toNumber = (raw) => {
    const value = String(raw ?? '').replace(/,/g, '').trim()
    const k = /^([0-9.]+)K$/i.exec(value)
    return k ? Math.round(Number(k[1]) * 1000) : Number(value)
  }
  const contextMatch = /([0-9.]+K?)\s*\/\s*([0-9.]+K?)\s*·\s*([0-9.]+)%/.exec(flat)
  const context = contextMatch === null ? null : { used: toNumber(contextMatch[1]), total: toNumber(contextMatch[2]), percent: Number(contextMatch[3]) }
  // 明细：形如「对话消息 5%」（扁平化之后标签与数字相邻）
  const slice = flat.slice(0, flat.indexOf('额度用量') === -1 ? flat.length : flat.indexOf('额度用量'))
  const breakdown = []
  const breakdownRe = /([^\s0-9.%][^\s%]*)\s*([0-9]+(?:\.[0-9]+)?)%/g
  let hit
  while ((hit = breakdownRe.exec(slice)) !== null) {
    const label = hit[1].replace(/^.*上下文用量\s*/, '').trim()
    // The separator in the context summary must not be parsed as a category label.
    if (/^[^\p{L}\p{N}]+$/u.test(label)) continue
    if (label.length > 0 && label !== '上下文用量') breakdown.push({ label, percent: Number(hit[2]) })
  }
  const session = /当前时段\s*(?:([0-9:]+)\s*后重置)?\s*·?\s*已用\s*([0-9,]+)\s*\/\s*([0-9,]+)/.exec(flat)
  const week = /近\s*7\s*天\s*已用\s*([0-9,]+)\s*\/\s*([0-9,]+)/.exec(flat)
  return {
    found: true,
    context,
    breakdown,
    quota: {
      session: session === null ? null : { resetText: session[1] ?? '', used: toNumber(session[2]), limit: toNumber(session[3]) },
      week: week === null ? null : { used: toNumber(week[1]), limit: toNumber(week[2]) },
    },
  }
}

/**
 * 两个可驱动的目标：豆包个人版（9222）与豆包工作（9223）。
 *
 * 2026-10-16 实测：豆包工作是 Chromium 147，**同样认 `--remote-debugging-port`**，
 * 主页面是 `doubaowork://doubaowork-chat/chat`——所以同一套工具换两个值就能驱动它。
 */
export const CDP_TARGETS = {
  personal: { port: 9222, match: 'doubao-chat/chat', label: '豆包（个人版）' },
  work: { port: 9223, match: 'doubaowork-chat/chat', label: '豆包工作' },
}

/**
 * 目标解析，优先级从高到低：
 *   1. 显式 `--port` / `--match`
 *   2. `--target <personal|work>`
 *   3. 环境变量 `DOUBAO_CDP_PORT` / `CDP_PORT` / `CDP_MATCH`（历史用法，保持兼容）
 *   4. 默认 `personal`
 *
 * 返回值带 `source`，让 doctor 能说清「这个端口是哪儿来的」，而不是让人猜。
 */
export function resolveCdpTarget({ target, port, match, env = process.env } = {}) {
  const name = target === undefined || target === '' ? undefined : String(target)
  if (name !== undefined && CDP_TARGETS[name] === undefined) {
    throw new Error(`未知目标：${name}（可用：${Object.keys(CDP_TARGETS).join(' | ')}）`)
  }
  const base = name !== undefined ? CDP_TARGETS[name] : undefined
  const envPort = Number(env.DOUBAO_CDP_PORT ?? env.CDP_PORT ?? Number.NaN)
  const hasEnvPort = Number.isFinite(envPort)
  const envMatch = typeof env.CDP_MATCH === 'string' && env.CDP_MATCH.length > 0 ? env.CDP_MATCH : undefined

  let resolvedPort
  let resolvedMatch
  let source
  if (name !== undefined) {
    resolvedPort = base.port
    resolvedMatch = base.match
    source = `--target ${name}`
  } else if (hasEnvPort || envMatch !== undefined) {
    resolvedPort = hasEnvPort ? envPort : CDP_TARGETS.personal.port
    resolvedMatch = envMatch ?? CDP_TARGETS.personal.match
    source = hasEnvPort && envMatch !== undefined ? 'CDP_PORT+CDP_MATCH' : hasEnvPort ? 'CDP_PORT' : 'CDP_MATCH'
  } else {
    resolvedPort = CDP_TARGETS.personal.port
    resolvedMatch = CDP_TARGETS.personal.match
    source = '默认（个人版）'
  }
  if (port !== undefined && Number.isFinite(Number(port))) {
    resolvedPort = Number(port)
    source = `${source} + --port`
  }
  if (match !== undefined && String(match).length > 0) {
    resolvedMatch = String(match)
    source = `${source} + --match`
  }
  const name2 = name ?? (resolvedPort === CDP_TARGETS.work.port ? 'work' : 'personal')
  return { name: name2, port: resolvedPort, match: resolvedMatch, label: CDP_TARGETS[name2].label, source }
}

/** 调试端口：DOUBAO_CDP_PORT 优先，其次是历史变量 CDP_PORT，最后 9222。 */
export const CDP_PORT = Number(process.env.DOUBAO_CDP_PORT ?? process.env.CDP_PORT ?? 9222)

/** 需要驱动的页面。 */
export const CDP_MATCH = process.env.CDP_MATCH ?? 'doubao-chat/chat'

/** 确认失败时的退出码，与「一般错误 = 1」区分开，方便脚本判断。 */
export const PREFLIGHT_EXIT_CODE = 3

/** 探测调试端口是否在监听。 */
export async function probeDebugPort(port = CDP_PORT, timeoutMs = 2000) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { up: false, detail: `HTTP ${response.status}` }
    const version = await response.json().catch(() => ({}))
    return { up: true, detail: version.Browser ?? 'CDP endpoint', version }
  } catch (error) {
    const code = error?.cause?.code ?? error?.name ?? 'fetch failed'
    return { up: false, detail: String(code) }
  }
}

/** 列出可能的豆包可执行文件路径，供提示信息使用。 */
function candidatePaths() {
  return [
    process.env.DOUBAO_BIN?.trim(),
    'E:\\Doubao\\app\\Doubao.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Doubao', 'app', 'Doubao.exe'),
    join(process.env.PROGRAMFILES ?? '', 'Doubao', 'app', 'Doubao.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Doubao', 'app', 'Doubao.exe'),
  ].filter((value) => typeof value === 'string' && value.length > 0)
}

/** 运行中的豆包进程（Windows；其它平台返回空数组）。 */
export function doubaoProcesses() {
  if (process.platform !== 'win32') return []
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Doubao.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return []
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('"'))
    .map((line) => {
      const columns = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1)) ?? []
      return { name: columns[0], pid: Number(columns[1]) }
    })
    .filter((entry) => Number.isFinite(entry.pid))
}

/** 正在运行的豆包可执行文件路径（Windows），拿不到就返回 undefined。 */
export function runningDoubaoPath() {
  if (process.platform !== 'win32') return undefined
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-Process Doubao -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 8000 },
  )
  const path = (result.stdout ?? '').trim()
  return path.length > 0 ? path : undefined
}

/** 解析用于提示的豆包可执行文件路径。 */
export function resolveDoubaoExe() {
  const fromEnv = process.env.DOUBAO_BIN?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return { path: fromEnv, source: 'DOUBAO_BIN' }
  const running = runningDoubaoPath()
  if (running !== undefined) return { path: running, source: '运行中的进程' }
  const existing = candidatePaths().find((candidate) => existsSync(candidate))
  if (existing !== undefined) return { path: existing, source: '常见安装路径' }
  return { path: 'Doubao.exe', source: '未找到，请用 DOUBAO_BIN 指定' }
}

/** 汇总一次完整的确认结果。 */
export async function inspectDoubao({ port = CDP_PORT, match = CDP_MATCH } = {}) {
  const probe = await probeDebugPort(port)
  const processes = doubaoProcesses()
  let targets = []
  if (probe.up) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
      targets = await response.json()
    } catch {
      targets = []
    }
  }
  const matching = targets.filter((target) => target.type === 'page' && String(target.url).includes(match))
  return {
    port,
    match,
    probe,
    processes,
    targets,
    matching,
    exe: resolveDoubaoExe(),
    ready: probe.up && matching.length > 0,
  }
}

/** 把确认结果渲染成给人看的报告。 */
export function formatDoubaoReport(state) {
  const { port, match, probe, processes, matching, exe } = state
  const lines = ['豆包启动确认']
  lines.push(`  调试端口 127.0.0.1:${port} : ${probe.up ? `监听中（${probe.detail}）` : `未监听（${probe.detail}）`}`)
  lines.push(
    `  豆包进程                 : ${
      processes.length === 0
        ? '未检测到'
        : `运行中 (${processes.length > 1 ? `${processes.length} 个进程，主进程 PID ${processes[0].pid}` : `PID ${processes[0].pid}`})`
    }`,
  )
  if (probe.up) lines.push(`  目标页面 "${match}"     : ${matching.length} 个匹配 / 共 ${state.targets.length} 个页面`)
  lines.push(`  可执行文件               : ${exe.path}  (来源: ${exe.source})`)

  if (state.ready) {
    lines.push('', '  ✓ 已确认：可以连接并驱动豆包。')
    return lines.join('\n')
  }

  lines.push('')
  if (!probe.up && processes.length > 0) {
    lines.push('  ✗ 不能连接：豆包正在运行，但没有开调试端口。')
    lines.push('    也就是说它当初是正常启动的，需要带参数重启才能被驱动：')
    lines.push('      1) 退出豆包')
    lines.push('      2) 运行：')
    lines.push(`         "${exe.path}" --remote-debugging-port=${port} --remote-allow-origins=*`)
  } else if (!probe.up) {
    lines.push('  ✗ 不能连接：豆包没有运行，也没有调试端口。')
    lines.push('    带参数启动它：')
    lines.push(`      "${exe.path}" --remote-debugging-port=${port} --remote-allow-origins=*`)
  } else {
    lines.push(`  ✗ 不能连接：端口是通的，但没有 url 包含 "${match}" 的 page 目标。`)
    lines.push('    可能豆包停在了别的视图（启动页 / 登录页）。用下面这条看现有页面：')
    lines.push('      node cdp.mjs targets')
    lines.push(`    也可以换匹配串：$env:CDP_MATCH="doubao"; node cdp.mjs doctor`)
  }

  lines.push('')
  lines.push('  注意：开着调试端口期间，本机任意进程都能接管你的豆包')
  lines.push('        （读全部聊天记录、以你的身份发消息）。用完请退出豆包并正常启动，即可关掉。')
  lines.push('  确认这一段也可以单独跑：node cdp.mjs doctor')
  lines.push('  确实想跳过确认：加 --no-preflight')
  return lines.join('\n')
}

/** 需要时直接确认，失败就返回报告。 */
export async function ensureDoubao(options = {}) {
  const state = await inspectDoubao(options)
  return { ok: state.ready, state, report: formatDoubaoReport(state) }
}

/* ==================== 调用前状态识别（五维，R27–R35） ==================== */

/** 判定结果。ready / not-ready / unknown 三态必须区分（R35）。 */
export const VERDICTS = { READY: 'ready', NOT_READY: 'not-ready', UNKNOWN: 'unknown' }

/** 退出码：0 通过，3 未就绪，8 无法识别——都拒绝发送，但原因不同。 */
export const PRECHECK_EXIT = { ready: 0, 'not-ready': 3, unknown: 8 }

/** 页面模式控件的文字 → 模式标识。不认识就 unknown，绝不猜。 */
export function mapModeText(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return { id: 'unknown', raw: value }
  if (value.includes('对话')) return { id: 'chat', raw: value }
  if (value.includes('电脑') || value.includes('工作')) return { id: 'work', raw: value }
  return { id: 'unknown', raw: value }
}

/** 模式 → 命令能力：状态回报依赖工作模式的 shell（R27.4）。 */
export function commandCapability(modeId) {
  if (modeId === 'work') return 'yes'
  if (modeId === 'chat') return 'no'
  return 'unknown'
}

/**
 * 模型控件里读到的「全文 + 档位」→ 干净的模型名。
 *
 * 真机实测（豆包 2.x 桌面版）：`[data-testid=chat_input_action_model]` 的
 * `innerText` 是 `豆包 2.1 Lite低` —— 末尾那个「低」是**同层的一个档位 span**
 * （`text-dbx-text-tertiary`），不是模型名的一部分。直接显示会把档位粘在名字上。
 * 所以读的时候把档位单独取出来，这里再按后缀把它从全文里剥掉。
 *
 * 纯函数：不碰 DOM，便于密封测试。档位为空或不是后缀时，原样返回全文。
 *
 * @param fullText 控件全文（例如 `豆包 2.1 Lite低`）
 * @param levelText 档位文字（例如 `低`）
 */
export function splitModelText(fullText, levelText = '') {
  const full = String(fullText ?? '').trim()
  const level = String(levelText ?? '').trim()
  if (level.length > 0 && full.endsWith(level)) {
    return { model: full.slice(0, -level.length).trim(), level }
  }
  return { model: full, level: level.length > 0 ? level : '' }
}

/** 通道可用性：状态目录能不能真的写进去（R27.5）。 */
export async function checkChannel(env = process.env) {
  const dir = resolveQueueDir(env)
  const probe = join(dir, '.channel-probe')
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(probe, '', 'utf8')
    await rm(probe, { force: true })
    return { writable: true, dir }
  } catch (error) {
    return { writable: false, dir, error: error.message }
  }
}

/** 忙闲：有 started 无终态的 job（R27.3）。 */
export async function openJobSummary(env = process.env) {
  const file = join(resolveQueueDir(env), 'status.jsonl')
  const jobs = foldByJob(await readStatusEvents(file))
  return { file, open: openJobs(jobs) }
}

/**
 * 五维识别。任何一维「不清楚」都算 unknown，而不是默认放行。
 * mode 由调用方传入（DOM 读取在 cdp.mjs；诊断/测试可用 --mode 指定）。
 */
export async function inspectPreCall({ port = CDP_PORT, match = CDP_MATCH, mode, env = process.env } = {}) {
  const connectivity = await probeDebugPort(port)
  const processes = doubaoProcesses()
  let matching = []
  if (connectivity.up) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
      const targets = await response.json()
      matching = targets.filter((target) => target.type === 'page' && String(target.url).includes(match))
    } catch {
      matching = []
    }
  }

  const modeInfo = mode ?? { id: 'unknown', raw: '' }
  const capability = commandCapability(modeInfo.id)
  const channel = await checkChannel(env)
  const activity = await openJobSummary(env)
  const busy = activity.open.filter((entry) => !entry.stale)
  const stuck = activity.open.filter((entry) => entry.stale)

  const reasons = []
  const reachable = connectivity.up && matching.length > 0
  if (!connectivity.up) reasons.push(`调试端口 ${port} 未监听（${connectivity.detail}）`)
  else if (matching.length === 0) reasons.push(`端口通但没有 url 含 "${match}" 的页面`)
  if (modeInfo.id === 'unknown') reasons.push('无法识别当前模式（读不到模式控件）')
  else if (capability === 'no') reasons.push('当前是「对话」模式：没有 shell，无法回报状态')
  if (busy.length > 0) reasons.push(`有未结束的任务在跑：${busy.map((entry) => entry.job).join(', ')}`)
  if (stuck.length > 0) reasons.push(`疑似卡死（>10 分钟无事件）：${stuck.map((entry) => entry.job).join(', ')}`)
  if (!channel.writable) reasons.push(`状态目录不可写：${channel.dir}`)

  // 判定顺序很重要：连通性已经坏掉时，那就是结论（更具体、更可操作）；
  // 只有当「端口是通的、别的也都满足、唯独模式读不出来」时才判 unknown。
  const verdict = !reachable
    ? VERDICTS.NOT_READY
    : modeInfo.id === 'unknown'
      ? VERDICTS.UNKNOWN
      : reasons.length > 0
        ? VERDICTS.NOT_READY
        : VERDICTS.READY

  return {
    verdict,
    reasons,
    dimensions: {
      connectivity: { ok: connectivity.up && matching.length > 0, detail: connectivity.detail, matching: matching.length },
      mode: { id: modeInfo.id, raw: modeInfo.raw, ok: modeInfo.id !== 'unknown' },
      capability: { value: capability, ok: capability === 'yes' },
      activity: { busy: busy.length > 0, stuck: stuck.length > 0, open: activity.open, file: activity.file },
      channel: { ok: channel.writable, dir: channel.dir, error: channel.error },
    },
    probe: connectivity,
    processes,
    exe: resolveDoubaoExe(),
  }
}

/** 渲染五维识别结果。 */
export function formatPreCallReport(state) {
  const d = state.dimensions
  const lines = ['调用前状态识别']
  lines.push(
    `  连通性   : ${d.connectivity.ok ? `通（${d.connectivity.detail}，${d.connectivity.matching} 个匹配页面）` : `不通（${d.connectivity.detail}）`}`,
  )
  lines.push(
    `  模式     : ${d.mode.id === 'unknown' ? `无法识别${d.mode.raw.length > 0 ? `（读到 "${d.mode.raw}"）` : ''}` : `${d.mode.id}（${d.mode.raw}）`}`,
  )
  lines.push(`  命令能力 : ${d.capability.value}`)
  lines.push(
    `  忙闲     : ${d.activity.open.length === 0 ? '空闲' : `${d.activity.open.length} 个未结束（${d.activity.open.map((e) => e.job).join(', ')}）`}`,
  )
  lines.push(`  通道     : ${d.channel.ok ? `可写（${d.channel.dir}）` : `不可写（${d.channel.dir}: ${d.channel.error}）`}`)
  lines.push('')
  if (state.verdict === 'ready') {
    lines.push('  ✓ 可以发送。')
    return lines.join('\n')
  }
  lines.push(`  ${state.verdict === 'unknown' ? '? 无法识别，拒绝发送' : '✗ 未就绪，拒绝发送'}：`)
  for (const reason of state.reasons) lines.push(`      - ${reason}`)
  lines.push('')
  lines.push('  修好后重跑：node cdp.mjs doctor')
  lines.push('  确实要跳过（会留一条 override 记录）：--force')
  return lines.join('\n')
}
