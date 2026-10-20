#!/usr/bin/env node
/**
 * dsh-mcp-connector — an MCP stdio server that delivers messages into a local
 * DeepSeek Harness (DSH) installation.
 *
 * Design notes:
 * - Zero runtime dependencies. MCP's stdio transport is newline-delimited
 *   JSON-RPC 2.0, so the protocol half is implemented directly here.
 * - DSH is driven through `dsh --profile headless --json`, the one-shot profile
 *   that ships with the CLI. Nothing in the DSH installation is modified and no
 *   running `dsh web` service is touched.
 * - The task text is always piped through stdin (`-` argument) so that arbitrary
 *   text never has to survive shell/argv quoting on Windows.
 * - stdout is the MCP channel. Every diagnostic goes to stderr.
 *
 * Environment:
 * - DSH_BIN      absolute path to the dsh executable (default: `dsh` on PATH)
 * - DSH_ASK_TIMEOUT_MS  default timeout for one dsh_ask call (default 900000)
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  publishTask,
  claimTask,
  completeTask,
  listTasks,
  resolveQueueFile,
  resolveQueueDir,
  withFileLock,
} from './queue.mjs'

const SERVER_NAME = 'dsh-mcp-connector'
const SERVER_VERSION = '0.1.0'

/** This file's directory, for resolving the sibling `doubao-cdp/status.mjs`. */
const SELF_DIR = dirname(fileURLToPath(import.meta.url))

/** Protocol revisions this server knows how to answer with. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_PROTOCOL_VERSION = '2025-11-25'

const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_ASK_TIMEOUT_MS ?? 15 * 60 * 1000)
// Codex app-server currently gives an MCP call five minutes. Return control well
// before that limit and let the caller poll the same locally-owned DSH process.
const MAX_MCP_WAIT_MS = 55_000
const MAX_RESULT_CHARS = 200_000
const MAX_STDOUT_BYTES = 32 * 1024 * 1024
const MAX_STDERR_CHARS = 20_000

/** Session ids travel through the child argv, so keep them to a safe alphabet. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/

/* ------------------------------------------------------------------ logging */

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`)
}

/* ----------------------------------------------------------- dsh invocation */

/**
 * Resolve how to launch the dsh CLI.
 * On Windows the CLI is a `.cmd` shim, which Node cannot execute without a
 * shell. To avoid the "args with shell:true" deprecation hazard, the whole
 * command line is assembled here as a single shell string and passed with no
 * argv array. Only space-free, caller-controlled tokens ever reach it: the
 * task text itself travels through stdin, and session ids are validated.
 */
export function resolveDshCommand() {
  const bin = process.env.DSH_BIN?.trim()
  return { command: bin && bin.length > 0 ? bin : 'dsh' }
}

/** Quote one shell token for cmd.exe / POSIX sh. */
function quoteToken(token) {
  if (/^[A-Za-z0-9._:/\\=+-]+$/.test(token)) return token
  return `"${token.replace(/"/g, '\\"')}"`
}

/**
 * Decode captured CLI output.
 *
 * Most of what the CLI prints is UTF-8, but a Windows shell that rejects a
 * command emits the console code page instead — GBK on a zh-CN system — and
 * reading that as UTF-8 yields unreadable mojibake in the tool result. When the
 * bytes are not valid UTF-8, GBK is tried and used only if it decodes cleanly.
 */
export function decodeCliText(buffer) {
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buffer)
    return gbk.includes('\uFFFD') ? utf8 : gbk
  } catch {
    // A Node build without full ICU cannot decode GBK; the UTF-8 text stands.
    return utf8
  }
}

/** Build the spawn() arguments for one dsh invocation. */
function buildSpawnPlan(args) {
  const { command } = resolveDshCommand()
  if (process.platform === 'win32') {
    const line = [command, ...args].map(quoteToken).join(' ')
    return { file: line, argv: [], shell: true }
  }
  return { file: command, argv: args, shell: false }
}

/**
 * Run the dsh CLI once and collect its output.
 * @param args - argv tokens appended after the executable.
 * @param options - stdin text, cwd, timeout, JSON-lines parsing.
 */
