#!/usr/bin/env node
/**
 * accept-doubao-work.mjs — 豆包工作这条线的**验收**（一条命令跑完能自动跑的部分）。
 *
 * 为什么单独一个脚本：最终验收要同时回答四件事，而且每件都必须是副作用证据：
 *   1. 接线就绪吗（端点 / 真实客户端握手 / 队列 / 常驻 / 推送）——复用 doctor 的判断；
 *   2. 派出去的任务**真的**被客户端领走并完成吗——入队后等队列记到 `complete`；
 *   3. 完成**是这条任务**的完成吗——结果里必须带回我们放进去的标记（`ACCEPT-<时间戳>`）；
 *      只有 `complete` 事件、却没有标记，说明「它做完了别的事」或「它没照着做」，
 *      这**不算验收通过**；
 *   4. 状态回报有没有进徽章那条通道（可选：报告期间 `status.jsonl` 有没有新增事件）。
 *
 * 用法：
 *   node scripts/accept-doubao-work.mjs [--task "任务文本"] [--timeout <ms>]
 *        [--url <mcp url>] [--token <t>] [--home <dsh home>] [--preflight-only] [--json] [--no-preflight]
 *
 * 退出码：0 全部通过 / 2 任务未在时限内完成（**不是成功**）/ 3 未就绪或完成里没有标记 / 5 队列里找不到该任务
 *
 * `--preflight-only` 只查「现在就绪了吗」，**连一条任务都不入队**——想在正式验收前先看一眼现状时用它。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkClients, checkEndpoint, checkPersistence, checkPush } from './check-doubao-work.mjs'
import { listTasks, publishTask, waitForCompletion } from '../dsh-mcp-connector/queue.mjs'

const DEFAULT_URL = 'http://127.0.0.1:8790/mcp'
const USAGE =
  'usage: accept-doubao-work.mjs [--task "task text"] [--timeout <ms>] [--url <mcp url>] [--token <t>] [--home <dsh home>] [--preflight-only] [--json] [--no-preflight]'

function parseArgs(argv) {
  const options = {
    task: '',
    timeoutMs: 600_000,
    intervalMs: 1_000,
    url: DEFAULT_URL,
    token: process.env.DSH_MCP_TOKEN ?? '',
    home: join(homedir(), '.dsh'),
    json: false,
    preflight: true,
    preflightOnly: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--task') options.task = String(argv[++index] ?? '')
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++index] ?? options.timeoutMs)
    else if (arg === '--interval') options.intervalMs = Number(argv[++index] ?? options.intervalMs)
    else if (arg === '--url') options.url = String(argv[++index] ?? options.url)
    else if (arg === '--token') options.token = String(argv[++index] ?? '')
    else if (arg === '--home') options.home = resolve(String(argv[++index] ?? options.home))
    else if (arg === '--json') options.json = true
    else if (arg === '--preflight-only') options.preflightOnly = true
    else if (arg === '--no-preflight') options.preflight = false
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

/** 读状态文件的行数与最后一条事件（用来判断「验收期间有没有新事件」）。 */
function snapshotStatus(home) {
  const file = join(home, 'mcp-connector', 'status.jsonl')
  if (!existsSync(file)) return { file, lines: 0, last: null }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0)
  let last = null
  try {
    last = JSON.parse(lines[lines.length - 1] ?? 'null')
  } catch {
    last = null
  }
  return { file, lines: lines.length, last }
}

function acceptanceTask(marker) {
  return [
    '这是一条【验收测试】任务，请照做并在结果里原样带回标记，不要改写它。',
    `标记：${marker}`,
    '步骤：',
    '1) 用 dsh 连接器的 task_list 确认这条任务处于 pending（只读，不要认领）；',
    '2) 用 status_report 报两条：state=start 与 state=done（job 用同一个标记值）；',
    '3) 用 task_complete 回报完成，result 里**必须原样包含**上面的标记。',
  ].join('\n')
}

