#!/usr/bin/env node
/**
 * dispatch-work.mjs — 把一条任务派给「会来领活的 MCP 客户端」（豆包工作这类）。
 *
 * 与豆包本体那条线的 `doubao-cdp/dispatch.mjs` 对等，差别只有一处：
 * 那边是「塞进聊天窗口」，这边是「入队 + 等队列记到完成」。
 *
 * 纪律（照抄豆包本体那条线的做法）：
 *   1. **先在入队之前做前置确认**：端点连得上、鉴权过、且真的有过客户端握手；
 *      任何一条不过就退出 3，并且**一条任务都不入队**（不留孤儿任务）。
 *   2. 判定只看队列里的 `complete` 事件，**不采信客户端说「我做完了」**。
 *   3. 真要跳过确认时才用 `--no-preflight`（会在输出里明确标出来）。
 *
 * 用法：
 *   node scripts/dispatch-work.mjs "任务文本" [--timeout <ms>] [--interval <ms>]
 *        [--url <mcp url>] [--token <t>] [--home <dsh home>]
 *        [--source <标记>] [--no-preflight] [--json]
 *
 * 退出码：0 完成且 ok / 2 超时未核实 / 3 未就绪（或完成但报了错）/ 5 无此 id
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkClients, checkEndpoint } from './check-doubao-work.mjs'
import { publishTask, resolveQueueFile, waitForCompletion } from '../dsh-mcp-connector/queue.mjs'

const DEFAULT_URL = 'http://127.0.0.1:8790/mcp'
const USAGE =
  'usage: dispatch-work.mjs "task text" [--timeout <ms>] [--interval <ms>] [--url <mcp url>] [--token <t>] [--home <dsh home>] [--source <label>] [--no-preflight] [--json]'

function parseArgs(argv) {
  const options = {
    task: '',
    timeoutMs: 600_000,
    intervalMs: 1_000,
    url: DEFAULT_URL,
    token: process.env.DSH_MCP_TOKEN ?? '',
    home: join(homedir(), '.dsh'),
    source: 'dispatch-work',
    preflight: true,
    json: false,
  }
  const words = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--timeout') options.timeoutMs = Number(argv[++index] ?? options.timeoutMs)
    else if (arg === '--interval') options.intervalMs = Number(argv[++index] ?? options.intervalMs)
    else if (arg === '--url') options.url = String(argv[++index] ?? options.url)
    else if (arg === '--token') options.token = String(argv[++index] ?? '')
    else if (arg === '--home') options.home = resolve(String(argv[++index] ?? options.home))
    else if (arg === '--source') options.source = String(argv[++index] ?? options.source)
    else if (arg === '--no-preflight') options.preflight = false
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else words.push(arg)
  }
  options.task = words.join(' ').trim()
  return options
}

function render(report) {
  const lines = []
  lines.push(`派发（拉取式）${report.task.length > 0 ? `：${report.task.slice(0, 60)}` : ''}`)
  lines.push('')
  if (report.preflight !== null) {
    lines.push(`${report.preflight.ok ? 'OK  ' : '拒绝 '}前置确认：${report.preflight.summary}`)
    for (const reason of report.preflight.reasons ?? []) lines.push(`      - ${reason}`)
  } else {
    lines.push('跳过 前置确认（--no-preflight，结果是「未核实」性质）')
  }
  if (report.published !== null) {
    lines.push(`OK  已入队：${report.published.id}`)
    lines.push(`      队列文件：${report.queueFile}`)
  } else {
    lines.push('      （没有入队——按纪律，确认不过不留孤儿任务）')
  }
  if (report.verdict !== null) {
    lines.push(`${report.verdict.verdict === 'completed' ? 'OK  ' : '注意 '}结果：${report.verdict.verdict}`)
    if (report.verdict.status !== undefined) lines.push(`      status=${report.verdict.status}${report.verdict.result !== undefined ? ` · ${String(report.verdict.result).slice(0, 80)}` : ''}`)
    if (report.verdict.state !== undefined) lines.push(`      任务当前状态：${report.verdict.state}`)
    lines.push(`      等了 ${report.verdict.waitedMs}ms`)
  }
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
  if (options.task.length === 0) {
    process.stderr.write(`${USAGE}\n`)
    process.exitCode = 1
    return
  }

  const report = { task: options.task, preflight: null, published: null, verdict: null, queueFile: resolveQueueFile(), exitCode: 0, summary: '' }

  if (options.preflight) {
    const endpoint = await checkEndpoint({ url: options.url, token: options.token })
    const clients = checkClients(options.home)
    const reasons = []
    if (!endpoint.ok) reasons.push(`端点不可用：${endpoint.verdict}${endpoint.detail !== undefined ? `（${endpoint.detail}）` : ''}`)
    else if (endpoint.toolCount === 0) reasons.push('端点通了但一个工具都没 advertise')
    if (!clients.ok) reasons.push(`还没有任何真实客户端握手过（${clients.verdict}）——任务入队也没人来领`)
    report.preflight = {
      ok: reasons.length === 0,
      summary:
        reasons.length === 0
          ? `端点 ok（${endpoint.toolCount} 个工具）且有过客户端握手`
          : `${reasons.length} 条不过`,
      reasons,
      endpoint,
      clients: clients.realClients ?? [],
    }
    if (reasons.length > 0) {
      report.exitCode = 3
      report.summary = '未就绪：按上面的原因修完再发（或用 --no-preflight 强行发，但那不核实）'
      process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`)
      process.exitCode = 3
      return
    }
  }

  const published = await publishTask({ task: options.task, source: options.source })
  report.published = { id: published.id, publishedAt: published.publishedAt }
  const verdict = await waitForCompletion({ id: published.id, timeoutMs: options.timeoutMs, intervalMs: options.intervalMs }, process.env)
  report.verdict = verdict

  if (verdict.verdict === 'completed') {
    report.exitCode = verdict.status === 'error' ? 3 : 0
    report.summary = verdict.status === 'error' ? '完成了，但客户端报的是错误' : `完成并已核实（队列记到 ${verdict.id}）`
  } else if (verdict.verdict === 'timeout') {
    report.exitCode = 2
    report.summary = `超时未核实：任务仍是 ${verdict.state}——**不是成功**`
  } else {
    report.exitCode = 5
    report.summary = '队列里找不到这条 id（不该发生，除非队列文件被换过）'
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`)
  process.exitCode = report.exitCode
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`error: ${String(error?.stack ?? error)}\n`)
    process.exitCode = 1
  })
}

export { parseArgs, render }
