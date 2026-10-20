#!/usr/bin/env node
/**
 * status-push.mjs —— 把「阶段转换」推送到一个 DSH 会话（P2）。
 *
 * 为什么要单独一个常驻进程：豆包只会往状态文件里写事件，它没法自己叫醒 DSH。
 * 所以需要一个消费者盯着状态文件，把新的阶段转换送进会话。
 *
 * 成本说明：**每次推送 = 一次真实的模型调用**。因此默认只推阶段转换
 * （started / need_input / done / failed），`progress` 只留在文件里不推——
 * 一个 10 分钟的任务大约只花 4 次调用，而不是几百次。
 *
 * 用法：
 *   node status-push.mjs --once                 # 处理完当前积压就退出（测试/手动）
 *   node status-push.mjs                        # 常驻，按 --interval 轮询
 *   node status-push.mjs --dry-run --once       # 只打印要推什么，不调用模型
 *   node status-push.mjs --create-session       # 没有会话时先建一个并打印 id
 *   node status-push.mjs --dsh <可执行文件>      # 换 dsh（测试用假 CLI）
 *
 * 配置来源：与 status.mjs 同一份 ini 的 [push] 段（enabled / targets / session）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveQueueDir } from '../dsh-mcp-connector/queue.mjs'
import { loadConfig, readStatusEvents } from './status.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 推送哪些：阶段转换。progress 永远不推（成本）。 */
const PHASE_STATES = new Set(['started', 'need_input', 'done', 'failed'])

function parseArgs(argv) {
  const options = { once: false, dryRun: false, intervalMs: 3000, dsh: process.env.DSH_BIN?.trim() || 'dsh', createSession: false, job: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--once') options.once = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--create-session') options.createSession = true
    else if (arg === '--interval') options.intervalMs = Math.max(500, Number(argv[++index] ?? options.intervalMs))
    else if (arg === '--dsh') options.dsh = String(argv[++index] ?? options.dsh)
    else if (arg === '--job') options.job = String(argv[++index] ?? '')
  }
  return options
}

function cursorPath(env = process.env) {
  return join(resolveQueueDir(env), '.push-cursor.json')
}

async function readCursor(env = process.env) {
  try {
    const parsed = JSON.parse(await readFile(cursorPath(env), 'utf8'))
    return { processed: Number(parsed.processed ?? 0) || 0, session: typeof parsed.session === 'string' ? parsed.session : '' }
  } catch {
    return { processed: 0, session: '' }
  }
}

async function writeCursor(cursor, env = process.env) {
  const file = cursorPath(env)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(cursor, null, 2)}\n`, 'utf8')
}

/** 一条状态 → 一段给人看的推送文本。 */
export function formatPush(event) {
  const label = { started: '工作开始', progress: '进度', need_input: '需要确认', done: '工作结束', failed: '工作失败' }[event.state] ?? event.state
  const details = [
    typeof event.message === 'string' && event.message.length > 0 ? event.message : '',
    Number.isFinite(event.percent) ? `${event.percent}%` : '',
    typeof event.step === 'string' && event.step.length > 0 ? `步骤：${event.step}` : '',
  ].filter((part) => part.length > 0)
  return `[豆包状态] ${label} · job=${event.job}${details.length > 0 ? ` · ${details.join(' · ')}` : ''}`
}

/** 单个 shell token 的引号处理（与连接器同一套规则）。 */
function quoteToken(token) {
  return /^[A-Za-z0-9._:/\\=+-]+$/.test(token) ? token : `"${token.replace(/"/g, '\\"')}"`
}