export function runDsh(args, options = {}) {
  const plan = buildSpawnPlan(args)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cwd = options.cwd ?? process.cwd()

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(plan.file, plan.argv, {
        cwd,
        shell: plan.shell,
        env: options.extraEnv === undefined ? process.env : { ...process.env, ...options.extraEnv },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      options.onChild?.(child)
    } catch (error) {
      reject(new Error(`failed to spawn "${[plan.file, ...plan.argv].join(' ')}": ${String(error)}`))
      return
    }

    const startedAt = Date.now()
    const records = []
    let stdoutBytes = 0
    let stdoutRemainder = ''
    let stdoutText = ''
    let overflowed = false
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* the process may already be gone */
      }
      reject(new Error(`dsh did not finish within ${timeoutMs} ms (killed)`))
    }, timeoutMs)

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8')
      if (stdoutText.length < MAX_STDERR_CHARS) stdoutText += chunk
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        overflowed = true
        child.kill()
        return
      }
      if (!options.parseJsonLines) return
      stdoutRemainder += chunk
      let index = stdoutRemainder.indexOf('\n')
      while (index !== -1) {
        const line = stdoutRemainder.slice(0, index).trim()
        stdoutRemainder = stdoutRemainder.slice(index + 1)
        if (line.length > 0) {
          try {
            records.push(JSON.parse(line))
          } catch {
            records.push({ type: 'unparsed', raw: line.slice(0, 2000) })
          }
        }
        index = stdoutRemainder.indexOf('\n')
      }
    })

    // stderr is collected as bytes, not text: on Windows the shell and some
    // tools emit the console code page (GBK on a zh-CN system) rather than
    // UTF-8, and decoding that as UTF-8 turns the message into mojibake.
    const stderrChunks = []
    let stderrBytes = 0
    child.stderr.on('data', (chunk) => {
      if (stderrBytes < MAX_STDERR_CHARS * 4) {
        stderrChunks.push(chunk)
        stderrBytes += chunk.length
      }
    })

    child.on('error', (error) => {
      finish(() => reject(new Error(`cannot run the dsh CLI (${command}): ${error.message}`)))
    })

    child.on('close', (code, signal) => {
      finish(() => {
        if (overflowed) {
          reject(new Error(`dsh produced more than ${MAX_STDOUT_BYTES} bytes on stdout; aborted`))
          return
        }
        if (options.parseJsonLines && stdoutRemainder.trim().length > 0) {
          try {
            records.push(JSON.parse(stdoutRemainder.trim()))
          } catch {
            /* trailing partial line: ignore */
          }
        }
        resolve({
          code,
          signal,
          stdout: records,
          stdoutText,
          stderr: decodeCliText(Buffer.concat(stderrChunks)).slice(0, MAX_STDERR_CHARS),
          durationMs: Date.now() - startedAt,
        })
      })
    })

    if (options.stdin !== undefined) {
      child.stdin.on('error', () => {
        /* EPIPE when the child exits early; the close handler reports the result */
      })
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }
  })
}

/**
 * Interpret the `--json` event projection of one headless run.
 * Shape is owned by @deepseek-ai/dsh-headless (`projectJsonRun`):
 *   {type:'session', sessionId, cwd}
 *   {type:'status', phase:'turn_start'|'step_start'|'step_end'|'turn_end', ...}
 *   {type:'thinking'|'text', text} | {type:'tool_call'|'tool_result', ...}
 *   {type:'final', text}
 */
export function summarizeRun(stdout) {
  let sessionId
  let answer = ''
  const toolCalls = []
  let turnEnd

  for (const record of stdout) {
    if (record === null || typeof record !== 'object') continue
    switch (record.type) {
      case 'session':
        if (typeof record.sessionId === 'string') sessionId = record.sessionId
        break
      case 'text':
        if (typeof record.text === 'string') answer += record.text
        break
      case 'final':
        if (typeof record.text === 'string') answer = record.text
        break
      case 'tool_call':
        toolCalls.push(typeof record.tool === 'string' ? record.tool : 'unknown')
        break
      case 'status':
        if (record.phase === 'turn_end') turnEnd = record
        break
      default:
        break
    }
  }

  return { sessionId, answer, toolCalls, turnEnd }
}

