#!/usr/bin/env node
/**
 * status.mjs — 豆包工作的状态回报。
 *
 * 设计要点（对应需求 R1–R10、R36–R41）：
 *   - 状态写**独立文件**（JSONL），不污染任务队列（B 方案）。
 *   - 行为由 **doubao-status.ini** 驱动；ini 由**本脚本自己读**，所以调用方
 *     （豆包）只需要在合适的时点执行 `status.mjs <state> --job <id>`，
 *     提示词里不硬编码任何策略。
 *   - ini 缺失/损坏 → 用内置默认值 + 明确告警，绝不因为配置问题丢状态。
 *   - 某状态被关掉 → **静默 no-op**（退出 0、不输出），不打断豆包干活。
 *   - `received` / `started` / `done` / `failed` 永不因限流被丢弃；只有
 *     `progress` 之类高频状态受最小间隔约束。
 *
 * 用法：
 *   node status.mjs received --job <id> [--message "..."]   # 派发器写：指令已送出
 *   node status.mjs start    --job <id> [--message "..."]
 *   node status.mjs progress --job <id> [--percent 42] [--step "..."]
 *   node status.mjs need-input --job <id> [--message "在等什么"]
 *   node status.mjs done     --job <id> [--message "..."]
 *   node status.mjs fail     --job <id> [--message "错误摘要"]
 *   node status.mjs list [--job <id>] [--json]
 *   node status.mjs last <job>
 *   node status.mjs open [--json]           # 有 started 无终态的 job（忙闲判定用）
 *   node status.mjs config [--json]         # 打印生效配置（排查用）
 *   node status.mjs enabled <state>         # 退出 0=启用，4=禁用（给 shell 判断用）
 */

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendJsonLine, resolveQueueDir, withFileLock } from '../dsh-mcp-connector/queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 退出码：4 = 状态被 ini 关掉（不是错误，方便 shell 判分支）。 */
export const DISABLED_EXIT_CODE = 4

/** 固定词表（英文，R1）。别名只是输入便利，落盘永远是规范名。 */
const STATE_ALIASES = new Map([
  ['receive', 'received'],
  ['received', 'received'],
  ['start', 'started'],
  ['started', 'started'],
  ['progress', 'progress'],
  ['need-input', 'need_input'],
  ['need_input', 'need_input'],
  ['done', 'done'],
  ['finish', 'done'],
  ['fail', 'failed'],
  ['failed', 'failed'],
])

/** 终态：不可再被后续事件覆盖。 */
const TERMINAL_STATES = new Set(['done', 'failed'])

/**
 * 永不因限流丢弃的状态。
 *
 * `received` 由派发器在「指令真的发出去」那一刻写一次，既低频又是面板判断
 * 「刚派发出去」的唯一依据，被限流丢掉就等于面板看不见这一秒。
 */
const NEVER_THROTTLED = new Set(['received', 'started', 'done', 'failed'])

const DEFAULTS = {
  status: {
    file: '',
    enabled: 'received,started,progress,need_input,done,failed',
  },
  limits: {
    max_message_chars: '500',
    min_interval_ms: '2000',
    progress_min_interval_ms: '10000',
  },
  push: {
    enabled: 'false',
    targets: 'started,need_input,done,failed',
    session: '',
  },
}

/** 极简 INI 解析：支持 [section]、key = value、; 与 # 注释。 */
export function parseIni(text) {
  const config = {}
  let section = 'default'
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue
    const header = /^\[(.+)]$/.exec(line)
    if (header !== null) {
      section = header[1].trim()
      config[section] ??= {}
      continue
    }
    const separator = line.indexOf('=')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1')
    config[section] ??= {}
    config[section][key] = value
  }
  return config
}

