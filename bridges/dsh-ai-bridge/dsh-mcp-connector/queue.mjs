/**
 * Task queue for the DSH MCP connector: a pull-based channel that lets an
 * external MCP client (Doubao, ZCode, Kimi Code, Claude Code, …) fetch work
 * queued elsewhere and report results back.
 *
 * Why pull instead of push: MCP tools only run inside a client's own turn, so
 * a client cannot be pushed work. Inverting the direction — the producer
 * appends to a queue, the client claims from it — needs nothing but the
 * connection that already exists.
 *
 * Storage is an append-only JSONL event log:
 *   {v:1, type:'publish',  id, task, source, at}
 *   {v:1, type:'claim',    id, worker, at}
 *   {v:1, type:'complete', id, status, result, at}
 * State is folded from the events, so a crash mid-write can only lose the last
 * partial line, never corrupt earlier history. Cross-process exclusion uses an
 * atomic lock directory next to the log.
 *
 * Zero dependencies.
 */

import { mkdir, readFile, appendFile, stat, rm, open } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Milliseconds a lock directory may stay before another process steals it. */
const STALE_LOCK_MS = 30_000
const LOCK_TIMEOUT_MS = 10_000
const MAX_STORED_RESULT_CHARS = 200_000

/**
 * Resolve the queue file: `DSH_QUEUE_FILE` wins, then `$DSH_HOME/mcp-connector/`,
 * then `~/.dsh-mcp-connector/tasks.jsonl`.
 */
export function resolveQueueFile(env = process.env) {
  const explicit = env.DSH_QUEUE_FILE?.trim()
  if (explicit) return explicit
  const home = env.DSH_HOME?.trim()
  if (home) return join(home, 'mcp-connector', 'tasks.jsonl')
  return join(homedir(), '.dsh-mcp-connector', 'tasks.jsonl')
}

/** Directory the connector owns: the queue log and its sidecar state live here. */
export function resolveQueueDir(env = process.env) {
  return dirname(resolveQueueFile(env))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Run `operation` while holding an exclusive lock next to `target`. */
export async function withFileLock(target, operation) {
  const lockDir = `${target}.lock`
  await mkdir(dirname(target), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  for (;;) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const info = await stat(lockDir)
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockDir, { recursive: true, force: true })
          continue
        }
      } catch {
        // The lock vanished between mkdir and stat: retry immediately.
        continue
      }
      if (Date.now() > deadline) throw new Error(`queue lock timeout on ${lockDir}`)
      await sleep(15 + Math.floor(Math.random() * 35))
    }
  }

  try {
    return await operation()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Read the event log, tolerating a missing file and a torn final line. */
async function readEvents(file) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const events = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.type === 'string') events.push(parsed)
    } catch {
      // A half-written trailing line: skip it, the rest of the log is intact.
    }
  }
  return events
}

/** Fold the event log into the current state of every task. */
export function foldEvents(events) {
  const tasks = new Map()
  for (const event of events) {
    if (typeof event.id !== 'string') continue
    if (event.type === 'publish') {
      if (tasks.has(event.id)) continue
      tasks.set(event.id, {
        id: event.id,
        task: String(event.task ?? ''),
        source: event.source === undefined ? undefined : String(event.source),
        publishedAt: Number(event.at ?? 0),
        claim: null,
        completion: null,
      })
      continue
    }
    const entry = tasks.get(event.id)
    if (entry === undefined) continue
    if (event.type === 'claim' && entry.claim === null) {
      entry.claim = { worker: String(event.worker ?? 'unknown'), at: Number(event.at ?? 0) }
    } else if (event.type === 'complete' && entry.completion === null) {
      entry.completion = {
        status: event.status === 'error' ? 'error' : 'ok',
        result: String(event.result ?? ''),
        at: Number(event.at ?? 0),
      }
    }
  }
  return [...tasks.values()].sort((a, b) => a.publishedAt - b.publishedAt)
}

/** 'pending' | 'claimed' | 'done' */
export function taskState(entry) {
  if (entry.completion !== null) return 'done'
  if (entry.claim !== null) return 'claimed'
  return 'pending'
}