function truncate(text, limit = MAX_RESULT_CHARS) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}\n... [truncated, ${text.length - limit} more characters]`, truncated: true }
}

const activeDshTasks = new Map()
const implicitSessionByCwd = new Map()
const dshTaskId = () => `dsh-${randomBytes(12).toString('hex')}`
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const dshControlDir = process.env.DSH_CONTROL_DIR || join(process.cwd(), 'data', 'dsh-control')

function dshTaskText(run, args) {
  const summary = summarizeRun(run.stdout)
  const lines = []
  lines.push(summary.answer.trim().length > 0 ? summary.answer.trim() : '(DSH returned no final text)')
  lines.push('')
  lines.push('---')
  lines.push(`sessionId: ${summary.sessionId ?? args.sessionId ?? '(none reported)'}`)
  if (summary.toolCalls.length > 0) lines.push(`tool calls: ${summary.toolCalls.join(', ')}`)
  lines.push(`duration: ${(run.durationMs / 1000).toFixed(1)}s, exit code: ${String(run.code)}`)
  if (run.code !== 0 || summary.answer.trim().length === 0) {
    lines.push(`stderr:\n${truncate(run.stderr.trim() || '(no stderr)', 4000).text}`)
  }
  return { text: lines.join('\n'), isError: run.code !== 0 && summary.answer.trim().length === 0, sessionId: summary.sessionId }
}

function startDshTask(args) {
  const id = dshTaskId()
  const cwd = typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd : process.env.DSH_WORKSPACE?.trim() || undefined
  const argv = ['--profile', 'headless', '--json']
  if (args.sessionId !== undefined) argv.push('--session-id', args.sessionId)
  argv.push('-')
  const task = { id, startedAt: Date.now(), child: null, outcome: null, cancelled: false }
  const cancelFile = join(dshControlDir, `${id}.cancel`)
  const cancellationWatch = setInterval(() => {
    if (!existsSync(cancelFile) || task.outcome) return
    task.cancelled = true
    try { task.child?.kill() } catch { /* process already ended */ }
  }, 500)
  cancellationWatch.unref?.()
  task.promise = runDsh(argv, {
    stdin: args.task,
    cwd,
    timeoutMs: Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS,
    parseJsonLines: true,
    onChild: child => { task.child = child },
  }).then(run => {
    task.outcome = dshTaskText(run, args)
    return task.outcome
  }).catch(error => {
    task.outcome = { text: `DeepSeek 任务未完成：${error instanceof Error ? error.message : String(error)}`, isError: !task.cancelled }
    return task.outcome
  }).finally(() => {
    clearInterval(cancellationWatch)
    setTimeout(() => activeDshTasks.delete(id), 30 * 60 * 1000).unref?.()
  })
  activeDshTasks.set(id, task)
  return task
}

async function waitForDshTask(task, waitMs) {
  if (task.outcome) return task.outcome
  await Promise.race([task.promise, sleep(waitMs)])
  if (task.outcome) return task.outcome
  return {
    text: JSON.stringify({ status: 'running', taskId: task.id, message: 'DeepSeek 仍在执行；请使用 dsh_wait 继续等待，不要重复提交任务。' }),
    isError: false,
  }
}

function requestedWaitMs(value) {
  const milliseconds = Number.isFinite(value) ? Number(value) : MAX_MCP_WAIT_MS
  return Math.max(1_000, Math.min(milliseconds, MAX_MCP_WAIT_MS))
}

/** Start a DSH task and wait only within the upstream MCP-safe window. */
async function dshAsk(args) {
  const task = typeof args?.task === 'string' ? args.task : ''
  if (task.trim().length === 0) throw new Error('task must be a non-empty string')

  const requestedCwd = typeof args?.cwd === 'string' && args.cwd.trim().length > 0 ? args.cwd : process.env.DSH_WORKSPACE?.trim() || process.cwd()
  const sessionId = args?.sessionId || implicitSessionByCwd.get(requestedCwd)
  if (sessionId !== undefined) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('sessionId has an unexpected shape; use the id returned by a previous dsh_ask call')
    }
  }
  const taskRun = startDshTask({ ...args, cwd: requestedCwd, task, sessionId })
  taskRun.cwd = requestedCwd
  const outcome = await waitForDshTask(taskRun, requestedWaitMs(args?.waitMs))
  if (taskRun.outcome?.sessionId && requestedCwd) implicitSessionByCwd.set(requestedCwd, taskRun.outcome.sessionId)
  return { ...outcome, raw: args?.includeEvents === true && taskRun.outcome ? taskRun.outcome.raw : undefined }
}

async function dshWait(args) {
  const taskId = typeof args?.taskId === 'string' ? args.taskId : ''
  const task = activeDshTasks.get(taskId)
  if (!task) return { text: JSON.stringify({ status: 'unknown', taskId, message: '找不到仍在本连接器中执行的 DeepSeek 任务。' }), isError: true }
  const result = await waitForDshTask(task, requestedWaitMs(args?.waitMs))
  if (task.outcome?.sessionId && task.cwd) implicitSessionByCwd.set(task.cwd, task.outcome.sessionId)
  return result
}

async function dshCancel(args) {
  const taskId = typeof args?.taskId === 'string' ? args.taskId : ''
  const task = activeDshTasks.get(taskId)
  if (!task) return { text: JSON.stringify({ status: 'unknown', taskId }), isError: true }
  task.cancelled = true
  try { task.child?.kill() } catch { /* process already ended */ }
  return { text: JSON.stringify({ status: 'cancelling', taskId, message: '已向 DeepSeek 进程发送停止请求。' }), isError: false }
}

/** `dsh_cli_info` implementation: prove the connector can really reach DSH. */
async function dshCliInfo() {
  const { command } = resolveDshCommand()
  const run = await runDsh(['--version'], { timeoutMs: 60_000, parseJsonLines: false })
  const version = run.stderr.trim().length > 0 && run.code !== 0 ? run.stderr.trim() : '(see exit code)'
  const text = [
    `dsh executable: ${command}${process.platform === 'win32' ? '  (launched through the Windows shell)' : ''}`,
    `dsh --version exit code: ${String(run.code)}`,
    version !== '(see exit code)' ? `stderr: ${version}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
  return { text, isError: run.code !== 0 }
}