/** 生效配置 = 内置默认 ← ini 覆盖。 */
export function loadConfig({ env = process.env } = {}) {
  const iniPath = env.DOUBAO_STATUS_INI?.trim() || join(resolveQueueDir(env), 'doubao-status.ini')
  const warnings = []
  const merged = structuredClone(DEFAULTS)
  let source = 'built-in defaults'

  if (existsSync(iniPath)) {
    try {
      const parsed = parseIni(readFileSync(iniPath, 'utf8'))
      for (const [section, values] of Object.entries(parsed)) {
        if (merged[section] === undefined) merged[section] = {}
        Object.assign(merged[section], values)
      }
      source = iniPath
    } catch (error) {
      warnings.push(`无法读取 ${iniPath}（${error.message}）→ 使用内置默认值`)
    }
  } else {
    warnings.push(`未找到 ${iniPath} → 使用内置默认值（可复制 doubao-status.ini.sample 生成）`)
  }

  const statusFile = merged.status.file.trim() || join(resolveQueueDir(env), 'status.jsonl')
  return {
    iniPath,
    source,
    warnings,
    statusFile,
    enabled: splitList(merged.status.enabled),
    maxMessageChars: toPositiveInt(merged.limits.max_message_chars, 500),
    minIntervalMs: toPositiveInt(merged.limits.min_interval_ms, 2000),
    progressMinIntervalMs: toPositiveInt(merged.limits.progress_min_interval_ms, 10000),
    push: {
      enabled: /^(true|yes|1|on)$/i.test(merged.push.enabled),
      targets: splitList(merged.push.targets),
      session: merged.push.session.trim(),
    },
  }
}

/* ------------------------------------------------ 事件读写与状态折叠 */

/** 容忍缺失文件与半行（与队列同一套崩溃安全性）。 */
export async function readStatusEvents(file) {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object') events.push(parsed)
    } catch {
      /* 半行或损坏：忽略，不影响已有历史 */
    }
  }
  return events
}

/** 按 job 折叠出时间线。只认 status 事件，override 之类的旁注不参与折叠。 */
export function foldByJob(events) {
  const jobs = new Map()
  for (const event of events) {
    if (event.type !== undefined && event.type !== 'status') continue
    if (typeof event.job !== 'string' || event.job.length === 0) continue
    const entry = jobs.get(event.job) ?? { job: event.job, events: [], state: 'unknown', firstAt: undefined, lastAt: undefined }
    entry.events.push(event)
    entry.firstAt ??= event.at
    entry.lastAt = event.at
    // 终态一旦到达就不再被覆盖，后到的事件只记录不改变结论。
    if (entry.state === 'unknown' || !TERMINAL_STATES.has(entry.state)) entry.state = event.state
    jobs.set(event.job, entry)
  }
  for (const entry of jobs.values()) {
    entry.events.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    entry.terminal = TERMINAL_STATES.has(entry.state)
  }
  return jobs
}

/**
 * 还占着的 job —— 忙闲判定的依据（R27.3）。
 *
 * 两种起步事件都算「占着」：
 *   - `received`：派发器写的发送侧事实（指令已送出，豆包还没表态）；
 *   - `started` ：豆包写的（它已经动手了）。
 * 只认 `started` 会让「刚发出去到豆包报开工」这段空窗期无人看管：面板没东西
 * 可显示，忙闲判定也放行，后一条派发就能插队到前一条前面。
 * `phase` 让调用方区分这两段（面板据此显示「已接收」还是「工作开始」）。
 */
export function openJobs(jobs, { now = Date.now(), staleAfterMs = 600_000 } = {}) {
  const open = []
  for (const entry of jobs.values()) {
    if (entry.state === 'unknown') continue
    if (entry.terminal) continue
    const receivedAt = entry.events.find((event) => event.state === 'received')?.at
    const startedAt = entry.events.find((event) => event.state === 'started')?.at
    if (receivedAt === undefined && startedAt === undefined) continue
    const idleMs = now - (entry.lastAt ?? now)
    open.push({
      job: entry.job,
      state: entry.state,
      phase: startedAt !== undefined ? 'started' : 'received',
      receivedAt,
      startedAt,
      lastAt: entry.lastAt,
      idleMs,
      stale: idleMs > staleAfterMs,
    })
  }
  return open
}

