#!/usr/bin/env node
/**
 * check-doubao-work.mjs — 豆包工作（MCP over HTTP）这条接线的体检。
 *
 * 与豆包本体那条线的 `doubao-cdp/cdp.mjs doctor` 对等：**只读、只报告，不改任何东西**，
 * 退出码语义也照它来：
 *   0 = 就绪（端点通 + 真的有过客户端握手）
 *   3 = 未就绪（端点不通，或从来没有客户端连过）
 *   8 = 无法判定（配置/文件缺失，读不到关键信息）
 *
 * 用法：
 *   node scripts/check-doubao-work.mjs [--json]
 *        [--url http://127.0.0.1:8790/mcp] [--token <t>] [--home <dir>]
 *
 * token 也可以走环境变量 DSH_MCP_TOKEN。没给 token 时会如实报告「端点通但鉴权失败」——
 * 那正是一个有用的信号（端点活着、但 App 里的 Header 可能是错的）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listTasks } from '../dsh-mcp-connector/queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_URL = 'http://127.0.0.1:8790/mcp'
const LAUNCHER = 'start-http.cmd'
const STARTUP_VBS = 'DSH-MCP-HTTP.vbs'
const JUNCTION = 'plugins'

function parseArgs(argv) {
  const options = { json: false, url: DEFAULT_URL, token: process.env.DSH_MCP_TOKEN ?? '', home: join(homedir(), '.dsh') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--url') options.url = String(argv[++index] ?? options.url)
    else if (arg === '--token') options.token = String(argv[++index] ?? '')
    else if (arg === '--home') options.home = resolve(String(argv[++index] ?? options.home))
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

const USAGE = `usage: check-doubao-work.mjs [--json] [--url <mcp url>] [--token <bearer>] [--home <dsh home>]`

/** One JSON-RPC round trip against the Streamable HTTP endpoint. */
async function rpc(url, token, body, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    return { status: response.status, payload, text }
  } finally {
    clearTimeout(timer)
  }
}

/** 端点这一维：能不能连、鉴权过不过、它 advertise 几个工具。 */
export async function checkEndpoint({ url, token }) {
  const startedAt = Date.now()
  try {
    const init = await rpc(url, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-doctor', version: '1' } },
    })
    if (init.status === 401) {
      return { ok: false, verdict: 'unauthorized', detail: '端点活着，但鉴权失败（401）—— token 不对或 App 里的 Header 没带', url }
    }
    if (init.status !== 200) {
      return { ok: false, verdict: 'http-error', detail: `initialize 返回 HTTP ${init.status}`, url }
    }
    const list = await rpc(url, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = (list.payload?.result?.tools ?? []).map((tool) => tool.name)
    return {
      ok: true,
      verdict: 'ok',
      url,
      serverInfo: init.payload?.result?.serverInfo ?? null,
      protocolVersion: init.payload?.result?.protocolVersion ?? null,
      toolCount: tools.length,
      tools,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    return { ok: false, verdict: 'unreachable', detail: String(error?.message ?? error), url }
  }
}

/** 客户端这一维：连接器记过谁。区分「我们自己的自检/测试」与「真实客户端」。 */
const SELF_CHECK_NAMES = new Set(['dsh-setup-check', 'dsh-doctor', 'local-check', 'selftest', 'selftest-status', 'selftest-status-missing', 'selftest-worker', 'selftest-link'])

export function checkClients(home) {
  const file = join(home, 'mcp-connector', 'clients.json')
  // Every branch returns the same shape: a diagnostic consumer should never have to
  // guard for a missing key just because one dimension failed early.
  if (!existsSync(file)) return { ok: false, verdict: 'missing', file, clients: [], realClients: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const clients = Array.isArray(parsed?.clients) ? parsed.clients : []
    const real = clients.filter((client) => !SELF_CHECK_NAMES.has(String(client.name)) && !String(client.name).startsWith('selftest-'))
    return {
      ok: real.length > 0,
      verdict: real.length > 0 ? 'ok' : 'never-connected',
      file,
      clients,
      realClients: real.map((client) => ({
        name: client.name,
        version: client.version,
        transport: client.transport,
        initializations: client.initializations,
        lastSeenAt: client.lastSeenAt,
      })),
    }
  } catch (error) {
    return { ok: false, verdict: 'unreadable', file, detail: String(error?.message ?? error), clients: [], realClients: [] }
  }
}

/** 状态通道这一维：最近几条状态事件（客户端回报就落在这里，徽章也读它）。 */
export function checkStatus(home, limit = 5) {
  const file = join(home, 'mcp-connector', 'status.jsonl')
  if (!existsSync(file)) return { ok: false, verdict: 'missing', file, events: [] }
  try {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
    const events = []
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = JSON.parse(line)
        events.push({ job: parsed.job, state: parsed.state, at: parsed.at, message: parsed.message })
      } catch {
        /* skip unparseable */
      }
    }
    return { ok: true, verdict: 'ok', file, total: lines.length, events }
  } catch (error) {
    return { ok: false, verdict: 'unreadable', file, detail: String(error?.message ?? error), events: [] }
  }
}