/* ------------------------------------------------------------- task queue */

/**
 * The queue inverts the direction of control: a producer (DSH, a script, an
 * HTTP caller) appends work, and this connector's client claims it. MCP tools
 * only run inside a client's own turn, so a client can never be pushed work —
 * pulling is the only shape that needs no extra channel.
 */
async function queueTool(name, args) {
  if (name === 'task_publish') {
    const published = await publishTask({ task: args?.task, source: args?.source ?? 'mcp' })
    return { text: `published ${published.id}\nqueue file: ${resolveQueueFile()}`, isError: false }
  }

  if (name === 'task_claim') {
    const claimed = await claimTask({ worker: args?.worker })
    if (!claimed.claimed) {
      return { text: `no pending task (claimed but unfinished: ${claimed.claimedCount})`, isError: false }
    }
    return {
      text: [
        `task id: ${claimed.id}`,
        claimed.source === undefined ? '' : `source: ${claimed.source}`,
        '--- task ---',
        claimed.task,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      isError: false,
    }
  }

  if (name === 'task_complete') {
    const done = await completeTask({ id: args?.id, status: args?.status, result: args?.result })
    return {
      text: done.alreadyCompleted
        ? `task ${String(args?.id)} was already completed (${String(done.status)}); nothing recorded`
        : `task ${String(args?.id)} completed (${String(done.status)})`,
      isError: false,
    }
  }

  if (name === 'task_list') {
    const tasks = await listTasks({ state: args?.state ?? 'all', limit: args?.limit })
    if (tasks.length === 0) return { text: `no tasks (state=${String(args?.state ?? 'all')})`, isError: false }
    const lines = tasks.map(
      (entry) =>
        `${entry.state.padEnd(7)} ${entry.id}  ${entry.task.replace(/\s+/g, ' ').slice(0, 100)}` +
        (entry.worker === undefined ? '' : `  [${entry.worker}]`),
    )
    return { text: `${lines.join('\n')}\n(${tasks.length} task(s), queue file: ${resolveQueueFile()})`, isError: false }
  }

  throw new Error(`unknown queue tool: ${name}`)
}

/* -------------------------------------------------------- connector state */

/** Which transport this process is serving; recorded alongside each client. */
let currentTransport = 'stdio'

const CLIENT_STATE_FILE = 'clients.json'

/**
 * Record which MCP client just initialized this connector.
 *
 * Worth recording because "is anything actually attached to my connector?" is
 * otherwise unanswerable from the outside. Caveat: a client's helper process
 * may launch the connector without the client's conversation exposing its
 * tools, so a recorded client is evidence of a connection, not of the tools
 * being usable in a given conversation.
 */
async function recordClient(clientInfo, protocolVersion) {
  try {
    const dir = resolveQueueDir()
    const file = join(dir, CLIENT_STATE_FILE)
    await withFileLock(file, async () => {
      let state = { clients: [] }
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.clients)) state = parsed
      } catch {
        // First run, or an unreadable file: start a fresh record.
      }
      const name = String(clientInfo?.name ?? 'unknown')
      const version = String(clientInfo?.version ?? '')
      const now = Date.now()
      const existing = state.clients.find(
        (entry) => entry.name === name && entry.version === version && entry.transport === currentTransport,
      )
      if (existing === undefined) {
        state.clients.push({
          name,
          version,
          transport: currentTransport,
          protocolVersion,
          firstSeenAt: now,
          lastSeenAt: now,
          initializations: 1,
        })
      } else {
        existing.lastSeenAt = now
        existing.protocolVersion = protocolVersion
        existing.initializations += 1
      }
      await mkdir(dir, { recursive: true })
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    })
  } catch (error) {
    // Never fail a handshake over bookkeeping.
    log(`could not record the client: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readClients() {
  try {
    const parsed = JSON.parse(await readFile(join(resolveQueueDir(), CLIENT_STATE_FILE), 'utf8'))
    return Array.isArray(parsed?.clients) ? parsed.clients : []
  } catch {
    return []
  }
}

/** `connector_status` implementation: what this connector knows about itself. */
async function connectorStatus() {
  const clients = await readClients()
  const tasks = await listTasks({ state: 'all' })
  const counts = { pending: 0, claimed: 0, done: 0 }
  for (const task of tasks) counts[task.state] += 1

  const lines = [
    `connector: dsh-mcp-connector ${SERVER_VERSION} (node ${process.version}, ${process.platform})`,
    `transport: ${currentTransport}`,
    `queue file: ${resolveQueueFile()}`,
    `tasks: ${tasks.length} total — pending ${counts.pending}, claimed ${counts.claimed}, done ${counts.done}`,
    `clients seen: ${clients.length}`,
  ]
  for (const client of clients) {
    const ageSeconds = Math.round((Date.now() - client.lastSeenAt) / 1000)
    lines.push(
      `  - ${client.name}${client.version.length > 0 ? `@${client.version}` : ''} via ${client.transport}, ` +
        `${client.initializations}x, last seen ${ageSeconds}s ago`,
    )
  }
  if (clients.length === 0) {
    lines.push('  (none — no MCP client has initialized this connector yet)')
  }
  return { text: lines.join('\n'), isError: false }
}

/* ------------------------------------------- status channel (Doubao-app parity) */

/** The status states a worker may report. `received` is the sender's own fact, not a worker's. */
export const STATUS_STATES = ['start', 'progress', 'need-input', 'done', 'fail']

/**
 * Where `status.mjs` lives.
 *
 * Reporting goes through that script rather than re-implementing its event
 * contract here: the controller badge reads the file it writes, and a second
 * implementation would be a second source of truth for the same rules
 * (enabled states, throttling, truncation).
 *
 * `DOUBAO_STATUS_SCRIPT` is authoritative when set (so a wrong value is an
 * honest error, not a silent fallback); otherwise the sibling `doubao-cdp`
 * directory is used, which is how both the live workspace and this repo are laid out.
 */
export function resolveStatusScript(env = process.env) {
  const override = typeof env.DOUBAO_STATUS_SCRIPT === 'string' ? env.DOUBAO_STATUS_SCRIPT.trim() : ''
  const candidates = override.length > 0 ? [override] : [join(SELF_DIR, '..', 'doubao-cdp', 'status.mjs')]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    // Spawn the **real** path, not the one we were handed: status.mjs refuses to do
    // anything when `import.meta.url` does not equal `pathToFileURL(process.argv[1])`,
    // and node resolves the entry module to its real path. Invoked through a
    // symlink/junction that comparison fails, so the script exits 0 with no output
    // and no event — a silent no-op the caller would read as success. Resolving
    // first keeps the guard satisfied.
    let script = candidate
    try {
      script = realpathSync(candidate)
    } catch {
      /* fall back to the candidate as given */
    }
    return { script, candidates }
  }
  return { script: null, candidates }
}

/** Run `node <script> ...args` once and collect what it said. */
function runNodeScript(script, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      // No shell: the script path may contain spaces, and argv handles that.
      child = spawn(process.execPath, [script, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: `failed to spawn: ${String(error?.message ?? error)}` })
      return
    }
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
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }, timeoutMs)
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    child.on('error', (error) => finish({ code: null, stdout, stderr: `${stderr}${String(error?.message ?? error)}` }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}

/**
 * Report one status event for a job into the same file the DSH Web controller
 * badge reads. This is the piece the Doubao desktop app has (`status.mjs`) and a
 * plain MCP client otherwise lacks, so it is what makes a client's work visible
 * on the badge instead of only in its own chat.
 */
async function statusReport(args) {
  const state = String(args?.state ?? '').trim()
  const job = String(args?.job ?? '').trim()
  if (!STATUS_STATES.includes(state)) {
    return { text: `state must be one of: ${STATUS_STATES.join(', ')} (got: ${state.length > 0 ? state : 'empty'})`, isError: true }
  }
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(job)) {
    return { text: `job is required and must match [A-Za-z0-9._:-]{1,120} (got: ${job.length > 0 ? job : 'empty'})`, isError: true }
  }
  const { script, candidates } = resolveStatusScript()
  if (script === null) {
    return {
      text: `status.mjs not found; looked in:\n${candidates.map((candidate) => `  ${candidate}`).join('\n')}\nSet DOUBAO_STATUS_SCRIPT to point at it.`,
      isError: true,
    }
  }
  const argv = [state, '--job', job]
  if (typeof args?.message === 'string' && args.message.length > 0) argv.push('--message', args.message)
  if (typeof args?.step === 'string' && args.step.length > 0) argv.push('--step', args.step)
  if (Number.isFinite(Number(args?.percent))) argv.push('--percent', String(Number(args.percent)))

  const run = await runNodeScript(script, argv)
  const text = [
    `status ${state} · job ${job}`,
    `script: ${script}`,
    `exit code: ${run.code === null ? '(spawn failed)' : String(run.code)}`,
    run.stdout.trim().length > 0 ? `stdout: ${run.stdout.trim()}` : '',
    run.stderr.trim().length > 0 ? `stderr: ${run.stderr.trim()}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
  return { text, isError: run.code !== 0 }
}

/* ------------------------------------------------------------ MCP protocol */

const TOOLS = [
  {
    name: 'dsh_ask',
    description:
      'Deliver one message to the local DeepSeek Harness and return its final answer. Omit sessionId to start a new DSH session; pass the sessionId returned by a previous call to continue that same session.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The message/task text handed to DSH. Required and must not be blank.' },
        sessionId: { type: 'string', description: 'Optional. Continue an existing DSH session by id.' },
        cwd: { type: 'string', description: 'Optional absolute working directory for the DSH run.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds. Defaults to 900000.' },
        waitMs: { type: 'number', description: 'How long this MCP call waits before returning a running taskId. Maximum 55000ms.' },
        includeEvents: { type: 'boolean', description: 'Optional. Attach the raw event stream for debugging.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait',
    description: 'Wait briefly for an existing DeepSeek task started by dsh_ask. A running result means continue waiting with this same taskId.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, waitMs: { type: 'number' } }, required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'dsh_cancel',
    description: 'Stop an existing DeepSeek task started by dsh_ask.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false },
  },
  {
    name: 'dsh_cli_info',
    description:
      'Self-check: report which dsh executable this connector resolves and its version. Use it to confirm the connector can actually reach a local DSH installation.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'connector_status',
    description:
      'Report what this connector knows about itself: version, transport, queue file and task counts, and which MCP clients have initialized it (name, version, how many times, when last seen). Use it to check whether any client is actually attached.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'task_claim',
    description:
      'Claim the oldest pending task from the shared queue. Call this at the start of a turn to pick up work queued by DSH or a script; the returned id is what task_complete needs. Returns "no pending task" when the queue is empty.',
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'Optional label recorded on the claim (which client took it).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'task_complete',
    description:
      'Report the result of a claimed task. Completing an already-completed task is a no-op, so retries are safe.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id returned by task_claim or task_publish.' },
        status: { type: 'string', enum: ['ok', 'error'], description: 'Outcome. Defaults to ok.' },
        result: { type: 'string', description: 'The result text handed back to the producer.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_publish',
    description:
      'Append a task to the shared queue. Producers (DSH, scripts, an HTTP caller) use this; consumers use task_claim. Returns the new task id.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task text. Required and must not be blank.' },
        source: { type: 'string', description: 'Optional origin label, for example "dsh" or "cron".' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'status_report',
    description:
      'Report one status event for a job into the same status file the DSH Web controller badge reads (start | progress | need-input | done | fail). This is the reporting channel the Doubao desktop app has through status.mjs: use it so your work shows up on the badge. Saying "done" in chat is not evidence; this tool is.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: STATUS_STATES, description: 'start | progress | need-input | done | fail.' },
        job: { type: 'string', description: 'Job id, [A-Za-z0-9._:-]{1,120}. Required.' },
        message: { type: 'string', description: 'Optional short summary: the result, or the error.' },
        step: { type: 'string', description: 'Optional step name (for progress).' },
        percent: { type: 'number', description: 'Optional 0-100 completion (for progress).' },
      },
      required: ['state', 'job'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_list',
    description: 'Inspect the queue without claiming anything: which tasks are pending, claimed, or done.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['pending', 'claimed', 'done', 'all'], description: 'Filter. Defaults to all.' },
        limit: { type: 'number', description: 'Return at most the newest N tasks.' },
      },
      additionalProperties: false,
    },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function resultMessage(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function errorMessage(id, code, message, data) {
  return data === undefined
    ? { jsonrpc: '2.0', id, error: { code, message } }
    : { jsonrpc: '2.0', id, error: { code, message, data } }
}

function negotiateProtocolVersion(requested) {
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return requested
  return FALLBACK_PROTOCOL_VERSION
}

async function callTool(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  const known = new Set(TOOLS.map((tool) => tool.name))
  if (!known.has(name)) {
    return errorMessage(id, -32602, `unknown tool: ${String(name)}`)
  }
  try {
    const outcome =
      name === 'dsh_ask'
        ? await dshAsk(args)
        : name === 'dsh_wait'
          ? await dshWait(args)
          : name === 'dsh_cancel'
            ? await dshCancel(args)
        : name === 'dsh_cli_info'
          ? await dshCliInfo()
          : name === 'connector_status'
            ? await connectorStatus()
            : name === 'status_report'
              ? await statusReport(args)
              : await queueTool(name, args)
    const truncated = truncate(outcome.text)
    const content = [{ type: 'text', text: truncated.text }]
    if (outcome.raw !== undefined && !truncated.truncated) {
      content.push({ type: 'text', text: `\n[events]\n${JSON.stringify(outcome.raw, null, 2).slice(0, MAX_RESULT_CHARS)}` })
    }
    return resultMessage(id, { content, isError: outcome.isError === true })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    log(`tool ${String(name)} failed: ${text}`)
    return resultMessage(id, { content: [{ type: 'text', text: `tool ${String(name)} failed: ${text}` }], isError: true })
  }
}

/**
 * Build the JSON-RPC response for one incoming message, or undefined when the
 * message is a notification (which must not be answered). Shared by both
 * transports so stdio and HTTP behave identically.
 */
export async function buildResponse(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const id = message.id
  if (id === undefined || id === null) return undefined
  const { method, params } = message
  try {
    switch (method) {
      case 'initialize': {
        const protocolVersion = negotiateProtocolVersion(params?.protocolVersion)
        await recordClient(params?.clientInfo, protocolVersion)
        return resultMessage(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'This server forwards messages into a local DeepSeek Harness installation through `dsh --profile headless`. ' +
            'Messages delivered this way appear inside DSH as ordinary user messages, so state clearly in the task text that the request came from an external AI.',
        })
      }
      case 'ping':
        return resultMessage(id, {})
      case 'tools/list':
        return resultMessage(id, { tools: TOOLS })
      case 'tools/call':
        return await callTool(id, params)
      case 'resources/list':
        return resultMessage(id, { resources: [] })
      case 'prompts/list':
        return resultMessage(id, { prompts: [] })
      default:
        return errorMessage(id, -32601, `method not found: ${String(method)}`)
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return errorMessage(id, -32603, `internal error: ${text}`)
  }
}

/* ------------------------------------------------------------ stdio transport */

function runStdio() {
  currentTransport = 'stdio'
  let buffer = ''
  let stdinEnded = false
  let inflight = 0
  let handshakeComplete = false
  const queuedBeforeHandshake = []

  // Closing stdin terminates the server, but only after every in-flight request
  // has been answered: calling process.exit() while a response is still being
  // written can truncate it.
  const maybeExit = () => {
    if (stdinEnded && inflight === 0) process.exit(0)
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) dispatchLine(line)
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    if (buffer.trim().length > 0) dispatchLine(buffer.trim())
    stdinEnded = true
    maybeExit()
  })
  log(`stdio ready (dsh binary: ${resolveDshCommand().command})`)

  function dispatchLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log('ignored unparseable line from the client')
      return
    }

    // A client is supposed to wait for its `initialize` response before sending
    // anything else, but a pipelining client would otherwise race the handshake
    // bookkeeping. Hold everything until the handshake has been answered, then
    // drain in arrival order; afterwards messages stay concurrent.
    if (!handshakeComplete && message?.method !== 'initialize') {
      queuedBeforeHandshake.push(message)
      return
    }
    handleMessage(message)
  }

  function handleMessage(message) {
    if (message?.method === 'notifications/initialized') log('client initialized')
    inflight += 1
    buildResponse(message)
      .then((response) => {
        if (response !== undefined) send(response)
        if (!handshakeComplete && message?.method === 'initialize') {
          handshakeComplete = true
          for (const queued of queuedBeforeHandshake.splice(0)) handleMessage(queued)
        }
      })
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error)
        send(errorMessage(message?.id ?? null, -32603, `internal error: ${text}`))
      })
      .finally(() => {
        inflight -= 1
        maybeExit()
      })
  }
}

