#!/usr/bin/env node
/**
 * status-push 的密封测试：用假 dsh 验证真实推送路径（不花模型额度）。
 *
 * 覆盖：只推阶段转换（progress 不推）、游标幂等、新增事件会被推、
 * 缺会话时明确报错、--create-session 只建一次会话、push 关闭时拒绝。
 *
 * Usage: node status-push-selftest.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatPush, summarize } from './status-push.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUSH = join(HERE, 'status-push.mjs')
const STATUS = join(HERE, 'status.mjs')

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

function run(script, args, env) {
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
    child.stdout.on('data', (c) => {
      stdout += c
    })
    child.stderr.on('data', (c) => {
      stderr += c
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const readLog = async (file) => {
  try {
    return (await readFile(file, 'utf8')).split('\n---\n').filter((entry) => entry.trim().length > 0)
  } catch {
    return []
  }
}

async function main() {
  process.stdout.write(`status-push selftest (node ${process.version}, platform ${process.platform})\n`)
  const scratch = mkdtempSync(join(tmpdir(), 'push-selftest-'))

  try {
    // ---------------------------------------------------------------- 单元层
    check(
      'formatPush 把状态翻成一句人话',
      formatPush({ state: 'started', job: 'J1', message: '开始' }) === '[豆包状态] 工作开始 · job=J1 · 开始',
      formatPush({ state: 'started', job: 'J1', message: '开始' }),
    )
    check(
      'formatPush 带上百分比与步骤',
      formatPush({ state: 'progress', job: 'J1', percent: 30, step: '拉取' }).includes('30%') &&
        formatPush({ state: 'progress', job: 'J1', percent: 30, step: '拉取' }).includes('拉取'),
    )
    check(
      'summarize 能从 NDJSON 里取答复与会话 id',
      summarize('noise\n{"type":"final","text":"好"}\n{"sessionId":"S-9"}\n').answer === '好' &&
        summarize('{"sessionId":"S-9"}\n').sessionId === 'S-9',
    )

    // ---------------------------------------------------------------- 假 dsh
    if (process.platform !== 'win32') {
      process.stdout.write('SKIP  推送路径测试（需要 Windows .cmd 假 CLI）\n')
    } else {
      const fakeDir = join(scratch, 'fake')
      mkdirSync(fakeDir, { recursive: true })
      const fakeLog = join(fakeDir, 'received.log')
      writeFileSync(
        join(fakeDir, 'fake-dsh.mjs'),
        [
          "import { appendFileSync } from 'node:fs'",
          "let input = ''",
          "process.stdin.setEncoding('utf8')",
          "process.stdin.on('data', (c) => { input += c })",
          "process.stdin.on('end', () => {",
          '  appendFileSync(process.env.FAKE_DSH_LOG, input + "\\n---\\n")',
          "  process.stdout.write(JSON.stringify({ type: 'final', text: 'ack' }) + '\\n')",
          "  process.stdout.write(JSON.stringify({ sessionId: 'FAKE-SESSION' }) + '\\n')",
          '})',
          '',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(join(fakeDir, 'fake-dsh.cmd'), '@echo off\r\nnode "%~dp0fake-dsh.mjs"\r\n', 'utf8')

      const work = join(scratch, 'work')
      mkdirSync(work, { recursive: true })
      const statusFile = join(work, 'status.jsonl')
      const iniPath = join(work, 'doubao-status.ini')
      writeFileSync(
        iniPath,
        ['[status]', `file = ${statusFile}`, '', '[push]', 'enabled = true', 'targets = started,need_input,done,failed', 'session = SESSION-A'].join('\n'),
        'utf8',
      )
      const env = {
        DOUBAO_STATUS_INI: iniPath,
        DSH_QUEUE_FILE: join(work, 'tasks.jsonl'),
        FAKE_DSH_LOG: fakeLog,
      }
      const dshPath = join(fakeDir, 'fake-dsh.cmd')

      await run(STATUS, ['start', '--job', 'JOB-1', '--message', '开始'], env)
      await run(STATUS, ['progress', '--job', 'JOB-1', '--percent', '50'], env)
      await run(STATUS, ['done', '--job', 'JOB-1', '--message', '完成'], env)

      const first = await run(PUSH, ['--once', '--dsh', dshPath], env)
      const received = await readLog(fakeLog)
      check('推送成功退出 0', first.code === 0, `exit=${first.code} ${first.stderr.split('\n')[0]}`)
      check('只推阶段转换：started 与 done 各一条，progress 不推', received.length === 2, `收到 ${received.length} 条`)
      check('推送文本带 job 与状态', received[0].includes('JOB-1') && received[0].includes('工作开始'), received[0])
      check('进度不会出现在推送里', received.every((entry) => !entry.includes('进度')), received.join(' | '))

      const second = await run(PUSH, ['--once', '--dsh', dshPath], env)
      const afterSecond = await readLog(fakeLog)
      check('游标幂等：再跑一次不会重推', afterSecond.length === 2 && second.stdout.includes('pushed 0'), second.stdout.trim().split('\n').at(-1))

      await run(STATUS, ['failed', '--job', 'JOB-2', '--message', '炸了'], env)
      const third = await run(PUSH, ['--once', '--dsh', dshPath], env)
      const afterThird = await readLog(fakeLog)
      check('新增的事件会被推送', afterThird.length === 3 && afterThird[2].includes('工作失败'), `共 ${afterThird.length} 条`)
      check('推送输出里能看到这条', third.stdout.includes('工作失败'), third.stdout.split('\n').find((l) => l.startsWith('pushed')))

      // --create-session：没有会话时建立一次，并记住它
      const createdWork = join(scratch, 'created')
      mkdirSync(createdWork, { recursive: true })
      const createdIni = join(createdWork, 'doubao-status.ini')
      writeFileSync(
        createdIni,
        ['[status]', `file = ${join(createdWork, 'status.jsonl')}`, '', '[push]', 'enabled = true', 'targets = started,done', 'session ='].join('\n'),
        'utf8',
      )
      const createdEnv = {
        DOUBAO_STATUS_INI: createdIni,
        DSH_QUEUE_FILE: join(createdWork, 'tasks.jsonl'),
        FAKE_DSH_LOG: join(createdWork, 'received.log'),
      }
      await run(STATUS, ['start', '--job', 'JOB-C'], createdEnv)
      await run(STATUS, ['done', '--job', 'JOB-C'], createdEnv)

      const noSession = await run(PUSH, ['--once', '--dsh', dshPath], createdEnv)
      check('没有会话且没给 --create-session 时明确报错（不静默丢）', noSession.code === 1 && noSession.stderr.includes('没有配置目标会话'), noSession.stderr.split('\n')[0])

      const withCreate = await run(PUSH, ['--once', '--create-session', '--dsh', dshPath], createdEnv)
      check('--create-session 建立会话并打印 id', withCreate.code === 0 && withCreate.stdout.includes('FAKE-SESSION'), withCreate.stdout.split('\n').find((l) => l.includes('会话')) ?? '')
      const cursor = JSON.parse(readFileSync(join(createdWork, '.push-cursor.json'), 'utf8'))
      check('会话 id 记进游标文件（下次复用）', cursor.session === 'FAKE-SESSION', JSON.stringify(cursor))
      const createdLog = await readLog(join(createdWork, 'received.log'))
      check('两条阶段转换都被推了（且没有重复建会话）', createdLog.length === 2, `收到 ${createdLog.length} 条`)

      // push 关闭
      const offIni = join(scratch, 'off.ini')
      writeFileSync(offIni, ['[push]', 'enabled = false', 'session = X'].join('\n'), 'utf8')
      const off = await run(PUSH, ['--once', '--dsh', dshPath], { DOUBAO_STATUS_INI: offIni, DSH_QUEUE_FILE: join(scratch, 'off', 'tasks.jsonl') })
      check('push 关闭时拒绝并说明原因', off.code === 1 && off.stderr.includes('push 未启用'), off.stderr.split('\n')[0])

      check('假 CLI 的日志文件确实存在（证明走的是真实推送路径）', existsSync(fakeLog))

      // 真机上曾因「dsh 是 .cmd shim、不带 shell 去 spawn 就 ENOENT」失败；
      // 当时密封测试用的是绝对路径 .cmd，所以没暴露。这里用裸命令名 + PATH 复现那一次。
      const pathDir = join(scratch, 'path-case')
      mkdirSync(pathDir, { recursive: true })
      writeFileSync(
        join(pathDir, 'doubao-status.ini'),
        ['[status]', `file = ${join(pathDir, 'status.jsonl')}`, '', '[push]', 'enabled = true', 'targets = started', 'session = S-PATH'].join('\n'),
        'utf8',
      )
      const pathLog = join(pathDir, 'received.log')
      const pathEnv = {
        DOUBAO_STATUS_INI: join(pathDir, 'doubao-status.ini'),
        DSH_QUEUE_FILE: join(pathDir, 'tasks.jsonl'),
        FAKE_DSH_LOG: pathLog,
        PATH: `${fakeDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      }
      await run(STATUS, ['start', '--job', 'JOB-PATH'], pathEnv)
      const bare = await run(PUSH, ['--once', '--dsh', 'fake-dsh'], pathEnv)
      const bareLog = await readLog(pathLog)
      check(
        '裸命令名（PATH 里的 .cmd shim）也能推——真机曾经在这里失败过',
        bare.code === 0 && !bare.stdout.includes('ENOENT') && bareLog.length === 1,
        `exit=${bare.code} ${bare.stdout.split('\n').at(-1)}`,
      )
    }
  } catch (error) {
    check('status-push selftest 完整跑完', false, String(error))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