export async function recordStatus({ job, state, message, percent, step }, config) {
  if (!config.enabled.includes(state)) {
    return { recorded: false, reason: 'disabled' }
  }

  const events = await readStatusEvents(config.statusFile)
  const jobs = foldByJob(events)
  const entry = jobs.get(job)

  if (entry !== undefined && entry.terminal) {
    // 终态之后不再接受新状态（重复 done 幂等，不重复写）。
    return { recorded: false, reason: 'already-terminal', previous: entry.state }
  }

  if (!NEVER_THROTTLED.has(state) && entry !== undefined) {
    const interval = state === 'progress' ? config.progressMinIntervalMs : config.minIntervalMs
    const same = [...entry.events].reverse().find((event) => event.state === state)
    if (same !== undefined && Date.now() - (same.at ?? 0) < interval) {
      return { recorded: false, reason: 'throttled', sinceMs: Date.now() - (same.at ?? 0) }
    }
  }

  const body = typeof message === 'string' ? message.slice(0, config.maxMessageChars) : undefined
  const event = {
    v: 1,
    type: 'status',
    job,
    state,
    ...(body !== undefined && body.length > 0 ? { message: body } : {}),
    ...(Number.isFinite(percent) ? { percent: Math.max(0, Math.min(100, Math.round(percent))) } : {}),
    ...(typeof step === 'string' && step.length > 0 ? { step: step.slice(0, config.maxMessageChars) } : {}),
    at: Date.now(),
    source: 'doubao-status',
  }
  await withFileLock(config.statusFile, async () => {
    await appendJsonLine(config.statusFile, event)
  })
  return { recorded: true, event }
}

/* ---------------------------------------------------------------- CLI */

/** 记录一次「强制放行」——留痕，便于事后回答「为什么这次没拦住」。 */
export async function recordOverride({ job, message, reason }, config) {
  const event = {
    v: 1,
    type: 'override',
    job,
    state: 'override',
    ...(typeof message === 'string' && message.length > 0 ? { message: message.slice(0, config.maxMessageChars) } : {}),
    ...(typeof reason === 'string' && reason.length > 0 ? { reason: reason.slice(0, config.maxMessageChars) } : {}),
    at: Date.now(),
    source: 'doubao-status',
  }
  await withFileLock(config.statusFile, async () => {
    await appendJsonLine(config.statusFile, event)
  })
  return event
}

function splitList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function parseArgs(argv) {
  const options = { job: undefined, message: undefined, percent: undefined, step: undefined, json: false }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--job') options.job = String(argv[++index] ?? '')
    else if (arg === '--message' || arg === '-m') options.message = String(argv[++index] ?? '')
    else if (arg === '--step') options.step = String(argv[++index] ?? '')
    else if (arg === '--percent') options.percent = Number(argv[++index])
    else positional.push(arg)
  }
  return { options, positional }
}

