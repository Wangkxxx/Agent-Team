#!/usr/bin/env node
/**
 * accept-doubao-work-selftest.mjs — 密封测试 `scripts/accept-doubao-work.mjs`。
 *
 * 验的是验收器自己会不会「放水」：
 *   1. 未就绪时：退出 3，且**一条任务都不入队**；
 *   2. 任务被完成但 result 里**没有标记**时：退出 3 ——「完成了别的事」不算验收通过；
 *   3. 结果里带回标记时：退出 0；
 *   4. 时限内没完成时：退出 2（明确不是成功）。
 * 全部在临时队列上跑，自己扮演那个「客户端」（领任务的工人）。
 *
 * Usage: node scripts/accept-doubao-work-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { completeTask, listTasks } from '../dsh-mcp-connector/queue.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'accept-doubao-work.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

function runAccept(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** Play the worker: wait for the acceptance task, then complete it with `result`. */
async function workOnce(env, { includeMarker }) {
  const queueEnv = { ...process.env, ...env }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const pending = await listTasks({ state: 'pending' }, queueEnv)
    const task = pending.find((entry) => entry.task.includes('ACCEPT-'))
    if (task === undefined) continue
    const marker = /ACCEPT-[a-z0-9]+/i.exec(task.task)?.[0] ?? ''
    await completeTask(
      { id: task.id, status: 'ok', result: includeMarker ? `做完了，标记是 ${marker}` : '做完了，但我没写标记' },
      queueEnv,
    )
    return { id: task.id, marker }
  }
  return null
}

async function main() {
  process.stdout.write(`accept-doubao-work selftest (node ${process.version})\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'accept-doubao-selftest-'))
  const queueFile = join(scratch, 'tasks.jsonl')
  const env = { DSH_QUEUE_FILE: queueFile }

  try {
    // 1. 未就绪（端点不可达 + 没有客户端记录）→ 退出 3 且不入队
    const refused = await runAccept(['--url', 'http://127.0.0.1:9/mcp', '--home', join(scratch, 'no-home'), '--json'], env)
    const refusedJson = parseJson(refused.stdout)
    check('未就绪时退出 3', refused.code === 3, `exit=${refused.code}`)
    check(
      '未就绪时一条任务都不入队（不留孤儿）',
      !existsSync(queueFile) && refusedJson?.published === null,
      `queue exists=${existsSync(queueFile)} published=${JSON.stringify(refusedJson?.published)}`,
    )

    // 2. 完成但没带标记 → 退出 3（这条是验收器最要紧的规则）
    const noMarkerRun = runAccept(['--no-preflight', '--timeout', '8000', '--interval', '100', '--json'], env)
    const workedNoMarker = await workOnce(env, { includeMarker: false })
    const noMarker = await noMarkerRun
    const noMarkerJson = parseJson(noMarker.stdout)
    check('工人确实完成了一条验收任务', workedNoMarker !== null, JSON.stringify(workedNoMarker))
    check(
      '完成了但 result 里没有标记 → 退出 3（不算通过）',
      noMarker.code === 3 && noMarkerJson?.markerInResult === false && noMarkerJson?.verdict?.verdict === 'completed',
      `exit=${noMarker.code} markerInResult=${noMarkerJson?.markerInResult}`,
    )

    // 3. 完成且带标记 → 退出 0
    const goodRun = runAccept(['--no-preflight', '--timeout', '8000', '--interval', '100', '--json'], env)
    const worked = await workOnce(env, { includeMarker: true })
    const good = await goodRun
    const goodJson = parseJson(good.stdout)
    check('工人带回了标记', worked !== null, JSON.stringify(worked))
    check(
      '完成且带回标记 → 退出 0',
      good.code === 0 && goodJson?.markerInResult === true && goodJson?.exitCode === 0,
      `exit=${good.code} markerInResult=${goodJson?.markerInResult}`,
    )

    // 4. 时限内没完成 → 退出 2，且明确不是成功
    const timeoutRun = await runAccept(['--no-preflight', '--timeout', '600', '--interval', '150', '--json'], env)
    const timeoutJson = parseJson(timeoutRun.stdout)
    check(
      '时限内没完成 → 退出 2 且标为 timeout',
      timeoutRun.code === 2 && timeoutJson?.verdict?.verdict === 'timeout',
      `exit=${timeoutRun.code} verdict=${timeoutJson?.verdict?.verdict}`,
    )
    check(
      '那份 JSON 里也说明了「不是成功」',
      String(timeoutJson?.summary ?? '').includes('不是成功'),
      String(timeoutJson?.summary ?? ''),
    )

    // 5. --help 与队列文件形态
    const help = await runAccept(['--help'], env)
    check('--help 退出 0 并打印用法', help.code === 0 && help.stdout.includes('usage: accept-doubao-work.mjs'), help.stdout.trim())
    const lines = readFileSync(queueFile, 'utf8').trim().split('\n').filter((line) => line.length > 0)
    check('队列仍是逐行 JSONL', lines.length > 0 && lines.every((line) => parseJson(line) !== null), `${lines.length} line(s)`)

    // 6. --preflight-only：只查就绪，连一条任务都不入队（检查本身无副作用）
    const cleanQueue = join(scratch, 'clean-tasks.jsonl')
    const preflightRefused = await runAccept(
      ['--preflight-only', '--url', 'http://127.0.0.1:9/mcp', '--home', join(scratch, 'no-home'), '--json'],
      { DSH_QUEUE_FILE: cleanQueue },
    )
    const preflightJson = parseJson(preflightRefused.stdout)
    check(
      '--preflight-only 未就绪时退出 3 且不入队',
      preflightRefused.code === 3 && !existsSync(cleanQueue) && preflightJson?.published === null,
      `exit=${preflightRefused.code} queue exists=${existsSync(cleanQueue)}`,
    )
    check(
      '--preflight-only 的结论里写明「未入队」',
      String(preflightJson?.summary ?? '').includes('未入队'),
      String(preflightJson?.summary ?? ''),
    )
  } catch (error) {
    check('accept-doubao-work selftest completed', false, String(error?.stack ?? error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
