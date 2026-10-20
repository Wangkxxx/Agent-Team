#!/usr/bin/env node
/**
 * Hermetic test for the Doubao startup confirmation (`doubao.mjs`, wired into
 * `cdp.mjs` and `dispatch.mjs`).
 *
 * All four states are reproducible without Doubao, because the confirmation
 * only speaks CDP-over-HTTP: a closed port, an open port answering /json/* with
 * no matching page, an open port with a matching page, and the escape hatch.
 *
 * Usage: node preflight-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPlaceholder, parseQuotaWindows } from './cdp.mjs'
import { parseContextPanel, parseContextUsage, resolveCdpTarget, splitModelText } from './doubao.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CDP = join(HERE, 'cdp.mjs')
const DISPATCH = join(HERE, 'dispatch.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

function runCli(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: HERE,
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

/** A port nobody is listening on: bind, note the number, release. */
function freePort() {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** A stand-in CDP endpoint describing the pages we want it to report. */
function fakeCdp(port, pages) {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/json/version')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ Browser: 'FakeCDP/1.0' }))
      return
    }
    if (request.url.startsWith('/json/list')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(pages))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{}')
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

const CHAT_PAGE = [{ type: 'page', title: '豆包', url: 'doubao://doubao-chat/chat?viewId=1', webSocketDebuggerUrl: 'ws://127.0.0.1/1' }]
// 假 CDP 的页面**必须**只用它自己的端口：原来那条 ws 地址没有端口(=80)……
// 本机 80 端口上有东西在听，于是「读不到模式」这条用例的结果会取决于别人答不答，表现为 flaky。
const pageFor = (port) => CHAT_PAGE.map((page) => ({ ...page, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }))
const LAUNCHER_ONLY = [{ type: 'page', title: '豆包', url: 'doubao://doubao-launcher/chat', webSocketDebuggerUrl: 'ws://127.0.0.1/2' }]

async function main() {
  process.stdout.write(`doubao-preflight selftest (node ${process.version}, platform ${process.platform})\n`)

  // 占位文本判定：真机漏过一次（`正在准备任务上下文`），所以改成「正在开头且很短」。
  check('a chat-mode placeholder is caught', isPlaceholder('正在思考'))
  check('a work-mode placeholder is caught (this one was missed live)', isPlaceholder('正在准备任务上下文'))
  check('a real short answer is not a placeholder', !isPlaceholder('2+2 等于 4。'))
  check(
    'a long reply that merely starts with 正在 is kept',
    !isPlaceholder('正在处理这个问题时，我发现需要先确认三件事：第一，……（下略很多字）'),
  )

  // 模型控件文字的拆分：真机读到的是 `豆包 2.1 Lite低`，末尾那个「低」是**档位**，
  // 不是模型名的一部分（它其实是同层一个 span）。粘在一起显示会让人以为模型叫那个名字。
  check(
    'splitModelText 把档位从模型名里剥掉（真机原文）',
    (() => {
      const { model, level } = splitModelText('豆包 2.1 Lite低', '低')
      return model === '豆包 2.1 Lite' && level === '低'
    })(),
    JSON.stringify(splitModelText('豆包 2.1 Lite低', '低')),
  )
  check(
    'splitModelText 档位为空时原样返回全文',
    splitModelText('豆包 2.1 Lite', '')?.model === '豆包 2.1 Lite',
  )
  check(
    'splitModelText 档位不是后缀时不误删（模型名里本来就带这个字）',
    splitModelText('豆包 Pro低配版', '低')?.model === '豆包 Pro低配版',
  )
  check('splitModelText 对空值不炸', splitModelText(undefined)?.model === '' && splitModelText(null, '低')?.model === '')

  // Synthetic quota-page text exercises parsing without retaining account data.
  const QUOTA_PAGE_TEXT = [
    '示例套餐',
    '订阅与额度管理',
    '免费体验',
    '升级至付费订阅',
    '享高峰期优先',
    '购买创作额度包',
    '当前时段',
    '已用 <1%',
    '约 3 小时后重置',
    '近 7 天',
    '已用 25%',
    '12月31日 23:59 重置',
    '额度重置',
    '3 次',
    '订阅记录',
  ].join('\n')
  const parsedWindows = parseQuotaWindows(QUOTA_PAGE_TEXT)
  check(
    'parseQuotaWindows 认出两个窗口（当前时段→5h、近 7 天→7d）',
    parsedWindows.windows.length === 2 &&
      parsedWindows.windows[0].short === '5h' &&
      parsedWindows.windows[0].label === '当前时段' &&
      parsedWindows.windows[1].short === '7d' &&
      parsedWindows.windows[1].label === '近 7 天',
    JSON.stringify(parsedWindows.windows.map((w) => `${w.short}:${w.usedText}`)),
  )
  check(
    '「已用 <1%」读成 0 + approximate（绝不读成 1%）',
    parsedWindows.windows[0].usedPercent === 0 &&
      parsedWindows.windows[0].approximate === true &&
      parsedWindows.windows[0].usedText === '<1%',
    JSON.stringify(parsedWindows.windows[0]),
  )
  check(
    '重置时间、可重置次数、套餐名都带出来',
    parsedWindows.windows[0].resetText === '约 3 小时后重置' &&
      parsedWindows.windows[1].resetText === '12月31日 23:59 重置' &&
      parsedWindows.resets === 3 &&
      parsedWindows.plan === '示例套餐',
    `${parsedWindows.windows[0].resetText} | ${parsedWindows.resets} | ${parsedWindows.plan}`,
  )
  check(
    '不是额度页的文本 → 0 个窗口（不瞎猜）',
    parseQuotaWindows('设置\n外观设置\n退出登录').windows.length === 0 &&
      parseQuotaWindows('').windows.length === 0 &&
      parseQuotaWindows(undefined).windows.length === 0,
  )

  const scratch = mkdtempSync(join(tmpdir(), 'preflight-selftest-'))

  try {
    // --- state 1: nothing listening -----------------------------------------
    const closed = await freePort()
    const down = await runCli(CDP, ['doctor'], { DOUBAO_CDP_PORT: String(closed) })
    check('a closed port makes doctor exit with the preflight code', down.code === 3, `exit=${down.code}`)
    check(
      'the report names the port it probed',
      down.stdout.includes(`127.0.0.1:${closed}`),
      down.stdout.split('\n')[1],
    )
    check(
      'the report explains how to restart Doubao with the debug flag',
      down.stdout.includes('--remote-debugging-port') && down.stdout.includes('退出豆包'),
    )
    check('the report warns about the widened trust boundary', down.stdout.includes('本机任意进程都能接管你的豆包'))

    check(
      'a normal command is gated too, not just doctor',
      (await runCli(CDP, ['targets'], { DOUBAO_CDP_PORT: String(closed) })).code === 3,
    )

    // state 是**诊断读数**，不是放行闸门：豆包没开时它正需要报告「未连接」，
    // 所以必须退出 0 且给出结构化结果，而不是像上面的命令那样退 3。
    {
      const state = await runCli(CDP, ['state', '--json'], { DOUBAO_CDP_PORT: String(closed) })
      let parsed
      try {
        parsed = JSON.parse(state.stdout)
      } catch {
        parsed = undefined
      }
      check('state 在豆包没开时也退出 0（它是读数，不是闸门）', state.code === 0, `exit=${state.code}`)
      check(
        'state 报 connected:false + 模式 unknown（不猜）',
        parsed?.connected === false && parsed?.mode === 'unknown' && typeof parsed?.error === 'string',
        state.stdout.trim().slice(0, 160),
      )
      const human = await runCli(CDP, ['state'], { DOUBAO_CDP_PORT: String(closed) })
      check(
        'state 的人类可读输出也说明未连接',
        human.code === 0 && human.stdout.includes('不通') && human.stdout.includes('模型'),
        human.stdout.trim().split('\n')[0],
      )
    }

    // mode 是**写操作**（点豆包的 UI），但它同样要能在豆包没开时说清楚，
    // 而不是空转或谎报成功。非法目标必须在连 CDP 之前就被挡住。
    {
      const badTarget = await runCli(CDP, ['mode', 'bogus'], { DOUBAO_CDP_PORT: String(closed) })
      check(
        'mode 只接受 work / chat（非法目标退 1 并给用法）',
        badTarget.code === 1 && badTarget.stderr.includes('usage: cdp.mjs mode <work|chat>'),
        `exit=${badTarget.code} err=${badTarget.stderr.trim().split('\n')[0]}`,
      )
      const downMode = await runCli(CDP, ['mode', 'work', '--json'], { DOUBAO_CDP_PORT: String(closed) })
      let parsedDown
      try {
        parsedDown = JSON.parse(downMode.stdout)
      } catch {
        parsedDown = undefined
      }
      check(
        '豆包没开时 mode 明确报失败并退 1（不声称成功）',
        downMode.code === 1 && parsedDown?.ok === false && typeof parsedDown?.error === 'string',
        downMode.stdout.trim().slice(0, 140),
      )
    }

    // quota / models 是「采样」：要点开菜单才读得到。豆包没开时必须明确报失败，
    // 绝不能返回一个编出来的 0% 或一份空清单冒充成功。
    for (const sample of ['quota', 'models']) {
      const down = await runCli(CDP, [sample, '--json'], { DOUBAO_CDP_PORT: String(closed) })
      let parsedSample
      try {
        parsedSample = JSON.parse(down.stdout)
      } catch {
        parsedSample = undefined
      }
      check(
        `豆包没开时 ${sample} 退 1 且 ok:false（不猜数字/不编号清单）`,
        down.code === 1 && parsedSample?.ok === false && typeof parsedSample?.error === 'string',
        `${sample}: exit=${down.code} ${down.stdout.trim().slice(0, 120)}`,
      )
    }
    const bypass = await runCli(CDP, ['targets', '--no-preflight'], { DOUBAO_CDP_PORT: String(closed) })
    check(
      '--no-preflight bypasses the gate and returns the raw failure',
      bypass.code === 1 && bypass.stderr.includes('fetch failed'),
      `exit=${bypass.code} ${bypass.stderr.trim()}`,
    )

    // --- state 2: port open, no matching page --------------------------------
    const noMatchPort = await freePort()
    const noMatchServer = await fakeCdp(noMatchPort, LAUNCHER_ONLY)
    try {
      const noMatch = await runCli(CDP, ['doctor'], { DOUBAO_CDP_PORT: String(noMatchPort) })
      check('an open port without a chat page is not "ready"', noMatch.code === 3, `exit=${noMatch.code}`)
      check('the report distinguishes this third state', noMatch.stdout.includes('端口是通的'), noMatch.stdout.split('\n').filter((l) => l.includes('✗'))[0])
    } finally {
      noMatchServer.close()
    }

    // --- state 3: port open with the expected page ---------------------------
    const readyPort = await freePort()
    const readyServer = await fakeCdp(readyPort, pageFor(readyPort))
    try {
      // The fake endpoint cannot serve a CDP websocket, so the DOM read fails
      // and the mode stays unknown: fail-closed must refuse (exit 8).
      const unknownMode = await runCli(CDP, ['doctor'], { DOUBAO_CDP_PORT: String(readyPort) })
      check('a reachable app whose mode cannot be read is "unknown", not ready', unknownMode.code === 8, `exit=${unknownMode.code}`)
      check('and it says it could not identify rather than "not ready"', unknownMode.stdout.includes('无法识别，拒绝发送'), unknownMode.stdout.split('\n').filter((l) => l.includes('?')).join(''))
      check('the page is still counted in the report', unknownMode.stdout.includes('1 个匹配'), unknownMode.stdout.split('\n').find((l) => l.includes('连通性')))
    check('isolation: the CLI talks to the fake port and never to a real app', unknownMode.stdout.includes(`端口 ${readyPort}`), unknownMode.stdout.split('\n')[0] ?? '')

      // Work mode: everything satisfied → send is allowed.
      const ready = await runCli(CDP, ['doctor', '--mode', 'work'], { DOUBAO_CDP_PORT: String(readyPort) })
      check('work mode with everything satisfied exits 0', ready.code === 0, `exit=${ready.code}`)
      check('and the report says it may send', ready.stdout.includes('✓ 可以发送'), ready.stdout.split('\n').filter((l) => l.includes('✓'))[0])
      check('every dimension is reported', ['连通性', '模式', '命令能力', '忙闲', '通道'].every((label) => ready.stdout.includes(label)))

      // Chat mode has no shell → status reporting is impossible → refuse.
      const chat = await runCli(CDP, ['doctor', '--mode', 'chat'], { DOUBAO_CDP_PORT: String(readyPort) })
      check('chat mode is refused because it has no shell', chat.code === 3 && chat.stdout.includes('没有 shell'), `exit=${chat.code}`)

      // --force proceeds and leaves an override record.
      const forceQueue = join(scratch, 'force')
      const forced = await runCli(CDP, ['targets', '--force'], {
        DOUBAO_CDP_PORT: String(readyPort),
        DSH_QUEUE_FILE: join(forceQueue, 'tasks.jsonl'),
      })
      check('--force proceeds past the gate', forced.code === 0 && forced.stdout.includes('page'), `exit=${forced.code}`)
      check('and it warns instead of silently ignoring the verdict', forced.stderr.includes('--force 跳过调用前识别'), forced.stderr.split('\n')[0])
      const overrideFile = join(forceQueue, 'status.jsonl')
      check(
        'a forced run leaves an override record',
        existsSync(overrideFile) && readFileSync(overrideFile, 'utf8').includes('"type":"override"'),
        overrideFile,
      )

      // A job that started and never finished makes the app "busy".
      const busyQueue = join(scratch, 'busy')
      mkdirSync(busyQueue, { recursive: true })
      writeFileSync(
        join(busyQueue, 'status.jsonl'),
        `${JSON.stringify({ v: 1, type: 'status', job: 'JOB-BUSY', state: 'started', at: Date.now() })}\n`,
        'utf8',
      )
      const busy = await runCli(CDP, ['doctor', '--mode', 'work'], {
        DOUBAO_CDP_PORT: String(readyPort),
        DSH_QUEUE_FILE: join(busyQueue, 'tasks.jsonl'),
      })
      check('an unfinished job makes the app busy and refuses', busy.code === 3 && busy.stdout.includes('JOB-BUSY'), `exit=${busy.code}`)
      check('the busy report names the job', busy.stdout.includes('有未结束的任务在跑'), busy.stdout.split('\n').find((l) => l.includes('忙闲')))
    } finally {
      readyServer.close()
    }

    // --- dispatcher integration ---------------------------------------------
    const queueFile = join(scratch, 'gated', 'tasks.jsonl')
    const gated = await runCli(DISPATCH, ['任务', '--queue'], {
      DOUBAO_CDP_PORT: String(closed),
      DSH_QUEUE_FILE: queueFile,
    })
    check('the dispatcher refuses to dispatch when Doubao is not ready', gated.code === 3, `exit=${gated.code}`)
    check(
      'and it confirms before writing anything: no task is left behind',
      !existsSync(queueFile),
      queueFile,
    )

    const hermetic = await runCli(DISPATCH, ['任务', '--queue', '--no-send', '--timeout', '1500'], {
      DOUBAO_CDP_PORT: String(closed),
      DSH_QUEUE_FILE: join(scratch, 'hermetic', 'tasks.jsonl'),
    })
    check(
      '--no-send still needs no Doubao at all',
      hermetic.code === 2 && hermetic.stdout.includes('UNVERIFIED'),
      `exit=${hermetic.code}`,
    )
  } catch (error) {
    check('the preflight selftest completed', false, String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  // ---------------------------------------------------------------- 目标解析（个人版 / 豆包工作）
  {
    const noEnv = {}
    const work = resolveCdpTarget({ target: 'work', env: noEnv })
    check(
      '目标 work = 豆包工作：9223 + doubaowork-chat/chat',
      work.port === 9223 && work.match === 'doubaowork-chat/chat' && work.name === 'work',
      JSON.stringify(work),
    )
    const personal = resolveCdpTarget({ target: 'personal', env: noEnv })
    check('目标 personal = 9222 + doubao-chat/chat', personal.port === 9222 && personal.match === 'doubao-chat/chat', JSON.stringify(personal))
    const fallback = resolveCdpTarget({ env: noEnv })
    check('不指定时默认个人版，并如实说明来源', fallback.port === 9222 && fallback.source.includes('默认'), JSON.stringify(fallback))

    // 优先级：--port/--match > --target > 环境变量 > 默认
    const targetBeatsEnv = resolveCdpTarget({ target: 'work', env: { CDP_PORT: '9222', CDP_MATCH: 'doubao-chat/chat' } })
    check('--target 压过环境变量（显式意图优先）', targetBeatsEnv.port === 9223 && targetBeatsEnv.match === 'doubaowork-chat/chat', JSON.stringify(targetBeatsEnv))
    const explicitBeatsTarget = resolveCdpTarget({ target: 'work', port: 9333, match: 'x', env: noEnv })
    check('--port/--match 压过 --target', explicitBeatsTarget.port === 9333 && explicitBeatsTarget.match === 'x', JSON.stringify(explicitBeatsTarget))
    const envOnly = resolveCdpTarget({ env: { CDP_PORT: '9223', CDP_MATCH: 'doubaowork-chat/chat' } })
    check('环境变量老用法仍被尊重（向后兼容）', envOnly.port === 9223 && envOnly.match === 'doubaowork-chat/chat' && envOnly.source.includes('CDP_PORT'), JSON.stringify(envOnly))
    const portOnly = resolveCdpTarget({ env: { CDP_PORT: '9555' } })
    check('只给 CDP_PORT 时匹配串用默认', portOnly.port === 9555 && portOnly.match === 'doubao-chat/chat', JSON.stringify(portOnly))

    let unknownRejected = null
    try {
      resolveCdpTarget({ target: 'nope', env: noEnv })
    } catch (error) {
      unknownRejected = String(error?.message ?? error)
    }
    check('未知目标明确报错并列出可用值', typeof unknownRejected === 'string' && unknownRejected.includes('nope') && unknownRejected.includes('personal') && unknownRejected.includes('work'), String(unknownRejected))
  }

  // --------------------------------------------------- 上下文用量（圆环角度 → 百分比）
  {
    const usageSample = parseContextUsage(JSON.stringify({ found: true, label: '上下文用量', angleDeg: 72 }))
    check(
      '上下文用量：合成角度正确换算为百分比（72° = 20%）',
      usageSample.found === true && usageSample.percent === 20 && usageSample.angleDeg === 72,
      JSON.stringify(usageSample),
    )
    check('上下文用量：360° = 100%、0° = 0%', parseContextUsage('{"found":true,"angleDeg":360}').percent === 100 && parseContextUsage('{"found":true,"angleDeg":0}').percent === 0)
    const missing = parseContextUsage(JSON.stringify({ found: false }))
    check('上下文用量：没有这个控件时 found:false 且 percent 为 null（不是 0%）', missing.found === false && missing.percent === null, JSON.stringify(missing))
    const noConversation = parseContextUsage('{"found":false,"messageCount":0}')
    const noControl = parseContextUsage('{"found":false,"messageCount":6}')
    check(
      '上下文用量：没打开对话 vs 这台 App 没控件，必须分得开',
      noConversation.reason === 'no-open-conversation' && noControl.reason === 'unsupported' && noConversation.contextOpen === false && noControl.contextOpen === true,
      JSON.stringify([noConversation, noControl]),
    )
    const broken = parseContextUsage('not json')
    check('上下文用量：读数坏掉时不猜（percent 为 null）', broken.found === false && broken.percent === null, JSON.stringify(broken))
    const outOfRange = parseContextUsage('{"found":true,"angleDeg":999}')
    check('上下文用量：角度越界按读不到处理', outOfRange.found === true && outOfRange.percent === null, JSON.stringify(outOfRange))
  }

  // ------------------------------------------- 上下文窗口面板（点开圆环后的那一坨文本）
  {
    // Synthetic panel text exercises parsing without retaining account usage.
    const sample = [
      '上下文用量',
      '12.5K/64.0K · 19.5%',
      '对话消息',
      '4.0%',
      '系统提示词',
      '3.0%',
      '工具及子智能体',
      '11.0%',
      '技能',
      '1.5%',
      '额度用量',
      '当前时段',
      '12:00 后重置 · 已用 12/500',
      '近 7 天',
      '已用 800/3,000',
    ].join('\n')
    const panel = parseContextPanel(sample)
    check(
      '上下文窗口：解析出上下文的绝对值与百分比（12.5K/64.0K · 19.5%）',
      panel.found === true && panel.context?.used === 12500 && panel.context?.total === 64000 && panel.context?.percent === 19.5,
      JSON.stringify(panel.context ?? null),
    )
    check(
      '上下文窗口：明细逐项解析，且不带那个纯标点的假条目',
      panel.breakdown.length === 4 &&
        panel.breakdown[0].label === '对话消息' &&
        panel.breakdown[0].percent === 4 &&
        panel.breakdown.some((item) => item.label === '工具及子智能体' && item.percent === 11),
      JSON.stringify(panel.breakdown),
    )
    check(
      '上下文窗口：解析合成额度数据（当前时段 12/500 + 重置文本，近 7 天 800/3000）',
      panel.quota.session?.used === 12 &&
        panel.quota.session?.limit === 500 &&
        panel.quota.session?.resetText === '12:00' &&
        panel.quota.week?.used === 800 &&
        panel.quota.week?.limit === 3000,
      JSON.stringify(panel.quota),
    )
    check('上下文窗口：空文本不猜（found:false）', parseContextPanel('')?.found === false)
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
