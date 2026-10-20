#!/usr/bin/env node
/**
 * Self-test for the dsh-mcp-connector demo. Read-only with respect to DSH:
 * it never touches `~/.dsh` and never restarts a running service.
 *
 * Steps:
 *  1. Hermetic profile boot: run `dsh --profile headless --help` with DSH_HOME
 *     pointed at a scratch directory inside this folder. Proves that the CLI
 *     accepts the headless profile and that first-run profile init works,
 *     without writing to the real DSH home.
 *  2. MCP protocol round trip: start `server.mjs` as a child and speak real
 *     newline-delimited JSON-RPC over stdio (initialize -> tools/list -> tools/call).
 *  3. `dsh_cli_info`: a tool call that really spawns the dsh CLI end to end.
 *  4. Optional live run: set DSH_MCP_CONNECTOR_LIVE=1 to also call `dsh_ask`
 *     with a trivial task. That performs a real model request and is billed to
 *     your DSH account, so it is off by default.
 *
 * Usage:  node selftest.mjs
 */

import { appendFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildResponse, decodeCliText, resolveStatusScript, runDsh, STATUS_STATES } from './server.mjs'
import { publishTask, claimTask, completeTask, listTasks, waitForCompletion } from './queue.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRATCH_HOME = join(HERE, '.selftest-home')
const SCRATCH_QUEUE = join(HERE, '.selftest-queue', 'tasks.jsonl')
const SERVER_PATH = join(HERE, 'server.mjs')
const QUEUE_ENV = { DSH_QUEUE_FILE: SCRATCH_QUEUE }

/**
 * Offline mode runs only the checks that do not need a DSH installation on this
 * machine: the MCP protocol surface, the HTTP transport and the task queue.
 * Steps that shell out to `dsh` are skipped, so CI (or any machine without a
 * harness) can still gate the protocol and queue behaviour.
 */
const OFFLINE = process.env.DSH_SELFTEST_OFFLINE === '1' || process.argv.includes('--offline')