function render(report) {
  const lines = []
  lines.push(`豆包工作接线验收  marker ${report.marker}`)
  lines.push('')
  const mark = (ok) => (ok ? 'OK  ' : '注意 ')
  lines.push(`${mark(report.ready)}接线就绪：${report.readySummary}`)
  for (const reason of report.reasons) lines.push(`      - ${reason}`)
  if (report.preflightOnly === true) {
    lines.push('      （--preflight-only：只查就绪，没有入队，也没有验收）')
    lines.push('')
    lines.push(`结论：${report.summary}（退出码 ${report.exitCode}）`)
    return lines.join('\n')
  }
  if (report.published !== null) lines.push(`OK  已入队：${report.published.id}`)
  else lines.push('      （没有入队——确认不过不留孤儿任务）')
  if (report.verdict !== null) {
    lines.push(`${report.verdict.verdict === 'completed' ? 'OK  ' : '注意 '}任务：${report.verdict.verdict}${report.verdict.state !== undefined ? `（当前 ${report.verdict.state}）` : ''}`)
    if (report.verdict.result !== undefined) lines.push(`      result：${String(report.verdict.result).slice(0, 120)}`)
  }
  lines.push(`${mark(report.markerInResult)}标记回传：${report.markerInResult ? '结果里带回了标记' : '结果里没有标记 → 不算验收通过'}`)
  lines.push(`${mark(true)}状态通道：验收期间新增 ${report.statusDelta} 条事件${report.statusDelta > 0 ? '' : '（客户端没报状态，或报到了别处）'}`)
  lines.push('')
  lines.push(`结论：${report.summary}（退出码 ${report.exitCode}）`)
  return lines.join('\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const marker = `ACCEPT-${Date.now().toString(36)}`
  const task = options.task.length > 0 ? `${options.task}\n\n[验收标记：${marker}]` : acceptanceTask(marker)
  const before = snapshotStatus(options.home)
  const endpoint = await checkEndpoint({ url: options.url, token: options.token })
  const clients = checkClients(options.home)
  const persistence = checkPersistence(options.home)
  const push = checkPush(options.home)

  const reasons = []
  if (!endpoint.ok) reasons.push(`端点不可用：${endpoint.verdict}${endpoint.detail !== undefined ? `（${endpoint.detail}）` : ''}`)
  else if (endpoint.toolCount < 8) reasons.push(`端点只 advertise 了 ${endpoint.toolCount} 个工具（期望 8：可能是旧进程或旧代码）`)
  if (!clients.ok) reasons.push(`还没有任何真实客户端握手过（${clients.verdict}）——任务入队也没人来领`)
  const ready = reasons.length === 0

  const report = {
    marker,
    endpoint,
    clients: clients.realClients ?? [],
    persistence: { ok: persistence.ok, verdict: persistence.verdict },
    push: { ok: push.ok, verdict: push.verdict },
    ready,
    readySummary: ready ? `端点 ok（${endpoint.toolCount} 个工具）且有 ${(clients.realClients ?? []).length} 个真实客户端` : `${reasons.length} 条不过`,
    reasons,
    published: null,
    verdict: null,
    markerInResult: false,
    statusDelta: 0,
    exitCode: 3,
    summary: '未就绪：按上面的原因修完再跑',
  }

  const finish = () => {
    const after = snapshotStatus(options.home)
    report.statusDelta = Math.max(0, after.lines - before.lines)
    if (!ready && options.preflight) {
      report.exitCode = 3
      report.summary = '未就绪：没有入队，也没有验收'
    } else if (report.verdict === null) {
      report.exitCode = 5
      report.summary = '队列里找不到刚发布的任务（不该发生）'
    } else if (report.verdict.verdict === 'timeout') {
      report.exitCode = 2
      report.summary = '用例未在时限内完成：任务仍没被完成——**不是成功**'
    } else if (report.verdict.verdict === 'unknown') {
      report.exitCode = 5
      report.summary = '找不到该任务 id'
    } else if (!report.markerInResult) {
      report.exitCode = 3
      report.summary = '任务完成了，但 result 里没有带回标记 → 验收不通过'
    } else {
      report.exitCode = 0
      report.summary = '验收通过：任务被领走、完成，且结果里带回了标记'
    }
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`)
    process.exitCode = report.exitCode
  }

  // 「只查就绪，不入队」放在最前：用它时不管就绪与否，都只报检查结果，
  // 不打印「任务/标记回传」那些只在真验收里才有意义的行，也不留任何副作用。
  if (options.preflightOnly) {
    report.preflightOnly = true
    report.exitCode = ready ? 0 : 3
    report.summary = ready ? '就绪检查通过（未入队）' : '未就绪（未入队）'
    const after = snapshotStatus(options.home)
    report.statusDelta = Math.max(0, after.lines - before.lines)
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`)
    process.exitCode = report.exitCode
    return
  }

  if (!ready && options.preflight) {
    finish()
    return
  }

  const published = await publishTask({ task, source: 'accept-doubao-work' })
  report.published = { id: published.id, publishedAt: published.publishedAt }
  report.verdict = await waitForCompletion({ id: published.id, timeoutMs: options.timeoutMs, intervalMs: options.intervalMs }, process.env)
  if (report.verdict?.verdict === 'completed') {
    report.markerInResult = String(report.verdict.result ?? '').includes(marker)
  }
  finish()
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`error: ${String(error?.stack ?? error)}\n`)
    process.exitCode = 3
  })
}

export { acceptanceTask, parseArgs, snapshotStatus }