/* ------------------------------------ Streamable HTTP transport (MCP 2025-11-25) */

const MAX_HTTP_BODY_BYTES = 1024 * 1024

function tokenMatches(expected, presented) {
  if (typeof presented !== 'string' || presented.length === 0) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

async function handleHttpRequest(req, res, options) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const isMcpRoute = url.pathname === options.path
  const isQueueRoute = url.pathname === options.tasksPath
  if (!isMcpRoute && !isQueueRoute) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' })
    res.end('method not allowed')
    return
  }
  // MCP requires servers to validate Origin on incoming connections.
  const origin = req.headers.origin
  if (typeof origin === 'string' && !options.allowOrigins.has(origin)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    res.end(`origin not allowed: ${origin}`)
    return
  }
  const authorization = req.headers.authorization
  const presented =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
  if (!tokenMatches(options.token, presented)) {
    res.writeHead(401, { 'www-authenticate': 'Bearer', 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }

  let parsed
  try {
    parsed = JSON.parse(await readBody(req))
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    sendJson(res, 400, errorMessage(null, -32700, `parse error: ${text}`))
    return
  }

  // Producer route: enqueue work without going through an MCP client.
  if (isQueueRoute) {
    try {
      const published = await publishTask({
        task: parsed?.task,
        source: typeof parsed?.source === 'string' ? parsed.source : 'http',
      })
      sendJson(res, 201, { ...published, queueFile: resolveQueueFile() })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, errorMessage(null, -32602, text))
    }
    return
  }

  const batch = Array.isArray(parsed) ? parsed : [parsed]
  const responses = []
  for (const message of batch) {
    const response = await buildResponse(message)
    if (response !== undefined) responses.push(response)
  }
  if (responses.length === 0) {
    // Notifications only: acknowledge without a JSON-RPC body.
    res.writeHead(202)
    res.end()
    return
  }
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0])
}