let failures = 0
let skipped = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  process.stdout.write(`${mark}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

function skip(name, why) {
  skipped += 1
  process.stdout.write(`SKIP  ${name}\n      ${why}\n`)
}

/* ---------------------------------------------- step 1: hermetic profile boot */

async function stepProfileBoot() {
  process.stdout.write('\n[1] hermetically booting the headless profile (DSH_HOME is a scratch dir)\n')
  mkdirSync(SCRATCH_HOME, { recursive: true })
  try {
    const run = await runDsh(['--profile', 'headless', '--help'], {
      timeoutMs: 180_000,
      parseJsonLines: false,
      extraEnv: { DSH_HOME: SCRATCH_HOME },
    })
    const text = `${run.stdoutText}\n${run.stderr}`
    check('dsh --profile headless --help exits 0 with a fresh DSH_HOME', run.code === 0, `exit=${String(run.code)}`)
    check('profile help text mentions --session-id', text.includes('--session-id'), text.trim().split('\n').slice(0, 3).join(' | '))
  } catch (error) {
    check('dsh --profile headless --help exits 0 with a fresh DSH_HOME', false, String(error))
  } finally {
    rmSync(SCRATCH_HOME, { recursive: true, force: true })
  }
}

/* ------------------------------------------------- step 2: MCP child round trip */

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: HERE,
    env: { ...process.env, ...extraEnv },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  const stderrLines = []

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        const resolver = pending.get(message.id)
        if (resolver !== undefined) {
          pending.delete(message.id)
          resolver(message)
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderrLines.push(chunk))

  const request = (method, params, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }, timeoutMs)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  return { child, request, notify, stderrLines }
}

async function stepMcpRoundTrip() {
  process.stdout.write('\n[2] MCP stdio round trip against server.mjs\n')
  const server = startServer(QUEUE_ENV)
  try {
    const init = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      clientInfo: { name: 'selftest', version: '0.1.0' },
      capabilities: {},
    })
    const info = init.result
    check('initialize returns serverInfo', info?.serverInfo?.name === 'dsh-mcp-connector', JSON.stringify(info?.serverInfo))
    check('protocolVersion is echoed when supported', info?.protocolVersion === '2025-06-18', String(info?.protocolVersion))

    server.notify('notifications/initialized', {})

    const list = await server.request('tools/list', {})
    const names = (list.result?.tools ?? []).map((tool) => tool.name)
    check('tools/list exposes the connector tools', names.length === 10 && names.includes('dsh_wait') && names.includes('dsh_cancel') && names.includes('connector_status') && names.includes('status_report'), names.join(', '))
    const askTool = (list.result?.tools ?? []).find((tool) => tool.name === 'dsh_ask')
    check('dsh_ask declares a required task parameter', askTool?.inputSchema?.required?.includes('task') === true)

    if (OFFLINE) {
      skip('tools/call dsh_cli_info spawns the real CLI', 'offline mode: no dsh installation required')
    } else {
      const info2 = await server.request('tools/call', { name: 'dsh_cli_info', arguments: {} }, 90_000)
      const infoText = info2.result?.content?.[0]?.text ?? ''
      check('tools/call dsh_cli_info spawns the real CLI successfully', info2.result?.isError === false, infoText.split('\n').join(' | '))
    }

    const bad = await server.request('tools/call', { name: 'nope', arguments: {} })
    check('unknown tool is reported as a JSON-RPC error', bad.error?.code === -32602, JSON.stringify(bad.error))

    // connector_status must have recorded this client during the handshake.
    const status = await server.request('tools/call', { name: 'connector_status', arguments: {} })
    const statusText = status.result?.content?.[0]?.text ?? ''
    check(
      'connector_status reports the attached client',
      statusText.includes('selftest') && /clients seen: [1-9]/.test(statusText),
      statusText.split('\n').slice(-2).join(' | '),
    )

    // status_report — the parity channel: a client's work becomes visible on the
    // DSH Web badge because the event lands in the same file the badge reads.
    // Driven against a *fake* status.mjs so this asserts what we pass through,
    // not the real script's behaviour (that has its own selftest).
    const statusArgvFile = join(HERE, '.selftest-status-argv.json')
    const fakeStatus = join(HERE, '.selftest-status-fake.mjs')
    await writeFile(
      fakeStatus,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(statusArgvFile)}, JSON.stringify(process.argv.slice(2)))\n`,
      'utf8',
    )
    check(
      'resolveStatusScript treats an explicit override as authoritative',
      resolveStatusScript({ DOUBAO_STATUS_SCRIPT: join(HERE, 'no-such-status.mjs') }).script === null &&
        resolveStatusScript({ DOUBAO_STATUS_SCRIPT: fakeStatus }).script === fakeStatus,
      String(resolveStatusScript({ DOUBAO_STATUS_SCRIPT: fakeStatus }).script),
    )
    check(
      'STATUS_STATES keeps the dispatcher-only `received` out of the worker states',
      !STATUS_STATES.includes('received') && STATUS_STATES.includes('done') && STATUS_STATES.includes('progress'),
      STATUS_STATES.join(', '),
    )
    const statusServer = startServer({ ...QUEUE_ENV, DOUBAO_STATUS_SCRIPT: fakeStatus })
    try {
      await statusServer.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'selftest-status', version: '1' } })
      const reported = await statusServer.request('tools/call', {
        name: 'status_report',
        arguments: { state: 'progress', job: 'SELFTEST-STATUS-1', percent: 42, step: 'step one' },
      })
      check(
        'status_report relays a valid event to status.mjs',
        reported.result?.isError === false,
        (reported.result?.content?.[0]?.text ?? '').split('\n').join(' | '),
      )
      const recorded = JSON.parse(await readFile(statusArgvFile, 'utf8'))
      check(
        'status_report passes state/job/percent/step straight through',
        recorded[0] === 'progress' &&
          recorded[1] === '--job' &&
          recorded[2] === 'SELFTEST-STATUS-1' &&
          recorded.includes('--percent') &&
          recorded.includes('42') &&
          recorded.includes('--step') &&
          recorded.includes('step one'),
        JSON.stringify(recorded),
      )
      const dispatcherOnly = await statusServer.request('tools/call', {
        name: 'status_report',
        arguments: { state: 'received', job: 'SELFTEST-STATUS-1' },
      })
      check(
        'status_report refuses the dispatcher-only state `received`',
        dispatcherOnly.result?.isError === true &&
          (dispatcherOnly.result?.content?.[0]?.text ?? '').includes('state must be one of'),
        (dispatcherOnly.result?.content?.[0]?.text ?? '').split('\n').join(' | '),
      )
      const badJob = await statusServer.request('tools/call', {
        name: 'status_report',
        arguments: { state: 'done', job: 'bad job!' },
      })
      check(
        'status_report refuses a job id status.mjs would refuse',
        badJob.result?.isError === true && (badJob.result?.content?.[0]?.text ?? '').includes('job is required'),
        (badJob.result?.content?.[0]?.text ?? '').split('\n').join(' | '),
      )
    } finally {
      statusServer.child.kill()
      rmSync(fakeStatus, { force: true })
      rmSync(statusArgvFile, { force: true })
    }

    const missingServer = startServer({ ...QUEUE_ENV, DOUBAO_STATUS_SCRIPT: join(HERE, 'no-such-status.mjs') })
    try {
      await missingServer.request('initialize', {
        protocolVersion: '2025-11-25',
        clientInfo: { name: 'selftest-status-missing', version: '1' },
      })
      const missing = await missingServer.request('tools/call', {
        name: 'status_report',
        arguments: { state: 'done', job: 'SELFTEST-STATUS-2' },
      })
      const missingText = missing.result?.content?.[0]?.text ?? ''
      check(
        'status_report fails honestly when the script is missing (and names the path)',
        missing.result?.isError === true && missingText.includes('not found') && missingText.includes('no-such-status.mjs'),
        missingText.split('\n').join(' | '),
      )
    } finally {
      missingServer.child.kill()
    }

    // A script reached through a symlink/junction must be spawned by its REAL path.
    // status.mjs (like server.mjs) refuses to run when import.meta.url does not match
    // process.argv[1]; through a junction that mismatch makes it exit 0 with no output
    // and no event at all - a silent no-op a caller reading the exit code calls success.
    // The fake below reproduces that guard on purpose, so this test fails if the
    // resolution ever stops resolving. A directory junction is used because Windows
    // allows creating one without elevation, unlike a file symlink.
    const linkDir = join(HERE, '.selftest-link')
    mkdirSync(join(linkDir, 'real'), { recursive: true })
    const guarded = join(linkDir, 'real', 'guarded-status.mjs')
    const guardedMark = join(linkDir, 'ran.json')
    await writeFile(
      guarded,
      [
        `import { writeFileSync } from 'node:fs'`,
        `import { pathToFileURL } from 'node:url'`,
        `const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href`,
        `if (isMain) writeFileSync(${JSON.stringify(guardedMark)}, JSON.stringify(process.argv.slice(2)))`,
        '',
      ].join('\n'),
      'utf8',
    )
    const junctionPath = join(linkDir, 'junction', 'guarded-status.mjs')
    try {
      symlinkSync(join(linkDir, 'real'), join(linkDir, 'junction'), 'junction')
    } catch (error) {
      skip(
        'a junctioned status script is resolved to its real path',
        `cannot create a junction here: ${String(error?.message ?? error)}`,
      )
    }
    if (existsSync(junctionPath)) {
      check(
        'resolveStatusScript resolves a junctioned script to its real path',
        resolveStatusScript({ DOUBAO_STATUS_SCRIPT: junctionPath }).script === realpathSync(guarded),
        String(resolveStatusScript({ DOUBAO_STATUS_SCRIPT: junctionPath }).script),
      )
      const linkServer = startServer({ ...QUEUE_ENV, DOUBAO_STATUS_SCRIPT: junctionPath })
      try {
        await linkServer.request('initialize', {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'selftest-link', version: '1' },
        })
        const linked = await linkServer.request('tools/call', {
          name: 'status_report',
          arguments: { state: 'done', job: 'SELFTEST-LINK-1' },
        })
        check(
          'status_report through a junctioned script really runs it (no silent no-op)',
          linked.result?.isError === false && existsSync(guardedMark),
          (linked.result?.content?.[0]?.text ?? '').split('\n').join(' | '),
        )
      } finally {
        linkServer.child.kill()
      }
    }
    rmSync(linkDir, { recursive: true, force: true })

    // The full worker workflow through the tools alone: publish -> claim -> report
    // -> complete. This is the same job the Doubao desktop app does through CDP, so
    // "a client can work like the app" is exactly this sequence. Asserted on side
    // effects (queue events, what status.mjs was handed), never on reply prose.
    const flowDir = join(HERE, '.selftest-flow')
    const flowQueue = join(flowDir, 'tasks.jsonl')
    const flowArgvFile = join(flowDir, 'status-argv.jsonl')
    const flowStatus = join(flowDir, 'fake-status.mjs')
    const flowServer = startServer({ DSH_QUEUE_FILE: flowQueue, DOUBAO_STATUS_SCRIPT: flowStatus })
    try {
      mkdirSync(flowDir, { recursive: true })
      await writeFile(
        flowStatus,
        `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(flowArgvFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`,
        'utf8',
      )
      await flowServer.request('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'selftest-worker', version: '1' } })

      const publish = await flowServer.request('tools/call', {
        name: 'task_publish',
        arguments: { task: 'selftest worker workflow', source: 'selftest' },
      })
      check(
        'worker workflow: task_publish enqueues without error',
        publish.result?.isError === false,
        (publish.result?.content?.[0]?.text ?? '').split('\n')[0],
      )

      const claim = await flowServer.request('tools/call', { name: 'task_claim', arguments: { worker: 'selftest-worker' } })
      const claimText = claim.result?.content?.[0]?.text ?? ''
      check(
        'worker workflow: task_claim hands the task over',
        claim.result?.isError === false && claimText.includes('selftest worker workflow'),
        claimText.split('\n')[0],
      )

      const events = (await readFile(flowQueue, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const claimEvent = events.filter((event) => event.type === 'claim').pop()
      const jobId = typeof claimEvent?.id === 'string' ? claimEvent.id : ''
      check(
        'worker workflow: the claim is a real queue event, not just a reply',
        jobId.length > 0 && claimEvent.worker === 'selftest-worker',
        JSON.stringify(claimEvent ?? null),
      )

      for (const args of [
        { state: 'start', job: jobId },
        { state: 'progress', job: jobId, percent: 50 },
        { state: 'done', job: jobId, message: 'workflow done' },
      ]) {
        const reported = await flowServer.request('tools/call', { name: 'status_report', arguments: args })
        check(
          `worker workflow: status_report ${args.state} accepted for the claimed job`,
          reported.result?.isError === false,
          (reported.result?.content?.[0]?.text ?? '').split('\n')[0],
        )
      }
      const reportedArgv = (await readFile(flowArgvFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      check(
        'worker workflow: every report carried the claimed job id',
        reportedArgv.length === 3 && reportedArgv.every((argv) => argv[1] === '--job' && argv[2] === jobId),
        JSON.stringify(reportedArgv.map((argv) => argv.slice(0, 3))),
      )

      const complete = await flowServer.request('tools/call', {
        name: 'task_complete',
        arguments: { id: jobId, status: 'ok', result: 'workflow complete' },
      })
      check(
        'worker workflow: task_complete is accepted',
        complete.result?.isError === false,
        (complete.result?.content?.[0]?.text ?? '').split('\n')[0],
      )
      const listed = await flowServer.request('tools/call', { name: 'task_list', arguments: { state: 'done' } })
      check(
        'worker workflow: the queue shows that task as done afterwards',
        (listed.result?.content?.[0]?.text ?? '').includes(jobId),
        (listed.result?.content?.[0]?.text ?? '').split('\n').slice(0, 2).join(' | '),
      )

      // A client whose visible tool surface has no `task_claim` still has a real
      // path: list -> pick a pending id -> complete it. That is the surface
      // Doubao Work currently exposes, so the workaround is worth pinning.
      await flowServer.request('tools/call', {
        name: 'task_publish',
        arguments: { task: 'selftest direct-complete', source: 'selftest' },
      })
      const pendingList = await flowServer.request('tools/call', { name: 'task_list', arguments: { state: 'pending' } })
      const pendingText = pendingList.result?.content?.[0]?.text ?? ''
      const pendingId = (pendingText.match(/t-[a-z0-9]+-[a-z0-9]+/) ?? [])[0] ?? ''
      check(
        'worker workflow: task_list alone reveals a pending id to work on',
        pendingId.length > 0,
        pendingText.split('\n')[0],
      )
      const directComplete = await flowServer.request('tools/call', {
        name: 'task_complete',
        arguments: { id: pendingId, status: 'ok', result: 'done without claiming' },
      })
      check(
        'worker workflow: completing a never-claimed task works (no task_claim required)',
        directComplete.result?.isError === false,
        (directComplete.result?.content?.[0]?.text ?? '').split('\n')[0],
      )
      const foldedDirect = (await readFile(flowQueue, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((event) => event.id === pendingId)
      check(
        'worker workflow: that task folded to done with no claim event',
        foldedDirect.some((event) => event.type === 'complete' && event.status === 'ok') &&
          !foldedDirect.some((event) => event.type === 'claim'),
        JSON.stringify(foldedDirect.map((event) => event.type)),
      )
    } finally {
      flowServer.child.kill()
      rmSync(flowDir, { recursive: true, force: true })
    }

    // A pipelining client sends its next request without waiting for the
    // initialize response; the handshake gate must still order the bookkeeping.
    const pipelined = startServer(QUEUE_ENV)
    try {
      pipelined.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', clientInfo: { name: 'pipeliner', version: '0.0.1' } },
        })}\n`,
      )
      const pipelinedStatus = await pipelined.request('tools/call', { name: 'connector_status', arguments: {} })
      const pipelinedText = pipelinedStatus.result?.content?.[0]?.text ?? ''
      check(
        'a pipelined request still sees the handshake bookkeeping',
        pipelinedText.includes('pipeliner'),
        pipelinedText.split('\n').pop(),
      )
    } finally {
      pipelined.child.stdin.end()
      pipelined.child.kill()
      if (pipelined.child.exitCode === null) await once(pipelined.child, 'exit').catch(() => {})
    }

    if (process.env.DSH_MCP_CONNECTOR_LIVE === '1') {
      process.stdout.write('\n[3] LIVE run: one real dsh_ask call (billed to your DSH account)\n')
      const live = await server.request(
        'tools/call',
        { name: 'dsh_ask', arguments: { task: '请只回复四个字：连接器已就绪' } },
        900_000,
      )
      const text = live.result?.content?.[0]?.text ?? ''
      process.stdout.write(`${text}\n`)
      check('live dsh_ask returns a session id', /sessionId: \S/.test(text))
      check('live dsh_ask succeeded', live.result?.isError === false)
    } else {
      process.stdout.write('\n[3] skipped the live dsh_ask call (set DSH_MCP_CONNECTOR_LIVE=1 to include it)\n')
    }
  } catch (error) {
    check('MCP round trip completed', false, String(error))
  } finally {
    server.child.stdin.end()
    server.child.kill()
    // Let the child's handles close before this process exits; exiting while a
    // killed child is still tearing down trips a libuv assertion on Windows.
    if (server.child.exitCode === null) await once(server.child, 'exit').catch(() => {})
  }
}

/* ------------------------------------------------ step 4: HTTP transport */

async function stepHttpTransport() {
  process.stdout.write('\n[4] Streamable HTTP transport (for remote/cloud-hosted agents)\n')
  const port = 8791
  const token = 'selftest-token'
  const child = spawn(process.execPath, [SERVER_PATH, '--http', '--port', String(port), '--token', token], {
    cwd: HERE,
    env: { ...process.env, ...QUEUE_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.setEncoding('utf8')
  const ready = new Promise((resolve) => {
    child.stderr.on('data', (chunk) => {
      stderrText += chunk
      if (stderrText.includes('streamable HTTP MCP endpoint')) resolve(true)
    })
    setTimeout(() => resolve(false), 15_000)
  })

  try {
    const isReady = await ready
    check('HTTP server announces its endpoint on stderr', isReady, stderrText.trim().split('\n')[0] ?? '')
    if (!isReady) return

    const url = `http://127.0.0.1:${port}/mcp`
    const call = (body, headers = {}) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })

    const noAuth = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    check('missing bearer token is rejected with 401', noAuth.status === 401, `status=${noAuth.status}`)

    const unlistedOrigin = await call(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
    )
    check('unlisted Origin header is rejected with 403', unlistedOrigin.status === 403, `status=${unlistedOrigin.status}`)

    const initResponse = await call(
      { jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { authorization: `Bearer ${token}` },
    )
    const initJson = await initResponse.json()
    check(
      'initialize over HTTP returns serverInfo',
      initJson?.result?.serverInfo?.name === 'dsh-mcp-connector',
      JSON.stringify(initJson?.result?.serverInfo),
    )

    const listResponse = await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, { authorization: `Bearer ${token}` })
    const listJson = await listResponse.json()
    const names = (listJson?.result?.tools ?? []).map((tool) => tool.name)
    check('tools/list over HTTP exposes the connector tools', names.length === 10, names.join(', '))

    const notificationResponse = await call(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { authorization: `Bearer ${token}` },
    )
    check('notification-only POST answers 202', notificationResponse.status === 202, `status=${notificationResponse.status}`)

    // Batch array: the transport accepts it, so it must answer with an array.
    const batchResponse = await call(
      [
        { jsonrpc: '2.0', id: 10, method: 'ping' },
        { jsonrpc: '2.0', id: 11, method: 'tools/list' },
      ],
      { authorization: `Bearer ${token}` },
    )
    const batchJson = await batchResponse.json()
    check(
      'a batch array gets an array of responses',
      Array.isArray(batchJson) && batchJson.length === 2 && batchJson[0].id === 10 && batchJson[1].id === 11,
      JSON.stringify(Array.isArray(batchJson) ? batchJson.map((entry) => entry.id) : batchJson),
    )

    const getResponse = await fetch(url, { method: 'GET' })
    check('non-POST method is rejected with 405', getResponse.status === 405, `status=${getResponse.status}`)

    const wrongPath = await fetch(`http://127.0.0.1:${port}/nope`, { method: 'POST' })
    check('wrong path is rejected with 404', wrongPath.status === 404, `status=${wrongPath.status}`)

    // Producer route: enqueue without going through an MCP client.
    const produced = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ task: 'queued over HTTP', source: 'selftest-http' }),
    })
    const producedBody = await produced.json()
    check('HTTP producer route enqueues a task', produced.status === 201 && typeof producedBody.id === 'string', `status=${produced.status} id=${String(producedBody.id)}`)

    const producedAnon = await fetch(`http://127.0.0.1:${port}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'should be rejected' }),
    })
    check('HTTP producer route enforces the bearer token', producedAnon.status === 401, `status=${producedAnon.status}`)

    const queued = await listTasks({ state: 'pending' }, QUEUE_ENV)
    check(
      'the HTTP-enqueued task is actually claimable',
      queued.some((entry) => entry.task === 'queued over HTTP'),
      `${queued.length} pending`,
    )
  } catch (error) {
    check('HTTP transport checks completed', false, String(error))
  } finally {
    child.kill()
    if (child.exitCode === null) await once(child, 'exit').catch(() => {})
  }
}

/* -------------------------------------------------------- step 5: task queue */

async function stepQueue() {
  process.stdout.write('\n[5] task queue (pull-based dispatch)\n')
  rmSync(join(HERE, '.selftest-queue'), { recursive: true, force: true })

  try {
    const a = await publishTask({ task: 'task A' }, QUEUE_ENV)
    const b = await publishTask({ task: 'task B' }, QUEUE_ENV)
    check('publish returns distinct ids', a.id !== b.id, `${a.id} / ${b.id}`)

    const first = await claimTask({ worker: 'worker-1' }, QUEUE_ENV)
    check('claim hands out the oldest task first', first.claimed === true && first.id === a.id, JSON.stringify(first))

    const second = await claimTask({ worker: 'worker-2' }, QUEUE_ENV)
    check('a claimed task is never handed out twice', second.id === b.id, JSON.stringify(second))

    const empty = await claimTask({}, QUEUE_ENV)
    check('an exhausted queue reports nothing pending', empty.claimed === false, JSON.stringify(empty))

    const done = await completeTask({ id: a.id, status: 'ok', result: 'A finished' }, QUEUE_ENV)
    check('complete records a result', done.accepted === true && done.alreadyCompleted === false, JSON.stringify(done))

    const again = await completeTask({ id: a.id, status: 'ok', result: 'ignored' }, QUEUE_ENV)
    check('completing twice is a no-op (safe retries)', again.alreadyCompleted === true, JSON.stringify(again))

    let unknownRejected = false
    try {
      await completeTask({ id: 't-does-not-exist' }, QUEUE_ENV)
    } catch {
      unknownRejected = true
    }
    check('completing an unknown id is rejected', unknownRejected)

    const states = new Map((await listTasks({ state: 'all' }, QUEUE_ENV)).map((task) => [task.id, task.state]))
    check(
      'state fold separates done from claimed',
      states.get(a.id) === 'done' && states.get(b.id) === 'claimed',
      JSON.stringify([...states]),
    )

    // Concurrency: parallel claimants must never receive the same task.
    for (let index = 0; index < 6; index += 1) await publishTask({ task: `parallel ${index}` }, QUEUE_ENV)
    const raced = await Promise.all(Array.from({ length: 6 }, () => claimTask({ worker: 'race' }, QUEUE_ENV)))
    const taken = raced.filter((entry) => entry.claimed).map((entry) => entry.id)
    check('six concurrent claims take six distinct tasks', new Set(taken).size === 6, `took ${taken.length}: ${taken.join(', ')}`)

    // waitForCompletion is the pull-based counterpart of `dispatch --queue`: with no
    // app to poke, "hand out work and wait" is "publish, then wait for the queue to
    // record a completion" - and the verdict must come from the file, never from a
    // client claiming it finished.
    const waitQueue = join(HERE, '.selftest-wait', 'tasks.jsonl')
    const waitEnv = { ...process.env, DSH_QUEUE_FILE: waitQueue }
    rmSync(dirname(waitQueue), { recursive: true, force: true })
    const waitPublished = await publishTask({ task: 'selftest wait', source: 'selftest' }, waitEnv)
    const pendingVerdict = await waitForCompletion({ id: waitPublished.id, timeoutMs: 150, intervalMs: 20 }, waitEnv)
    check(
      'wait: an unfinished task times out instead of being called completed',
      pendingVerdict.verdict === 'timeout' && pendingVerdict.state === 'pending',
      JSON.stringify(pendingVerdict),
    )
    const unknownVerdict = await waitForCompletion({ id: 't-nope-000000', timeoutMs: 80, intervalMs: 20 }, waitEnv)
    check('wait: an id that was never published is unknown', unknownVerdict.verdict === 'unknown', JSON.stringify(unknownVerdict))
    setTimeout(() => {
      completeTask({ id: waitPublished.id, status: 'ok', result: 'finished late' }, waitEnv).catch(() => {})
    }, 80)
    const completedVerdict = await waitForCompletion({ id: waitPublished.id, timeoutMs: 4_000, intervalMs: 20 }, waitEnv)
    check(
      'wait: a completion that arrives later is picked up, with the recorded result',
      completedVerdict.verdict === 'completed' && completedVerdict.status === 'ok' && completedVerdict.result === 'finished late',
      JSON.stringify(completedVerdict),
    )

    // The documented exit codes of the CLI are part of the contract.
    const runQueue = (argv, env) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [join(HERE, 'queue.mjs'), ...argv], {
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.on('close', (code) => resolve({ code, stdout }))
      })
    const waitUnknown = await runQueue(['wait', 't-nope-999999', '--timeout', '100', '--interval', '20'], { DSH_QUEUE_FILE: waitQueue })
    check('queue.mjs wait: unknown id exits 5', waitUnknown.code === 5, `exit=${waitUnknown.code} ${waitUnknown.stdout.trim()}`)
    const stillPending = await publishTask({ task: 'selftest wait cli', source: 'selftest' }, waitEnv)
    const waitTimedOut = await runQueue(['wait', stillPending.id, '--timeout', '120', '--interval', '20'], { DSH_QUEUE_FILE: waitQueue })
    check('queue.mjs wait: a timeout exits 2 (unsettled, not success)', waitTimedOut.code === 2, `exit=${waitTimedOut.code} ${waitTimedOut.stdout.trim()}`)
    rmSync(dirname(waitQueue), { recursive: true, force: true })

    // The MCP surface must reach the same queue.
    const server = startServer(QUEUE_ENV)
    try {
      await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
      server.notify('notifications/initialized', {})

      const published = await server.request('tools/call', {
        name: 'task_publish',
        arguments: { task: 'queued from an MCP client', source: 'selftest' },
      })
      const publishedText = published.result?.content?.[0]?.text ?? ''
      check(
        'task_publish works over MCP',
        published.result?.isError === false && publishedText.includes('published'),
        publishedText.split('\n')[0],
      )

      const claimed = await server.request('tools/call', { name: 'task_claim', arguments: { worker: 'mcp' } })
      const claimedText = claimed.result?.content?.[0]?.text ?? ''
      check(
        'task_claim hands the MCP client the queued task',
        claimed.result?.isError === false && claimedText.includes('queued from an MCP client'),
        claimedText.split('\n')[0],
      )

      const drained = await server.request('tools/call', { name: 'task_claim', arguments: {} })
      check(
        'a drained queue answers "no pending task"',
        (drained.result?.content?.[0]?.text ?? '').includes('no pending task'),
        (drained.result?.content?.[0]?.text ?? '').split('\n')[0],
      )

      const completed = await server.request('tools/call', {
        name: 'task_complete',
        arguments: { id: claimedText.match(/task id: (\S+)/)?.[1], status: 'ok', result: 'done by the MCP client' },
      })
      check('task_complete works over MCP', completed.result?.isError === false, completed.result?.content?.[0]?.text ?? '')
    } finally {
      server.child.stdin.end()
      server.child.kill()
      if (server.child.exitCode === null) await once(server.child, 'exit').catch(() => {})
    }
  } catch (error) {
    check('task queue checks completed', false, String(error))
  } finally {
    rmSync(join(HERE, '.selftest-queue'), { recursive: true, force: true })
  }
}

/* ----------------------------------- step 6: branches nobody had executed */

async function stepEdgeCases() {
  process.stdout.write('\n[6] previously unexecuted branches: allowed origin, custom paths, queue edges\n')

  const port = 8792
  const token = 'edge-token'
  const child = spawn(
    process.execPath,
    [
      SERVER_PATH,
      '--http',
      '--port',
      String(port),
      '--token',
      token,
      '--allow-origin',
      'https://ok.example',
      '--tasks-path',
      '/enqueue',
    ],
    { cwd: HERE, env: { ...process.env, ...QUEUE_ENV }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderrText = ''
  child.stderr.setEncoding('utf8')
  const ready = new Promise((resolve) => {
    child.stderr.on('data', (chunk) => {
      stderrText += chunk
      if (stderrText.includes('streamable HTTP MCP endpoint')) resolve(true)
    })
    setTimeout(() => resolve(false), 15_000)
  })

  try {
    if (!(await ready)) {
      check('the edge-case server starts', false, stderrText.trim().split('\n')[0] ?? '')
    } else {
      const base = `http://127.0.0.1:${port}`
      const allowed = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin: 'https://ok.example' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
      check('an explicitly allowed Origin is accepted', allowed.status === 200, `status=${allowed.status}`)

      const custom = await fetch(`${base}/enqueue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ task: 'enqueued through --tasks-path' }),
      })
      check('--tasks-path moves the producer route', custom.status === 201, `status=${custom.status}`)

      const oldPath = await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ task: 'should be 404 now' }),
      })
      check('the default producer path is gone once overridden', oldPath.status === 404, `status=${oldPath.status}`)

      const malformed = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{ not json',
      })
      const malformedBody = await malformed.json()
      check(
        'a malformed body is a 400 parse error, not a crash',
        malformed.status === 400 && malformedBody.error?.code === -32700,
        `status=${malformed.status} code=${malformedBody.error?.code}`,
      )
    }
  } catch (error) {
    check('the edge-case HTTP checks completed', false, String(error))
  } finally {
    child.kill()
    if (child.exitCode === null) await once(child, 'exit').catch(() => {})
  }

  try {
    // limit: newest N
    await publishTask({ task: 'limit 1' }, QUEUE_ENV)
    await publishTask({ task: 'limit 2' }, QUEUE_ENV)
    const third = await publishTask({ task: 'limit 3' }, QUEUE_ENV)
    const limited = await listTasks({ limit: 2 }, QUEUE_ENV)
    check(
      'limit returns the newest N tasks',
      limited.length === 2 && limited[1].id === third.id,
      `${limited.length}: ${limited.map((task) => task.task).join(' | ')}`,
    )

    // oversized result is capped before it reaches the log
    await completeTask({ id: third.id, status: 'ok', result: 'x'.repeat(300_000) }, QUEUE_ENV)
    const stored = (await listTasks({ state: 'all' }, QUEUE_ENV)).find((task) => task.id === third.id)
    check('an oversized result is truncated before it is stored', (stored?.result ?? '').length === 200_000, `${stored?.result?.length ?? 0} chars`)

    // A crash can leave a torn final line without its newline. The next event
    // must still be readable, which only holds if the writer repairs the break.
    const queueFile = QUEUE_ENV.DSH_QUEUE_FILE
    const before = (await listTasks({ state: 'all' }, QUEUE_ENV)).length
    await appendFile(queueFile, '{"v":1,"type":"publish","id":"t-torn","ta', 'utf8')

    const afterTorn = await listTasks({ state: 'all' }, QUEUE_ENV)
    check('a torn final line is ignored, not fatal', afterTorn.length === before, `${before} -> ${afterTorn.length}`)

    const published = await publishTask({ task: 'written after a torn line' }, QUEUE_ENV)
    const visible = (await listTasks({ state: 'all' }, QUEUE_ENV)).find((task) => task.id === published.id)
    check('an event written after a torn line is still readable', visible !== undefined, published.id)

    const claimed = await claimTask({}, QUEUE_ENV)
    check('and it can still be claimed', claimed.claimed === true, JSON.stringify(claimed).slice(0, 80))
  } catch (error) {
    check('the queue edge checks completed', false, String(error))
  }
}

/* ------------------ step 7: lock recovery, a missing CLI, and a timeout */

async function stepFailureBranches() {
  process.stdout.write('\n[7] failure branches: lock recovery, missing CLI, timeout\n')
  const lockDir = `${QUEUE_ENV.DSH_QUEUE_FILE}.lock`

  // A lock left behind by a killed process must not wedge the queue forever.
  try {
    await mkdir(dirname(lockDir), { recursive: true })
    await rm(lockDir, { recursive: true, force: true })
    await mkdir(lockDir)
    const longAgo = new Date(Date.now() - 60_000)
    await utimes(lockDir, longAgo, longAgo)
    const published = await publishTask({ task: 'written past a stale lock' }, QUEUE_ENV)
    check('a lock older than the staleness window is stolen', typeof published.id === 'string', published.id)
  } catch (error) {
    check('a lock older than the staleness window is stolen', false, String(error))
  }
  check('and it is released afterwards', !existsSync(lockDir), lockDir)

  // A fresh lock must make the writer wait, not fail and not corrupt the log.
  try {
    await mkdir(lockDir)
    const heldFrom = Date.now()
    const waiting = publishTask({ task: 'waited for the lock' }, QUEUE_ENV)
    await sleep(350)
    const waitedMs = Date.now() - heldFrom
    await rm(lockDir, { recursive: true, force: true })
    const result = await waiting
    check('a writer waits for a fresh lock instead of failing', result.id !== undefined && waitedMs >= 300, `waited ${waitedMs} ms`)
    check('the lock is released once the writer is done', !existsSync(lockDir))
  } catch (error) {
    check('a writer waits for a fresh lock instead of failing', false, String(error))
  }

  // A CLI that is not there must be a clean tool error, fast. Windows routes
  // this through the shell, so it arrives as a non-zero exit with stderr rather
  // than as a spawn error; both shapes must be reported as an error.
  const savedBin = process.env.DSH_BIN
  process.env.DSH_BIN = join(HERE, 'definitely-not-here', 'dsh')
  try {
    const startedAt = Date.now()
    const missing = await buildResponse({
      jsonrpc: '2.0',
      id: 900,
      method: 'tools/call',
      params: { name: 'dsh_ask', arguments: { task: 'hello' } },
    })
    const text = missing?.result?.content?.[0]?.text ?? ''
    const elapsed = Date.now() - startedAt
    check(
      'a missing dsh binary is reported as a tool error',
      missing?.result?.isError === true && (/cannot run the dsh CLI/.test(text) || /exit code: 1/.test(text)),
      text.split('\n').filter((line) => line.length > 0).slice(-1)[0],
    )
    check('the underlying failure detail is surfaced', /stderr:/.test(text), text.split('\n').slice(-1)[0].slice(0, 60))
    check('and it fails fast instead of hanging', elapsed < 15_000, `${elapsed} ms`)
  } catch (error) {
    check('a missing dsh binary is reported as a tool error', false, String(error))
  }

  // Windows shells answer in the console code page, not UTF-8. Decoding those
  // bytes as UTF-8 is what turned a clear message into mojibake.
  const gbkBytes = Buffer.from([
    0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6, 0xa1, 0xa3,
  ])
  const decodedGbk = decodeCliText(gbkBytes)
  check('GBK shell output is decoded instead of mojibake', decodedGbk === '系统找不到指定的路径。', decodedGbk)
  check('valid UTF-8 passes through unchanged', decodeCliText(Buffer.from('DSH 就绪', 'utf8')) === 'DSH 就绪')
  check('undecodable bytes still return text instead of throwing', decodeCliText(Buffer.from([0xff, 0xfe, 0x00, 0x81])).length > 0)

  // A CLI that never returns must be killed at the caller's timeout.
  if (process.platform === 'win32') {
    const sleeper = join(HERE, '.selftest-sleeper.cmd')
    try {
      await writeFile(sleeper, '@echo off\r\nping -n 30 127.0.0.1 >nul\r\n', 'utf8')
      process.env.DSH_BIN = sleeper
      const startedAt = Date.now()
      const timedOut = await buildResponse({
        jsonrpc: '2.0',
        id: 901,
        method: 'tools/call',
        params: { name: 'dsh_ask', arguments: { task: 'sleep', timeoutMs: 1500 } },
      })
      const text = timedOut?.result?.content?.[0]?.text ?? ''
      const elapsed = Date.now() - startedAt
      check('a call that overruns its timeout is killed and reported', /did not finish within/.test(text), text.split('\n')[0])
      check('the timeout is honoured, not the process lifetime', elapsed < 20_000, `${elapsed} ms`)
    } catch (error) {
      check('a call that overruns its timeout is killed and reported', false, String(error))
    } finally {
      await rm(sleeper, { force: true })
    }
  } else {
    skip('a call that overruns its timeout is killed', 'needs a Windows .cmd shim to stand in for the CLI')
  }

  if (savedBin === undefined) delete process.env.DSH_BIN
  else process.env.DSH_BIN = savedBin
}

/* -------------------- step 8: input validation and runaway-output limits */

async function stepInputLimits() {
  process.stdout.write('\n[8] input validation and runaway output\n')

  // Validation happens before anything is spawned, so these are platform-neutral.
  const emptyTask = await buildResponse({
    jsonrpc: '2.0',
    id: 910,
    method: 'tools/call',
    params: { name: 'dsh_ask', arguments: { task: '   ' } },
  })
  const emptyText = emptyTask?.result?.content?.[0]?.text ?? ''
  check(
    'an empty task is rejected before spawning anything',
    emptyTask?.result?.isError === true && /non-empty string/.test(emptyText),
    emptyText.split('\n')[0],
  )

  const badSession = await buildResponse({
    jsonrpc: '2.0',
    id: 911,
    method: 'tools/call',
    params: { name: 'dsh_ask', arguments: { task: 'hello', sessionId: 'not a valid id!' } },
  })
  const badSessionText = badSession?.result?.content?.[0]?.text ?? ''
  check(
    'a malformed sessionId is rejected before spawning anything',
    badSession?.result?.isError === true && /unexpected shape/.test(badSessionText),
    badSessionText.split('\n')[0],
  )

  if (process.platform !== 'win32') {
    skip('runaway stdout is aborted', 'needs a Windows .cmd shim to stand in for the CLI')
    skip('unparseable output lines are tolerated', 'needs a Windows .cmd shim to stand in for the CLI')
    return
  }

  const fakeScript = join(HERE, '.selftest-fake.mjs')
  const fakeShim = join(HERE, '.selftest-fake.cmd')
  await writeFile(
    fakeScript,
    [
      "const mode = process.env.SELFTEST_FAKE_MODE ?? 'noise'",
      "if (mode === 'flood') {",
      "  const chunk = 'x'.repeat(1024 * 1024)",
      '  for (let index = 0; index < 40; index += 1) {',
      '    if (!process.stdout.write(chunk)) {',
      "      await new Promise((resolve) => process.stdout.once('drain', resolve))",
      '    }',
      '  }',
      '} else {',
      "  process.stdout.write('this line is not json\\n')",
      "  process.stdout.write('{\"half\":\\n')",
      "  process.stdout.write(JSON.stringify({ type: 'final', text: 'recovered from noisy output' }) + '\\n')",
      '}',
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(fakeShim, '@echo off\r\nnode "%~dp0.selftest-fake.mjs"\r\n', 'utf8')

  const savedBin = process.env.DSH_BIN
  const savedMode = process.env.SELFTEST_FAKE_MODE
  process.env.DSH_BIN = fakeShim
  try {
    process.env.SELFTEST_FAKE_MODE = 'flood'
    const floodStarted = Date.now()
    const flood = await buildResponse({
      jsonrpc: '2.0',
      id: 912,
      method: 'tools/call',
      params: { name: 'dsh_ask', arguments: { task: 'flood', timeoutMs: 60_000 } },
    })
    const floodText = flood?.result?.content?.[0]?.text ?? ''
    check(
      'runaway stdout is aborted instead of buffered forever',
      flood?.result?.isError === true && /more than \d+ bytes on stdout/.test(floodText),
      floodText.split('\n')[0],
    )
    check('the abort happens promptly', Date.now() - floodStarted < 60_000, `${Date.now() - floodStarted} ms`)

    process.env.SELFTEST_FAKE_MODE = 'noise'
    const noise = await buildResponse({
      jsonrpc: '2.0',
      id: 913,
      method: 'tools/call',
      params: { name: 'dsh_ask', arguments: { task: 'noise', timeoutMs: 30_000 } },
    })
    const noiseText = noise?.result?.content?.[0]?.text ?? ''
    check(
      'unparseable output lines are tolerated, not fatal',
      noise?.result?.isError === false && noiseText.includes('recovered from noisy output'),
      noiseText.split('\n')[0],
    )
  } catch (error) {
    check('runaway stdout is aborted instead of buffered forever', false, String(error))
  } finally {
    if (savedBin === undefined) delete process.env.DSH_BIN
    else process.env.DSH_BIN = savedBin
    if (savedMode === undefined) delete process.env.SELFTEST_FAKE_MODE
    else process.env.SELFTEST_FAKE_MODE = savedMode
    await rm(fakeScript, { force: true })
    await rm(fakeShim, { force: true })
  }
}

async function main() {
  process.stdout.write(
    `dsh-mcp-connector selftest (node ${process.version}, platform ${process.platform}${OFFLINE ? ', offline mode' : ''})\n`,
  )
  try {
    if (OFFLINE) {
      skip('hermetically booting the headless profile', 'offline mode: needs a local dsh installation')
    } else {
      await stepProfileBoot()
    }
    await stepMcpRoundTrip()
    await stepHttpTransport()
    await stepQueue()
    await stepEdgeCases()
    await stepFailureBranches()
    await stepInputLimits()
  } finally {
    // Every step shares one scratch directory; leaving the working tree exactly
    // as it was found is a property of the whole run, so it is enforced once
    // here rather than inside each step that happens to write.
    rmSync(join(HERE, '.selftest-queue'), { recursive: true, force: true })
    rmSync(join(HERE, '.selftest-sleeper.cmd'), { force: true })
    rmSync(join(HERE, '.selftest-fake.cmd'), { force: true })
    rmSync(join(HERE, '.selftest-fake.mjs'), { force: true })
  }
  const summary = skipped > 0 ? `ALL CHECKS PASSED (${skipped} skipped)` : 'ALL CHECKS PASSED'
  process.stdout.write(`\n${failures === 0 ? summary : `${failures} CHECK(S) FAILED`}\n`)
  // Set the code and let the event loop drain instead of calling process.exit(),
  // which can abort inside libuv while child handles are still closing.
  process.exitCode = failures === 0 ? 0 : 1
}

main()