/** 调一次 dsh headless；有 sessionId 就续接那个会话。 */
function runDshOnce({ dsh, text, sessionId, timeoutMs = 180_000 }) {
  return new Promise((resolve) => {
    const args = ['--profile', 'headless', '--json']
    if (sessionId !== undefined && sessionId.length > 0) args.push('--session-id', sessionId)
    args.push('-')
    // Windows 上 dsh 是 .cmd shim：不带 shell 直接 spawn 会得到 ENOENT，
    // 所以整条命令行交给 shell（参数里只有调用方控制的固定 token，正文走 stdin）。
    const useShell = process.platform === 'win32'
    const line = [dsh, ...args].map(quoteToken).join(' ')
    const child = spawn(useShell ? line : dsh, useShell ? [] : args, {
      shell: useShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: `${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() })
    })
    child.stdin.end(text)
  })
}

/** 从 headless 的 NDJSON 输出里取最终答复与 sessionId。 */
export function summarize(stdoutText) {
  let answer = ''
  let sessionId
  for (const line of String(stdoutText).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed[0] !== '{') continue
    try {
      const event = JSON.parse(trimmed)
      if (event.type === 'final' && typeof event.text === 'string') answer = event.text
      if (typeof event.sessionId === 'string' && event.sessionId.length > 0) sessionId = event.sessionId
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
  return { answer, sessionId }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const config = loadConfig()
  for (const warning of config.warnings) process.stderr.write(`warning: ${warning}\n`)

  const file = config.statusFile
  const targets = new Set(config.push.targets.length > 0 ? config.push.targets : [...PHASE_STATES])
  const cursor = await readCursor()
  let sessionId = config.push.session || cursor.session

  if (!config.push.enabled) {
    process.stderr.write('push 未启用（ini 的 [push] enabled = false）。要启用请改 ini，或用 --create-session 先建会话。\n')
    if (!options.createSession) {
      process.exitCode = 1
      return
    }
  }
  if (!options.dryRun && sessionId.length === 0 && !options.createSession) {
    // 明确报错，绝不静默丢状态。
    process.stderr.write('没有配置目标会话（ini 的 [push] session 为空）。先跑一次 --create-session 建立一个，再把它填进 ini。\n')
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `status-push: 监听 ${file}\n  推送目标 = ${sessionId.length > 0 ? sessionId : '(尚未建立)'}\n  只推 = ${[...targets].join(', ')}（progress 不推）\n`,
  )

  let lastProcessed = 0
  for (;;) {
    const events = await readStatusEvents(file)
    const pending = events.slice(cursor.processed)
    let pushed = 0

    for (const event of pending) {
      cursor.processed += 1
      if (event.type !== 'status') continue
      if (!targets.has(event.state) || !PHASE_STATES.has(event.state)) continue
      if (options.job !== undefined && options.job.length > 0 && event.job !== options.job) continue

      const text = formatPush(event)
      if (options.dryRun) {
        process.stdout.write(`would push: ${text}\n`)
        pushed += 1
        continue
      }

      const created = sessionId.length === 0 && options.createSession
      const run = await runDshOnce({ dsh: options.dsh, text, sessionId: created ? '' : sessionId })
      const summary = summarize(run.stdout)
      if (created && summary.sessionId !== undefined) {
        sessionId = summary.sessionId
        cursor.session = sessionId
        await writeCursor(cursor)
        process.stdout.write(`已建立工作台会话：${sessionId}\n  （把它填进 ini 的 [push] session = 即持久生效）\n`)
      }
      if (run.code !== 0) {
        process.stderr.write(`push 失败（exit ${run.code}）：${run.stderr.split('\n')[0] || '(无 stderr)'}\n`)
      } else {
        process.stdout.write(`pushed: ${text}\n`)
        pushed += 1
      }
    }

    await writeCursor(cursor)
    if (cursor.processed !== lastProcessed) lastProcessed = cursor.processed

    if (options.once) {
      process.stdout.write(`done (processed ${cursor.processed} event(s), pushed ${pushed})\n`)
      return
    }
    if (!existsSync(file)) {
      process.stdout.write(`(等待状态文件出现：${file})\n`)
    }
    await sleep(options.intervalMs)
  }
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`)
    process.exitCode = 1
  })
}

export { main }