/** 队列这一维：有多少待办/被领/已完成。 */
export async function checkQueue(home) {
  const file = join(home, 'mcp-connector', 'tasks.jsonl')
  try {
    const tasks = await listTasks({ state: 'all' }, { ...process.env, DSH_QUEUE_FILE: file })
    const counts = { pending: 0, claimed: 0, done: 0 }
    for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1
    return { ok: true, verdict: 'ok', file, total: tasks.length, counts }
  } catch (error) {
    return { ok: false, verdict: 'unreadable', file, detail: String(error?.message ?? error) }
  }
}

/** 常驻这一维：启动器 / 启动文件夹 / ASCII 联接 / 日志 四件套在不在。 */
export function checkPersistence(home) {
  const launcher = join(home, 'mcp-connector', LAUNCHER)
  const log = join(home, 'mcp-connector', 'http-endpoint.log')
  const startup = join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', STARTUP_VBS)
  const junction = join(home, JUNCTION)
  const parts = {
    launcher: { path: launcher, exists: existsSync(launcher) },
    startup: { path: startup, exists: existsSync(startup) },
    junction: { path: junction, exists: existsSync(junction) },
    // 启动器把自己的输出与「退出→重启」写进这个日志：崩过就看得出来。
    log: { path: log, exists: existsSync(log) },
  }
  const missing = Object.values(parts).filter((part) => !part.exists)
  return { ok: missing.length === 0, verdict: missing.length === 0 ? 'ok' : 'incomplete', ...parts }
}

/**
 * 推送这一维：状态事件除了进徽章，还会被 `doubao-cdp/status-push.mjs` 推进一个 DSH 会话。
 * 对工作应用这条线同样适用——它报答的事件和豆包本体写的是**同一个文件里的同一种事件**。
 * 注意成本：**每次推送都是一次真实模型调用**，所以 ini 里只推阶段转换（不含 progress）。
 */
export function checkPush(home) {
  const file = join(home, 'mcp-connector', 'doubao-status.ini')
  if (!existsSync(file)) return { ok: false, verdict: 'missing', file, detail: '没有 ini，推送用内置默认值（默认关闭）' }
  let source = ''
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, verdict: 'unreadable', file, detail: String(error?.message ?? error) }
  }
  // 只认 [push] 段，够用就好（不引入 ini 解析依赖）。
  const section = /\[push\]([\s\S]*?)(?:\n\[|$)/.exec(source)?.[1] ?? ''
  const read = (key) => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(section)
    return match?.[1]?.trim() ?? ''
  }
  const enabled = read('enabled').toLowerCase() === 'true'
  const session = read('session')
  const targets = read('targets')
  return {
    ok: enabled && session.length > 0,
    verdict: enabled ? (session.length > 0 ? 'enabled' : 'enabled-without-session') : 'disabled',
    file,
    enabled,
    session,
    targets,
  }
}