function newTaskId() {
  return `t-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

/**
 * Return '\n' when the log does not end on a line boundary.
 *
 * A crash between writes can leave a torn final line with no newline. Appending
 * straight onto it would concatenate the two records, making the NEW event
 * unparseable too — the exact data loss the append-only design claims to avoid.
 * Repairing the break costs one byte read per append.
 */
async function newlineGuard(file) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
  try {
    const info = await handle.stat()
    if (info.size === 0) return ''
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, info.size - 1)
    return last[0] === 0x0a ? '' : '\n'
  } finally {
    await handle.close()
  }
}

/**
 * Append one JSON record as a line, repairing a torn final line first.
 * Shared with the status log, which uses the same crash-safety discipline.
 */
export async function appendJsonLine(file, record) {
  await mkdir(dirname(file), { recursive: true })
  const prefix = await newlineGuard(file)
  await appendFile(file, `${prefix}${JSON.stringify(record)}\n`, 'utf8')
}

async function appendEvent(file, event) {
  return appendJsonLine(file, { v: 1, ...event })
}

/** Append one task; returns the entry that a claim will later hand out. */
export async function publishTask({ task, source }, env = process.env) {
  const text = typeof task === 'string' ? task.trim() : ''
  if (text.length === 0) throw new Error('task must be a non-empty string')
  const file = resolveQueueFile(env)
  const event = { type: 'publish', id: newTaskId(), task: text, source, at: Date.now() }
  await withFileLock(file, () => appendEvent(file, event))
  return { id: event.id, publishedAt: event.at }
}

/**
 * Claim the oldest task that nobody has claimed or completed.
 * Returns `{claimed: false}` when the queue is empty.
 */
export async function claimTask({ worker } = {}, env = process.env) {
  const file = resolveQueueFile(env)
  const label = typeof worker === 'string' && worker.trim().length > 0 ? worker.trim() : 'anonymous'
  return withFileLock(file, async () => {
    const entries = foldEvents(await readEvents(file))
    const next = entries.find((entry) => taskState(entry) === 'pending')
    if (next === undefined) {
      return { claimed: false, pending: 0, claimedCount: entries.filter((e) => taskState(e) === 'claimed').length }
    }
    await appendEvent(file, { type: 'claim', id: next.id, worker: label, at: Date.now() })
    return {
      claimed: true,
      id: next.id,
      task: next.task,
      source: next.source,
      publishedAt: next.publishedAt,
      worker: label,
    }
  })
}

/** Record a result. Completing an already-completed task is a no-op. */
export async function completeTask({ id, status, result } = {}, env = process.env) {
  if (typeof id !== 'string' || id.trim().length === 0) throw new Error('id must be a non-empty string')
  const file = resolveQueueFile(env)
  const body = String(result ?? '').slice(0, MAX_STORED_RESULT_CHARS)
  return withFileLock(file, async () => {
    const entries = foldEvents(await readEvents(file))
    const entry = entries.find((candidate) => candidate.id === id)
    if (entry === undefined) throw new Error(`unknown task id: ${id}`)
    if (entry.completion !== null) {
      return { accepted: true, alreadyCompleted: true, status: entry.completion.status }
    }
    await appendEvent(file, {
      type: 'complete',
      id,
      status: status === 'error' ? 'error' : 'ok',
      result: body,
      at: Date.now(),
    })
    return { accepted: true, alreadyCompleted: false, status: status === 'error' ? 'error' : 'ok' }
  })
}

/** Read-only view. `state` filters to pending / claimed / done / all. */
export async function listTasks({ state = 'all', limit } = {}, env = process.env) {
  const file = resolveQueueFile(env)
  const entries = foldEvents(await readEvents(file))
  const filtered = state === 'all' ? entries : entries.filter((entry) => taskState(entry) === state)
  const sliced = Number.isInteger(limit) && limit > 0 ? filtered.slice(-limit) : filtered
  return sliced.map((entry) => ({
    id: entry.id,
    state: taskState(entry),
    task: entry.task,
    source: entry.source,
    worker: entry.claim?.worker,
    publishedAt: entry.publishedAt,
    status: entry.completion?.status,
    result: entry.completion?.result,
  }))
}

/**
 * Wait until the queue itself records a completion for `id`.
 *
 * This is the pull-based counterpart of `doubao-cdp/dispatch.mjs --queue`. There
 * is no app to poke here, so "hand out work and wait for it to finish" reduces to
 * "publish, then wait for the completion event" — and the verdict comes from the
 * queue, never from a client saying it finished. That distinction is the whole
 * point: a client can claim to be done in chat while the file says otherwise.
 *
 * @returns verdict `completed` (with the recorded status/result), `timeout` (the
 *   task exists but no completion arrived in time) or `unknown` (no such id).
 */
export async function waitForCompletion(
  { id, timeoutMs = 600_000, intervalMs = 1_000, now = Date.now, sleep = defaultSleep } = {},
  env = process.env,
) {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  for (;;) {
    const tasks = await listTasks({ state: 'all' }, env)
    const entry = tasks.find((task) => task.id === id)
    if (entry !== undefined && entry.state === 'done') {
      return {
        verdict: 'completed',
        id,
        state: entry.state,
        status: entry.status,
        result: entry.result,
        waitedMs: now() - startedAt,
      }
    }
    if (now() >= deadline) {
      if (entry === undefined) return { verdict: 'unknown', id, waitedMs: now() - startedAt }
      return { verdict: 'timeout', id, state: entry.state, worker: entry.worker, waitedMs: now() - startedAt }
    }
    await sleep(Math.max(10, Math.min(intervalMs, deadline - now())))
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Parse `--flag value` pairs plus the remaining positional text. */
function splitFlags(tokens, valueFlags) {
  const flags = {}
  const rest = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (valueFlags.includes(token)) {
      flags[token] = tokens[++index]
      continue
    }
    if (token.startsWith('--')) {
      flags[token] = true
      continue
    }
    rest.push(token)
  }
  return { flags, text: rest.join(' ').trim() }
}

/** Entry point for `node queue.mjs …`. */
async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const file = resolveQueueFile()
  const print = (value) => process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
  const usage =
    'usage: queue.mjs add <text> [--wait] [--timeout <ms>] | list [state] | claim | complete <id> [result] | wait <id> [--timeout <ms>] [--interval <ms>] | file'

  if (command === 'add') {
    const { flags, text } = splitFlags(rest, ['--timeout', '--interval'])
    if (text.length === 0) throw new Error('usage: queue.mjs add <text> [--wait] [--timeout <ms>]')
    const published = await publishTask({ task: text, source: 'cli' })
    if (flags['--wait'] !== true) {
      print({ file, ...published })
      return
    }
    print({ file, ...published, waiting: true })
    const verdict = await waitForCompletion({
      id: published.id,
      timeoutMs: Number(flags['--timeout'] ?? 600_000),
      intervalMs: Number(flags['--interval'] ?? 1_000),
    })
    print(verdict)
    process.exitCode = verdict.verdict === 'completed' ? (verdict.status === 'error' ? 3 : 0) : 2
    return
  }
  if (command === 'wait') {
    const { flags, text: id } = splitFlags(rest, ['--timeout', '--interval'])
    if (id.length === 0) throw new Error('usage: queue.mjs wait <id> [--timeout <ms>] [--interval <ms>]')
    const verdict = await waitForCompletion({
      id,
      timeoutMs: Number(flags['--timeout'] ?? 600_000),
      intervalMs: Number(flags['--interval'] ?? 1_000),
    })
    print(verdict)
    // 0 完成且成功 / 2 超时未核实 / 3 完成但报了错 / 5 没有这个 id
    process.exitCode = verdict.verdict === 'completed' ? (verdict.status === 'error' ? 3 : 0) : verdict.verdict === 'timeout' ? 2 : 5
    return
  }
  if (command === 'list') {
    print({ file, tasks: await listTasks({ state: rest[0] ?? 'all' }) })
  } else if (command === 'claim') {
    print(await claimTask({ worker: 'cli' }))
  } else if (command === 'complete') {
    const [id, ...resultParts] = rest
    if (id === undefined) throw new Error('usage: queue.mjs complete <id> [result text]')
    print(await completeTask({ id, status: 'ok', result: resultParts.join(' ') }))
  } else if (command === 'file') {
    print(file)
  } else {
    print(usage)
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`)
    process.exitCode = 1
  })
}
