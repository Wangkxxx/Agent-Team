#!/usr/bin/env node
/**
 * dispatch-work-selftest.mjs — 密封测试 `scripts/dispatch-work.mjs`。
 *
 * 全部在临时目录里跑：临时队列文件、指向没人监听的端口、假的 home。
 * 验的是「只信副作用」的三条硬要求：
 *   1. 前置确认不过 → 退出 3，且**一条任务都不入队**（不留孤儿任务）；
 *   2. `--no-preflight` 时才会入队，超时如实退出 2（**不是成功**）；
 *   3. 真被完成时退出 0，并且带出队列里记录的结果——判定来自队列，不是谁的自述。
 *
 * Usage: node scripts/dispatch-work-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { completeTask, listTasks } from '../dsh-mcp-connector/queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'dispatch-work.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

/** Run dispatch-work once and collect everything; never rejects. */
function runDispatch(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const parseJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function main() {
  process.stdout.write(`dispatch-work selftest (node ${process.version})\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'dispatch-work-selftest-'))
  const queueFile = join(scratch, 'tasks.jsonl')
  const env = { DSH_QUEUE_FILE: queueFile }

  try {
    // 1. Preflight refuses: exit 3, and nothing may be enqueued.
    const refused = await runDispatch(
      ['不该被入队的任务', '--url', 'http://127.0.0.1:9/mcp', '--home', join(scratch, 'no-home'), '--json'],
      env,
    )
    const refusedJson = parseJson(refused.stdout)
    check('preflight failure exits 3', refused.code === 3, `exit=${refused.code} ${refused.stderr.trim()}`)
    check(
      'preflight failure leaves no orphan task behind',
      !existsSync(queueFile) && refusedJson?.published === null,
      `queue file exists=${existsSync(queueFile)} published=${JSON.stringify(refusedJson?.published)}`,
    )
    check(
      'preflight failure names every reason',
      Array.isArray(refusedJson?.preflight?.reasons) && refusedJson.preflight.reasons.length === 2,
      JSON.stringify(refusedJson?.preflight?.reasons ?? null),
    )

    // 2. --no-preflight publishes, then honestly times out (exit 2, not success).
    const timedOut = await runDispatch(['超时探针任务', '--no-preflight', '--timeout', '500', '--interval', '100', '--json'], env)
    const timedOutJson = parseJson(timedOut.stdout)
    check('a timeout exits 2', timedOut.code === 2, `exit=${timedOut.code}`)
    check(
      'the timeout is reported as unsettled with the task state',
      timedOutJson?.verdict?.verdict === 'timeout' && timedOutJson?.verdict?.state === 'pending',
      JSON.stringify(timedOutJson?.verdict ?? null),
    )
    const afterTimeout = await listTasks({ state: 'all' }, { ...process.env, ...env })
    check('the enqueued task is really in the queue', afterTimeout.some((task) => task.id === timedOutJson?.published?.id), `${afterTimeout.length} task(s)`)

    // 3. A real completion is picked up from the queue: exit 0 with the recorded result.
    const child = spawn(process.execPath, [SCRIPT, '真完成路径', '--no-preflight', '--timeout', '8000', '--interval', '100', '--json'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childOut = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      childOut += chunk
    })
    // Play the worker: find the newest pending task and complete it.
    let workerId = null
    for (let attempt = 0; attempt < 60 && workerId === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const pending = await listTasks({ state: 'pending' }, { ...process.env, ...env })
      const candidate = pending.find((task) => task.task === '真完成路径')
      if (candidate !== undefined) workerId = candidate.id
    }
    check('the dispatcher enqueued the task for the worker to find', workerId !== null, String(workerId))
    if (workerId !== null) await completeTask({ id: workerId, status: 'ok', result: 'worker 说完成了' }, { ...process.env, ...env })
    const exitCode = await new Promise((resolve) => child.on('close', resolve))
    const completedJson = parseJson(childOut)
    check('a verified completion exits 0', exitCode === 0, `exit=${exitCode}`)
    check(
      'the verdict carries the result recorded in the queue',
      completedJson?.verdict?.verdict === 'completed' && completedJson?.verdict?.result === 'worker 说完成了',
      JSON.stringify(completedJson?.verdict ?? null),
    )

    // 4. Contract bits: --help and a missing task text.
    const help = await runDispatch(['--help'], env)
    check('--help exits 0 with usage', help.code === 0 && help.stdout.includes('usage: dispatch-work.mjs'), help.stdout.trim())
    const noTask = await runDispatch([], env)
    check('no task text exits 1 with usage on stderr', noTask.code === 1 && noTask.stderr.includes('usage: dispatch-work.mjs'), `exit=${noTask.code}`)

    // 5. The scratch queue is genuine append-only JSONL: every line must parse.
    const lines = readFileSync(queueFile, 'utf8').trim().split('\n').filter((line) => line.length > 0)
    let allParsed = lines.length > 0
    for (const line of lines) {
      try {
        JSON.parse(line)
      } catch {
        allParsed = false
      }
    }
    check('the queue file is append-only JSONL with one event per line', allParsed, `${lines.length} line(s)`)
  } catch (error) {
    check('dispatch-work selftest completed', false, String(error?.stack ?? error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