function render(report) {
  const lines = []
  lines.push(`豆包工作接线体检  (url ${report.endpoint.url})`)
  lines.push('')
  const mark = (ok) => (ok ? 'OK  ' : '注意 ')
  lines.push(`${mark(report.endpoint.ok)}端点：${report.endpoint.verdict}${report.endpoint.detail !== undefined ? ` — ${report.endpoint.detail}` : ''}`)
  if (report.endpoint.ok) {
    lines.push(`      协议 ${report.endpoint.protocolVersion} · ${report.endpoint.toolCount} 个工具 · ${report.endpoint.elapsedMs}ms`)
    lines.push(`      ${report.endpoint.tools.join(', ')}`)
  }
  lines.push(`${mark(report.clients.ok)}客户端：${report.clients.verdict}`)
  for (const client of report.clients.realClients ?? []) {
    lines.push(`      ${client.name}@${client.version} via ${client.transport} · ${client.initializations}x`)
  }
  if ((report.clients.realClients ?? []).length === 0) lines.push('      (还没有真实客户端握手过；App 里保存连接器不等于连上)')
  lines.push(`${mark(report.status.ok)}状态通道：${report.status.verdict}${report.status.total !== undefined ? ` · ${report.status.total} 条事件` : ''}`)
  for (const event of report.status.events ?? []) {
    lines.push(`      ${event.job} · ${event.state}${event.message ? ` · ${event.message.slice(0, 40)}` : ''}`)
  }
  lines.push(`${mark(report.queue.ok)}队列：${report.queue.verdict}${report.queue.counts ? ` · pending ${report.queue.counts.pending} / claimed ${report.queue.counts.claimed} / done ${report.queue.counts.done}` : ''}`)
  lines.push(`${mark(report.persistence.ok)}常驻：${report.persistence.verdict}`)
  lines.push(
    `      启动器 ${report.persistence.launcher.exists ? '有' : '缺'} · 启动文件夹 ${report.persistence.startup.exists ? '有' : '缺'} · ASCII 联接 ${report.persistence.junction.exists ? '有' : '缺'} · 日志 ${report.persistence.log?.exists ? '有' : '缺'}`,
  )
  lines.push('      边界：这里只证明文件在，**不能证明启动器的循环还活着**（循环死了端点仍会撑到下一次崩溃为止）')
  if (report.push !== undefined && report.push !== null) {
    lines.push(`${mark(report.push.ok)}推送进 DSH 会话：${report.push.verdict}${report.push.targets ? ` · 只推 ${report.push.targets}` : ''}`)
    if (report.push.session) lines.push(`      目标会话：${report.push.session}`)
    if (report.push.detail) lines.push(`      ${report.push.detail}`)
    lines.push('      注意：每次推送都是一次真实模型调用（所以只推阶段转换，不推 progress）')
  }
  lines.push('')
  lines.push(`结论：${report.verdict}（退出码 ${report.exitCode}）`)
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const endpoint = await checkEndpoint(options)
  const clients = checkClients(options.home)
  const status = checkStatus(options.home)
  const queue = await checkQueue(options.home)
  const persistence = checkPersistence(options.home)
  const push = checkPush(options.home)

  const essential = endpoint.ok && clients.ok
  const unknown = !endpoint.ok && endpoint.verdict !== 'unauthorized' && endpoint.verdict !== 'unreachable'
  const exitCode = essential ? 0 : unknown ? 8 : 3
  const report = {
    endpoint,
    clients,
    status,
    queue,
    persistence,
    push,
    verdict: essential ? '就绪：端点通且确有客户端握手' : unknown ? '无法判定（先看上面哪一维读不到）' : '未就绪（按上面「注意」逐条修）',
    exitCode,
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`)
  process.exitCode = exitCode
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`error: ${String(error?.stack ?? error)}\n`)
    process.exitCode = 8
  })
}
