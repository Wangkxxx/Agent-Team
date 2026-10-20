#!/usr/bin/env node
/**
 * 状态回报的密封测试（不需要豆包、不需要 CDP）。
 *
 * 覆盖需求 R1–R10 / R36–R41：词表与别名、ini 开关、静默 no-op、限流、
 * 截断、终态不可覆盖、半行容忍、时间线排序、忙闲判定与疑似卡死。
 *
 * Usage: node status-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foldByJob, openJobs, parseIni } from './status.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATUS = join(HERE, 'status.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [STATUS, ...args], {
      cwd: HERE,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const readEvents = async (file) => {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

async function main() {
  process.stdout.write(`status selftest (node ${process.version}, platform ${process.platform})\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'status-selftest-'))

  try {
    // ---------------------------------------------------------------- 单元层
    const ini = parseIni(
      ['; 注释', '# 也是注释', '[status]', 'file = ""', 'enabled = started,done', '', '[limits]', 'max_message_chars = 20'].join('\n'),
    )
    check('parseIni 认得出 section', ini.status !== undefined && ini.limits !== undefined)
    check('parseIni 去掉引号与空格', ini.status.file === '' && ini.status.enabled === 'started,done')
    check('parseIni 忽略注释行', Object.keys(ini).length === 2)

    const foldEvents = [
      { job: 'J', state: 'started', at: 300 },
      { job: 'J', state: 'progress', at: 100, percent: 10 },
      { job: 'J', state: 'done', at: 200 },
      { job: 'K', state: 'started', at: 400 },
      // received 是派发器写的发送侧事实：还没 started 也必须算「占着」。
      { job: 'L', state: 'received', at: 450 },
    ]
    const jobs = foldByJob(foldEvents)
    check('foldByJob 按 job 分组', jobs.size === 3)
    check('foldByJob 按时间排序（乱序到达也正确）', jobs.get('J').events.map((e) => e.at).join(',') === '100,200,300')
    check('foldByJob 终态不被后续覆盖', jobs.get('J').state === 'done' && jobs.get('J').terminal === true)
    check('foldByJob 未终结的 job 标记为非终态', jobs.get('K').terminal === false)

    const open = openJobs(jobs, { now: 400 })
    check(
      'openJobs 认「received 未终结」的 job（刚派发出去也算占着）',
      open.length === 2 && open.map((o) => o.job).sort().join(',') === 'K,L',
      JSON.stringify(open.map((o) => `${o.job}:${o.phase}`)),
    )
    check(
      'openJobs 用 phase 区分「已接收」与「已开工」',
      open.find((o) => o.job === 'K')?.phase === 'started' && open.find((o) => o.job === 'L')?.phase === 'received',
      JSON.stringify(open.map((o) => `${o.job}:${o.phase}`)),
    )
    const stale = openJobs(jobs, { now: 400 + 700_000, staleAfterMs: 600_000 })
    check(
      'openJobs 能标出疑似卡死（received 卡住同样算）',
      stale.length === 2 && stale.every((o) => o.stale === true),
      stale.map((o) => `${o.job}=${Math.round(o.idleMs / 1000)}s`).join(' '),
    )

    const receivedThenStarted = foldByJob([
      { job: 'R', state: 'received', at: 100 },
      { job: 'R', state: 'started', at: 200 },
    ]).get('R')
    check(
      'started 覆盖 received（received 不是终态）',
      receivedThenStarted.state === 'started' && receivedThenStarted.terminal === false,
      `state=${receivedThenStarted.state} terminal=${receivedThenStarted.terminal}`,
    )
    const receivedThenDone = foldByJob([
      { job: 'S', state: 'received', at: 100 },
      { job: 'S', state: 'done', at: 200 },
      { job: 'S', state: 'progress', at: 300 },
    ]).get('S')
    check(
      'received 起步的 job 到达终态后同样不可覆盖',
      receivedThenDone.state === 'done' && receivedThenDone.terminal === true,
      `state=${receivedThenDone.state}`,
    )

    // ---------------------------------------------------------------- CLI 层
    const queueFile = join(scratch, 'default', 'tasks.jsonl')
    const statusFile = join(scratch, 'default', 'status.jsonl')
    const base = { DSH_QUEUE_FILE: queueFile }

    const noIni = await run(['start', '--job', 'JOB-A'], base)
    check('没有 ini 时仍能记录（用默认值）', noIni.code === 0 && noIni.stdout.includes('started recorded'), noIni.stdout.trim())
    check('并且给出明确告警而不是静默', noIni.stderr.includes('未找到') && noIni.stderr.includes('内置默认值'), noIni.stderr.trim().split('\n')[0])

    await run(['progress', '--job', 'JOB-A', '--percent', '30', '--step', '拉取'], base)
    const throttled = await run(['progress', '--job', 'JOB-A', '--percent', '60'], base)
    check(
      'progress 在最小间隔内被静默丢弃（不改退出码、不报错）',
      throttled.code === 0 && throttled.stdout.trim() === '',
      `exit=${throttled.code} out=${JSON.stringify(throttled.stdout)}`,
    )
    await run(['done', '--job', 'JOB-A', '--message', '完成'], base)
    let events = await readEvents(statusFile)
    check('三次有效写入 = 3 条事件（限流那条没有落盘）', events.length === 3, events.map((e) => e.state).join(','))

    const afterTerminal = await run(['start', '--job', 'JOB-A'], base)
    events = await readEvents(statusFile)
    check(
      '终态之后拒绝新状态（幂等，不重复写）',
      afterTerminal.code === 0 && events.length === 3,
      `exit=${afterTerminal.code} n=${events.length}`,
    )

    const last = await run(['last', 'JOB-A'], base)
    check('last 报出终态', last.stdout.trim() === 'done', last.stdout.trim())
    const lastUnknown = await run(['last', 'NOPE'], base)
    check('last 对未知 job 用独立退出码 5', lastUnknown.code === 5 && lastUnknown.stdout.trim() === 'none')

    // 忙闲：另开一个只 started 的 job
    await run(['start', '--job', 'JOB-B'], base)
    const openCli = await run(['open'], base)
    check('open 报出未结束的 job 并用退出码 6', openCli.code === 6 && openCli.stdout.includes('JOB-B'), openCli.stdout.trim())
    const openJson = await run(['open', '--json'], base)
    check('open --json 可被程序消费', JSON.parse(openJson.stdout)[0].job === 'JOB-B')

    // received：派发器写的发送侧事实（CLI 层，落盘 + 忙闲）
    const receivedRun = await run(['received', '--job', 'JOB-R', '--message', '指令刚发出去'], base)
    const receivedEntry = foldByJob(await readEvents(statusFile)).get('JOB-R')
    check(
      'received 是合法状态且能落盘',
      receivedRun.code === 0 && receivedEntry?.state === 'received',
      `${receivedRun.stdout.trim()} state=${receivedEntry?.state}`,
    )
    const openAfterReceived = await run(['open', '--json'], base)
    const openAfterReceivedJobs = JSON.parse(openAfterReceived.stdout).map((o) => o.job)
    check(
      '「已接收」没等到 started 也算忙（否则这段空窗期无人看管）',
      openAfterReceivedJobs.includes('JOB-R'),
      JSON.stringify(openAfterReceivedJobs),
    )
    const listAfterReceived = await run(['list', '--job', 'JOB-R', '--json'], base)
    check(
      'list 能把 received 的时间线读出来',
      JSON.parse(listAfterReceived.stdout).jobs[0].events.some((e) => e.state === 'received'),
      listAfterReceived.stdout.trim().slice(0, 120),
    )
    await run(['start', '--job', 'JOB-R'], base)
    const startedOverReceived = foldByJob(await readEvents(statusFile)).get('JOB-R')
    check('started 覆盖 received（CLI 层）', startedOverReceived?.state === 'started', `state=${startedOverReceived?.state}`)

    // ---------------------------------------------------------------- ini 控制
    const controlled = join(scratch, 'controlled')
    mkdirSync(controlled, { recursive: true })
    const iniPath = join(controlled, 'doubao-status.ini')
    writeFileSync(
      iniPath,
      ['[status]', `file = ${join(controlled, 'status.jsonl')}`, 'enabled = started,done', '', '[limits]', 'max_message_chars = 12', 'progress_min_interval_ms = 1'].join('\n'),
      'utf8',
    )
    const controlledEnv = { DOUBAO_STATUS_INI: iniPath, DSH_QUEUE_FILE: join(controlled, 'tasks.jsonl') }
    const statusControlled = join(controlled, 'status.jsonl')

    const configOut = await run(['config', '--json'], controlledEnv)
    const parsedConfig = JSON.parse(configOut.stdout)
    check('ini 能改状态文件路径', parsedConfig.statusFile === statusControlled, parsedConfig.statusFile)
    check('ini 能改启用列表', parsedConfig.enabled.join(',') === 'started,done')
    check('ini 能改正文上限', parsedConfig.maxMessageChars === 12)

    const disabled = await run(['progress', '--job', 'JOB-C', '--percent', '10'], controlledEnv)
    const disabledEvents = await readEvents(statusControlled)
    check(
      '被 ini 关掉的状态：静默 no-op（无输出、无事件、退出 0）',
      disabled.code === 0 && disabled.stdout.trim() === '' && disabledEvents.length === 0,
      `exit=${disabled.code} out=${JSON.stringify(disabled.stdout)} n=${disabledEvents.length}`,
    )
    const enabledProbe = await run(['enabled', 'progress'], controlledEnv)
    check('enabled 子命令用退出码 4 表达「已禁用」', enabledProbe.code === 4, `exit=${enabledProbe.code}`)
    const enabledProbe2 = await run(['enabled', 'started'], controlledEnv)
    check('enabled 子命令对启用状态退 0', enabledProbe2.code === 0)

    const alias = await run(['start', '--job', 'JOB-C'], controlledEnv)
    check('别名 start → started 与规范名等价', alias.code === 0 && (await readEvents(statusControlled))[0].state === 'started')

    const longMessage = 'x'.repeat(50)
    await run(['done', '--job', 'JOB-C', '--message', longMessage], controlledEnv)
    const truncated = (await readEvents(statusControlled)).at(-1)
    check('超长正文按 ini 截断（不报错）', truncated.message.length === 12, `len=${truncated.message.length}`)

    // ---------------------------------------------------------------- 崩溃安全
    const tornFile = join(controlled, 'status.jsonl')
    await appendFile(tornFile, '{"v":1,"type":"status","job":"TORN","sta', 'utf8')
    await run(['start', '--job', 'JOB-D'], controlledEnv)
    const afterTorn = await readEvents(tornFile)
    check(
      '半行之后的写入仍然可读（补换行）',
      afterTorn.some((e) => e.job === 'JOB-D' && e.state === 'started'),
      afterTorn.map((e) => e.job).join(','),
    )
  } catch (error) {
    check('status selftest 完整跑完', false, String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