function renderTimeline(entry) {
  if (entry === undefined) return '(no events)'
  const lines = [`job ${entry.job}  state=${entry.state}${entry.terminal ? ' (terminal)' : ''}`]
  for (const event of entry.events) {
    const time = new Date(event.at ?? 0).toISOString().slice(11, 19)
    const extras = [
      event.percent !== undefined ? `${event.percent}%` : '',
      event.step !== undefined ? `step=${event.step}` : '',
      event.message !== undefined ? event.message : '',
    ].filter((part) => part.length > 0)
    lines.push(`  ${time}  ${String(event.state).padEnd(10)} ${extras.join('  ')}`)
  }
  return lines.join('\n')
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { options, positional } = parseArgs(rest)
  const config = loadConfig()

  for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`)

  if (command === undefined) {
    process.stdout.write('usage: status.mjs received|start|progress|need-input|done|fail --job <id> [--message ..] [--percent N] [--step ..]\n')
    process.stdout.write('       status.mjs list [--job <id>] [--json] | last <job> | open [--json] | config [--json] | enabled <state>\n')
    process.exitCode = 1
    return
  }

  if (command === 'config') {
    process.stdout.write(
      options.json
        ? `${JSON.stringify(config, null, 2)}\n`
        : [
            `ini            : ${config.source}`,
            `status file    : ${config.statusFile}`,
            `enabled        : ${config.enabled.join(', ')}`,
            `max message    : ${config.maxMessageChars} chars`,
            `min interval   : ${config.minIntervalMs} ms (progress ${config.progressMinIntervalMs} ms)`,
            `push           : ${config.push.enabled ? `on → ${config.push.targets.join(', ')}${config.push.session ? ` → session ${config.push.session}` : ''}` : 'off'}`,
          ].join('\n') + '\n',
    )
    return
  }

  if (command === 'override') {
    const job = options.job
    if (typeof job !== 'string' || job.length === 0) {
      process.stderr.write('override needs --job\n')
      process.exitCode = 1
      return
    }
    const event = await recordOverride({ job, message: options.message, reason: options.step }, config)
    process.stdout.write(`override recorded for ${job} (${new Date(event.at).toISOString()})\n`)
    return
  }

  if (command === 'enabled') {
    const state = STATE_ALIASES.get(positional[0] ?? '') ?? positional[0]
    const on = config.enabled.includes(state)
    if (!on) process.stdout.write(`disabled: ${state}\n`)
    process.exitCode = on ? 0 : DISABLED_EXIT_CODE
    return
  }

  if (command === 'list') {
    const events = await readStatusEvents(config.statusFile)
    const jobs = foldByJob(events)
    const wanted = options.job !== undefined && options.job.length > 0 ? [options.job] : [...jobs.keys()]
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ file: config.statusFile, jobs: wanted.map((job) => jobs.get(job) ?? { job, state: 'none', events: [] }) }, null, 2)}\n`)
      return
    }
    if (wanted.length === 0) {
      process.stdout.write(`(no status events in ${config.statusFile})\n`)
      return
    }
    process.stdout.write(`${wanted.map((job) => renderTimeline(jobs.get(job))).join('\n\n')}\n`)
    return
  }

  if (command === 'last') {
    const job = positional[0] ?? options.job
    const jobs = foldByJob(await readStatusEvents(config.statusFile))
    const entry = job === undefined ? undefined : jobs.get(job)
    process.stdout.write(`${entry === undefined ? 'none' : entry.state}\n`)
    process.exitCode = entry === undefined ? 5 : 0
    return
  }

  if (command === 'open') {
    const jobs = foldByJob(await readStatusEvents(config.statusFile))
    const open = openJobs(jobs)
    if (options.json) {
      process.stdout.write(`${JSON.stringify(open, null, 2)}\n`)
      return
    }
    if (open.length === 0) {
      process.stdout.write('idle (no open job)\n')
      return
    }
    for (const entry of open) {
      process.stdout.write(`${entry.job}  state=${entry.state}  idle=${Math.round(entry.idleMs / 1000)}s${entry.stale ? '  (疑似卡死)' : ''}\n`)
    }
    process.exitCode = 6
    return
  }

  const state = STATE_ALIASES.get(command)
  if (state === undefined) {
    process.stderr.write(`unknown state: ${command}\n`)
    process.exitCode = 1
    return
  }
  const job = options.job
  if (typeof job !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(job)) {
    process.stderr.write('--job is required and must match [A-Za-z0-9._:-]{1,120}\n')
    process.exitCode = 1
    return
  }

  const outcome = await recordStatus(
    { job, state, message: options.message, percent: options.percent, step: options.step },
    config,
  )
  if (!outcome.recorded) {
    // 静默 no-op：不改退出码，不打断调用方的工作。
    if (outcome.reason !== 'disabled' && outcome.reason !== 'throttled' && outcome.reason !== 'already-terminal') {
      process.stderr.write(`not recorded: ${outcome.reason}\n`)
    }
    return
  }
  process.stdout.write(`${state} recorded for ${job}\n`)
}

export { HERE }

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`)
    process.exitCode = 1
  })
}