function runHttp(options) {
  currentTransport = 'http'
  const server = createServer((req, res) => {
    handleHttpRequest(req, res, options).catch((error) => {
      const text = error instanceof Error ? error.message : String(error)
      log(`http handler failed: ${text}`)
      if (!res.headersSent) sendJson(res, 500, errorMessage(null, -32603, 'internal error'))
      else res.destroy()
    })
  })
  server.listen(options.port, options.host, () => {
    log(`streamable HTTP MCP endpoint: http://${options.host}:${options.port}${options.path}`)
    log(`task producer endpoint: POST http://${options.host}:${options.port}${options.tasksPath}  (queue file: ${resolveQueueFile()})`)
    log(
      `bearer token: ${options.token}` +
        (options.tokenGenerated ? '  (generated for this run; pin it with --token or DSH_MCP_TOKEN)' : ''),
    )
    if (options.host !== '127.0.0.1' && options.host !== 'localhost') {
      log('warning: bound beyond loopback; put a TLS reverse proxy in front and keep the token secret')
    }
  })
  server.on('error', (error) => {
    log(`cannot listen on ${options.host}:${options.port}: ${error.message}`)
    process.exit(1)
  })
}

/* ---------------------------------------------------------------- entry point */

const USAGE = `dsh-mcp-connector ${SERVER_VERSION}

Default is MCP over stdio, for local clients (Claude Code, Cursor, VS Code, Codex,
Qwen Code, Kimi CLI, CodeBuddy and any other stdio-capable MCP client).

  node server.mjs                       stdio transport
  node server.mjs --http                Streamable HTTP, for remote/cloud-hosted agents
  node server.mjs --http --port 8790 --host 127.0.0.1 --token <token>

Options:
  --http                  serve MCP over Streamable HTTP instead of stdio
  --host <host>           HTTP bind host (default 127.0.0.1)
  --port <port>           HTTP bind port (default 8790)
  --path <path>           HTTP MCP endpoint path (default /mcp)
  --tasks-path <path>     HTTP task-producer path (default /tasks)
  --token <token>         bearer token required on every HTTP request
  --allow-origin <origin> allow one Origin header value (repeatable)
  -h, --help              show this help

Environment:
  DSH_BIN                 dsh executable (default: dsh on PATH)
  DSH_WORKSPACE           default DSH session working directory (default: the client's cwd)
  DSH_ASK_TIMEOUT_MS      default dsh_ask timeout (default 900000)
  DSH_MCP_TOKEN           bearer token for --http
  DSH_MCP_HTTP_PORT       port for --http
  DSH_MCP_TASKS_PATH      task-producer path for --http (default /tasks)
  DSH_QUEUE_FILE          task queue JSONL path (default $DSH_HOME/mcp-connector/tasks.jsonl)

Tools: dsh_ask, dsh_cli_info, connector_status, task_claim, task_complete, task_publish, task_list
`

