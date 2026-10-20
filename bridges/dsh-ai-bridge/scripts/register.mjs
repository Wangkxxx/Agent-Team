#!/usr/bin/env node
/**
 * register.mjs — put the connector into an MCP client's config without hand
 * editing JSON/TOML for every client.
 *
 * The per-client shapes come from docs/design-notes.md and
 * skills/dsh-mcp-connector/references/client-configs.md, where each entry
 * carries its evidence level. This script only encodes what those say.
 *
 * Usage:
 *   node scripts/register.mjs --list
 *   node scripts/register.mjs --client cursor --dry-run
 *   node scripts/register.mjs --client vscode --project <dir>
 *   node scripts/register.mjs --client all --dry-run
 *   node scripts/register.mjs --client doubao-work --token <token>
 *
 * Options:
 *   --client <name>     cursor | vscode | kimi-code | zcode | codebuddy |
 *                       minimax | qwen | qoder | codex | stepcode | claude-code |
 *                       doubao-work | all
 *   --dry-run           print the target file and the resulting content, write nothing
 *   --root <dir>        config root for user-scope clients (default: home directory)
 *   --project <dir>     project directory for project-scope clients (default: cwd)
 *   --server <path>     connector entry point (default: ../dsh-mcp-connector/server.mjs)
 *   --dsh-bin <path>    value for DSH_BIN (omitted when not given)
 *   --workspace <dir>   value for DSH_WORKSPACE (omitted when not given)
 *   --http-url <url>    Streamable HTTP endpoint for in-app clients (default: http://127.0.0.1:8790/mcp)
 *   --token <token>     bearer token the in-app client must send (default: placeholder)
 *
 * Writes keep a `.bak` copy of an existing file. Two clients are never written:
 *   - `claude-code`: its config is CLI-managed, so the script prints the `claude mcp add`
 *     command instead;
 *   - `doubao-work`: it is configured inside the app (技能 · 连接器 · 伙伴), and it needs
 *     the Streamable HTTP endpoint rather than stdio, so the script prints what to paste.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SERVER = resolve(HERE, '..', 'dsh-mcp-connector', 'server.mjs')
const ENTRY_NAME = 'dsh'

/** Every supported client, with the shape its config file needs. */
const CLIENTS = {
  cursor: { file: '.cursor/mcp.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: {} },
  vscode: { file: '.vscode/mcp.json', scope: 'project', format: 'json', key: ['servers'], entry: { type: 'stdio' } },
  'kimi-code': { file: '.kimi-code/mcp.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: {}, note: '官方 schema 未收录 type 字段' },
  zcode: { file: '.zcode/cli/config.json', scope: 'user', format: 'json', key: ['mcp', 'servers'], entry: {} },
  codebuddy: { file: '.codebuddy.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: { type: 'stdio' } },
  minimax: { file: '.minimax/mcp.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: { type: 'stdio' } },
  qwen: { file: '.qwen/settings.json', scope: 'user', format: 'json', key: ['mcpServers'], entry: {} },
  qoder: { file: '.mcp.json', scope: 'project', format: 'json', key: ['mcpServers'], entry: {} },
  codex: { file: '.codex/config.toml', scope: 'user', format: 'toml', key: ['mcp_servers', ENTRY_NAME], entry: {} },
  stepcode: { file: '.stepcode/config.toml', scope: 'user', format: 'toml', key: ['mcp_servers', ENTRY_NAME], entry: {} },
  'claude-code': { scope: 'command', format: 'command' },
  // 豆包工作是**本机桌面 App**，但它在 App 内配置连接器（没有可被脚本改写的配置文件），
  // 而且它只支持 HTTP（streamable-http）而不是 stdio —— 所以这一项只打印要粘贴的内容。
  'doubao-work': { scope: 'in-app', format: 'in-app', transport: 'http' },
}

function parseArgs(argv) {
  const options = {
    client: undefined,
    dryRun: false,
    root: homedir(),
    project: process.cwd(),
    server: DEFAULT_SERVER,
    dshBin: undefined,
    workspace: undefined,
    list: false,
    httpUrl: 'http://127.0.0.1:8790/mcp',
    token: '',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') options.list = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--client') options.client = String(argv[++index] ?? '')
    else if (arg === '--root') options.root = resolve(String(argv[++index] ?? options.root))
    else if (arg === '--project') options.project = resolve(String(argv[++index] ?? options.project))
    else if (arg === '--server') options.server = resolve(String(argv[++index] ?? options.server))
    else if (arg === '--dsh-bin') options.dshBin = String(argv[++index] ?? '')
    else if (arg === '--workspace') options.workspace = String(argv[++index] ?? '')
    else if (arg === '--http-url') options.httpUrl = String(argv[++index] ?? options.httpUrl)
    else if (arg === '--token') options.token = String(argv[++index] ?? '')
  }
  return options
}

function targetPath(spec, options) {
  const base = spec.scope === 'project' ? options.project : options.root
  return join(base, spec.file)
}

function buildEnv(options) {
  const env = {}
  if (options.dshBin !== undefined && options.dshBin.length > 0) env.DSH_BIN = options.dshBin
  if (options.workspace !== undefined && options.workspace.length > 0) env.DSH_WORKSPACE = options.workspace
  return env
}

function buildEntry(spec, options) {
  const entry = { ...spec.entry, command: 'node', args: [options.server] }
  const env = buildEnv(options)
  if (Object.keys(env).length > 0) entry.env = env
  return entry
}

/** The command form for CLI-managed clients. */
function commandLine(options) {
  const envFlags = []
  if (options.dshBin) envFlags.push(`-e DSH_BIN="${options.dshBin}"`)
  if (options.workspace) envFlags.push(`-e DSH_WORKSPACE="${options.workspace}"`)
  return `claude mcp add ${ENTRY_NAME} -s user ${envFlags.join(' ')} -- node "${options.server}"`.replace(/\s+/g, ' ')
}

/**
 * 豆包工作（DoubaoWork）要粘贴的内容。
 *
 * 依据（2026-10-16 查证）：豆包工作支持「新建自定义连接器」，传输类型 HTTP 就是 MCP 的
 * streamable-http，并且可以填自定义 Headers。配置存在 App 内、没有配置文件，
 * 所以脚本**只打印**给用户粘贴——和 `claude-code` 一样不写文件。
 * 它是本机桌面 App，URL 用 127.0.0.1 即可，**不需要** HTTPS 隧道。
 */
function doubaoWorkBlock(options) {
  const url = options.httpUrl
  let port = '8790'
  try {
    const parsed = new URL(url)
    port = parsed.port.length > 0 ? parsed.port : parsed.protocol === 'https:' ? '443' : '80'
  } catch {
    /* 不是合法 URL：原样用，端口留默认 */
  }
  const token = options.token.length > 0 ? options.token : '<TOKEN>'
  const snippet = {
    mcpServers: {
      [ENTRY_NAME]: {
        type: 'streamable-http',
        url,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 60,
      },
    },
  }
  const lines = []
  lines.push('豆包工作没有可被脚本改写的配置文件，请在 App 内添加（两种方式任选）：')
  lines.push('')
  lines.push('【方式一：让 AI 自己装（推荐）】把下面整段发给豆包工作：')
  lines.push('')
  lines.push('帮我安装一个本机 DeepSeek Harness 的 MCP 连接器，配置信息如下：')
  lines.push(JSON.stringify(snippet, null, 2))
  lines.push('')
  lines.push('【方式二：手动添加】左侧「技能 · 连接器 · 伙伴」→ 右上角「新建」→「新建自定义连接器」：')
  lines.push(`  服务名称        ${ENTRY_NAME}`)
  lines.push('  传输类型        HTTP')
  lines.push(`  服务器 URL      ${url}`)
  lines.push(`  自定义 Headers  Authorization = Bearer ${token}`)
  lines.push('')
  lines.push('【端点要先跑起来】（否则两种方式都连不上）')
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME.trim() : ''
  const startCommand = `node "${options.server}" --http --host 127.0.0.1 --port ${port} --token ${token}`
  if (dshHome.length > 0) {
    // 显式带上 DSH_HOME：否则端点会退回 %USERPROFILE%\.dsh-mcp-connector，
    // 于是「端点看到的队列」和「系统实际用的队列」不是同一个文件——两边各说各话。
    lines.push(`  $env:DSH_HOME='${dshHome}'; ${startCommand}`)
  } else {
    lines.push(`  ${startCommand}`)
    lines.push('')
    lines.push('  注意：当前环境没有 DSH_HOME。这台机器上存在两个 mcp-connector 目录')
    lines.push('  （$DSH_HOME\\mcp-connector 与 %USERPROFILE%\\.dsh-mcp-connector），端点退回后者就会出现')
    lines.push('  「队列各说各话」。启动时请显式设置 DSH_HOME，或确认两边指向同一个文件。')
  }
  if (options.token.length === 0) {
    lines.push('')
    lines.push('  注意：上面是 <TOKEN> 占位符。先按这条命令启动一次，把 stderr 里打印的那枚 token 抄下来，')
    lines.push('  然后两边（启动命令与 App 里的 Header）填同一枚。')
  }
  lines.push('')
  lines.push('【怎么确认真的接上了】不要只看它回复「装好了」，要看连接器这边的副作用：')
  lines.push('  · 端点进程 stderr 会打印 streamable HTTP MCP endpoint: ...；')
  lines.push('  · 握手发生过会写进 clients.json（队列同目录，通常 $DSH_HOME\\mcp-connector\\clients.json）；')
  lines.push('  · 在对话里让它列出工具，能看到 dsh_ask / task_* 才算那个会话真的能用。')
  return lines.join('\n')
}

function readJsonAt(object, key) {  return key.reduce((node, segment) => (node !== null && typeof node === 'object' ? node[segment] : undefined), object)
}

function writeJsonAt(object, key, value) {
  let node = object
  for (const segment of key.slice(0, -1)) {
    if (node[segment] === null || typeof node[segment] !== 'object' || Array.isArray(node[segment])) node[segment] = {}
    node = node[segment]
  }
  node[key[key.length - 1]] = value
}

async function planJson(spec, options) {
  const path = targetPath(spec, options)
  let existing = {}
  if (existsSync(path)) {
    try {
      existing = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`${path} 不是合法 JSON，拒绝覆盖：${error.message}`)
    }
  }
  const already = readJsonAt(existing, spec.key)?.[ENTRY_NAME] !== undefined
  writeJsonAt(existing, spec.key, { ...(readJsonAt(existing, spec.key) ?? {}), [ENTRY_NAME]: buildEntry(spec, options) })
  return { path, content: `${JSON.stringify(existing, null, 2)}\n`, existed: existsSync(path), already }
}

function upsertToml(source, section, entry) {
  const lines = [
    `[${section}]`,
    'command = "node"',
    `args = ["${entry.args[0].replace(/\\/g, '\\\\')}"]`,
    ...(entry.env
      ? ['', `[${section}.env]`, ...Object.entries(entry.env).map(([key, value]) => `${key} = "${String(value).replace(/\\/g, '\\\\')}"`)]
      : []),
    '',
  ]
  const header = `[${section}]`
  const start = source.indexOf(header)
  if (start === -1) {
    const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n'
    return { text: `${source}${separator}${lines.join('\n')}`, replaced: false }
  }
  // Replace the section up to the next top-level table header.
  const rest = source.slice(start + header.length)
  const nextHeader = rest.search(/\n\[(?!mcp_servers\.dsh)/)
  const end = nextHeader === -1 ? source.length : start + header.length + nextHeader + 1
  return { text: `${source.slice(0, start)}${lines.join('\n')}${source.slice(end)}`, replaced: true }
}

async function planToml(spec, options) {
  const path = targetPath(spec, options)
  const source = existsSync(path) ? await readFile(path, 'utf8') : ''
  const section = spec.key.join('.')
  const already = source.includes(`[${section}]`)
  const { text } = upsertToml(source, section, buildEntry(spec, options))
  return { path, content: text, existed: existsSync(path), already }
}

async function apply(plan) {
  await mkdir(dirname(plan.path), { recursive: true })
  if (plan.existed) await copyFile(plan.path, `${plan.path}.bak`)
  await writeFile(plan.path, plan.content, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (options.list || options.client === undefined) {
    process.stdout.write(`连接器入口: ${options.server}\n存在: ${existsSync(options.server)}\n\n`)
    for (const [name, spec] of Object.entries(CLIENTS)) {
      if (spec.scope === 'command') {
        process.stdout.write(`${name.padEnd(12)} CLI 管理，脚本只打印命令\n`)
        continue
      }
      if (spec.scope === 'in-app') {
        process.stdout.write(`${name.padEnd(12)} App 内配置（HTTP），脚本只打印要粘贴的内容\n`)
        continue
      }
      const path = targetPath(spec, options)
      const registered = existsSync(path) && (await readFile(path, 'utf8')).includes(ENTRY_NAME)
      process.stdout.write(
        `${name.padEnd(12)} ${existsSync(path) ? '存在' : '不存在'}  ${registered ? '已注册' : '未注册'}  ${path}\n`,
      )
    }
    if (options.client === undefined && !options.list) {
      process.stdout.write('\n用法: node scripts/register.mjs --client <name> [--dry-run]\n')
      process.exitCode = 1
    }
    return
  }

  const names = options.client === 'all' ? Object.keys(CLIENTS) : [options.client]
  for (const name of names) {
    const spec = CLIENTS[name]
    if (spec === undefined) {
      process.stderr.write(`未知客户端: ${name}\n可选: ${Object.keys(CLIENTS).join(', ')}, all\n`)
      process.exitCode = 1
      return
    }

    if (spec.scope === 'command') {
      process.stdout.write(`${name}: 请运行\n  ${commandLine(options)}\n`)
      continue
    }

    if (spec.scope === 'in-app') {
      process.stdout.write(`${name}:\n${doubaoWorkBlock(options)}\n`)
      continue
    }

    const plan = spec.format === 'json' ? await planJson(spec, options) : await planToml(spec, options)
    if (options.dryRun) {
      process.stdout.write(`${name} -> ${plan.path}${plan.already ? '  (将覆盖已有的 dsh 条目)' : ''}\n${plan.content}\n`)
    } else {
      await apply(plan)
      process.stdout.write(`${name} -> 已写入 ${plan.path}${plan.existed ? '（原文件备份为 .bak）' : ''}\n`)
    }
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`)
  process.exitCode = 1
})
