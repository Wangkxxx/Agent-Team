#!/usr/bin/env node
/**
 * doubao-work-debug.mjs — 让豆包工作「带调试端口」跑起来的入口。
 *
 * 为什么需要它：豆包工作（Chromium 147）认 `--remote-debugging-port`，**但只在启动时决定**——
 * 你平常双击启动它，端口就是关的，徽章上「豆包工作 · 模式 · 模型」那一行会消失
 * （那不是故障，是读不到）。这个脚本把这件事变成一条命令。
 *
 * 用法：
 *   node scripts/doubao-work-debug.mjs --status     # 只读：它在跑吗？9223 通吗？（默认动作）
 *   node scripts/doubao-work-debug.mjs --launch     # 没在跑才启动（带端口）
 *   node scripts/doubao-work-debug.mjs --restart    # 关掉再带端口启动（**会打断它正在做的事**）
 *
 * 两条纪律：
 *   1. **不偷偷杀进程**：只有你显式 `--restart` 才关它，而且会先告诉你它当时在跑几个进程。
 *   2. 用 WMI 拉起（`Win32_Process.Create`），让它**不在 DSH 进程树里**——
 *      DSH 重启不会带走它；而且你正常重启它时端口自然关闭，等于一个「关掉调试」的开关。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const EXE = process.env.DOUBAOWORK_EXE ?? 'E:\\DoubaoWork\\app\\DoubaoWork.exe'
const PORT = Number(process.env.DOUBAOWORK_CDP_PORT ?? 9223)
const USAGE = 'usage: doubao-work-debug.mjs [--status|--launch|--restart] [--port <n>]'

function ps(command) {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 60_000 })
  return { ok: run.status === 0, out: (run.stdout ?? '').trim(), err: (run.stderr ?? '').trim() }
}

/** 应用在跑吗：返回进程数与主进程 PID。 */
export function inspectProcesses() {
  const run = ps("@(Get-Process DoubaoWork -ErrorAction SilentlyContinue) | Sort-Object StartTime | Select-Object -First 1 -ExpandProperty Id")
  const mainPid = Number.parseInt(run.out.split(/\r?\n/)[0] ?? '', 10)
  const countRun = ps("@(Get-Process DoubaoWork -ErrorAction SilentlyContinue).Count")
  const count = Number.parseInt(countRun.out.split(/\r?\n/).pop() ?? '0', 10) || 0
  return { count, mainPid: Number.isFinite(mainPid) ? mainPid : null }
}

/** 调试端口通不通（CDP 的 /json/version）。 */
export function probeDebugPort(port = PORT) {
  const run = ps(`try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:${port}/json/version").Content } catch { '' }`)
  return { open: run.out.includes('webSocketDebuggerUrl'), raw: run.out }
}

function launch() {
  const cmd = `"${EXE}" --registry-web-browser --remote-debugging-port=${PORT} --remote-allow-origins=*`
  const run = ps(`(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd.replace(/'/g, "''")}' }).ProcessId`)
  const pid = Number.parseInt(run.out.split(/\r?\n/).pop() ?? '', 10)
  return Number.isFinite(pid) ? pid : null
}

function stopAll() {
  ps('Get-Process DoubaoWork -ErrorAction SilentlyContinue | Stop-Process -Force')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  const portIndex = argv.indexOf('--port')
  const port = portIndex === -1 ? PORT : Number(argv[portIndex + 1])
  const mode = argv.includes('--restart') ? 'restart' : argv.includes('--launch') ? 'launch' : 'status'

  const before = inspectProcesses()
  const probe = probeDebugPort(port)
  process.stdout.write(`豆包工作：${before.count === 0 ? '没在跑' : `在跑（${before.count} 个进程，主进程 ${before.mainPid}）`}\n`)
  process.stdout.write(`调试端口 ${port}：${probe.open ? '通（可被读/驱动）' : '不通'}\n`)
  if (!existsSync(EXE)) {
    process.stdout.write(`⚠ 找不到 ${EXE}（可用 DOUBAOWORK_EXE 指定）\n`)
    process.exitCode = 8
    return
  }

  if (mode === 'status') {
    if (before.count > 0 && !probe.open) {
      process.stdout.write(`\n要读它（徽章那一行、切模式、对话派发）就得带端口重启它：\n  node ${process.argv[1]} --restart\n注意：这会关掉它，正在跑的东西会中断。\n`)
    }
    process.exitCode = before.count > 0 && !probe.open ? 3 : 0
    return
  }

  if (mode === 'launch') {
    if (before.count > 0) {
      process.stdout.write(`\n它已经在跑了——不重复启动（要带端口就 --restart，会先关掉它）\n`)
      process.exitCode = probe.open ? 0 : 3
      return
    }
    const pid = launch()
    process.stdout.write(`\n已带调试端口启动：PID ${pid ?? '未知'}\n`)
    process.exitCode = pid === null ? 8 : 0
    return
  }

  // restart：显式确认过才关
  process.stdout.write(`\n--restart：即将强制结束它的 ${before.count} 个进程，然后带端口重新拉起\n`)
  stopAll()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const pid = launch()
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const after = probeDebugPort(port)
  process.stdout.write(`新进程 PID ${pid ?? '未知'}；端口 ${port}：${after.open ? '通 ✓' : '还不通（多等几秒或看它是否被自己的启动器拉起）'}\n`)
  process.exitCode = after.open ? 0 : 8
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith('doubao-work-debug.mjs')

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`error: ${String(error?.stack ?? error)}\n`)
    process.exitCode = 8
  })
}

export { USAGE, launch, stopAll }