function parseArgs(argv) {
  const options = {
    mode: 'stdio',
    host: '127.0.0.1',
    port: Number(process.env.DSH_MCP_HTTP_PORT ?? 8790),
    path: '/mcp',
    tasksPath: process.env.DSH_MCP_TASKS_PATH?.trim() || '/tasks',
    token: process.env.DSH_MCP_TOKEN?.trim() || undefined,
    tokenGenerated: false,
    allowOrigins: new Set(),
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--http':
        options.mode = 'http'
        break
      case '--host':
        options.host = String(argv[++index] ?? options.host)
        break
      case '--port':
        options.port = Number(argv[++index] ?? options.port)
        break
      case '--path':
        options.path = String(argv[++index] ?? options.path)
        break
      case '--tasks-path':
        options.tasksPath = String(argv[++index] ?? options.tasksPath)
        break
      case '--token':
        options.token = String(argv[++index] ?? '')
        break
      case '--allow-origin':
        options.allowOrigins.add(String(argv[++index] ?? ''))
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        break
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) options.port = 8790
  if (!options.path.startsWith('/')) options.path = `/${options.path}`
  if (!options.tasksPath.startsWith('/')) options.tasksPath = `/${options.tasksPath}`
  if (options.mode === 'http' && (options.token === undefined || options.token.length === 0)) {
    options.token = randomBytes(24).toString('base64url')
    options.tokenGenerated = true
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  if (options.mode === 'http') runHttp(options)
  else runStdio()
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) main()
