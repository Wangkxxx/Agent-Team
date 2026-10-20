#!/usr/bin/env node
/**
 * doubao-cdp — drive the Doubao desktop app (Electron) over the Chrome DevTools
 * Protocol, to dispatch a task into its chat UI from outside.
 *
 * Requires Doubao to be running with:
 *   Doubao.exe --remote-debugging-port=9222 --remote-allow-origins=*
 *
 * Zero dependencies: Node's global WebSocket talks to CDP directly.
 *
 * Usage:
 *   node cdp.mjs doctor                     # 确认豆包是否可被驱动（不连也行）
 *   node cdp.mjs state [--json]             # 只读快照：当前模式 + 当前模型（给面板用）
 *   node cdp.mjs mode <work|chat> [--json]  # 切换模式（写操作：点豆包 UI，点完用只读读数复核）
 *   node cdp.mjs quota [--json]             # 只读采样：额度用量 % + 重置次数 + 套餐（要点开账户菜单）
 *   node cdp.mjs models [--json]            # 只读采样：可选模型清单 + 当前项 + 状态标注（要点开模型菜单）
 *   node cdp.mjs targets
 *   node cdp.mjs probe                      # find the chat input candidates
 *   node cdp.mjs send "任务文本"            # focus input, insert text, click send
 *   node cdp.mjs wait [timeoutMs]           # block until a new reply lands, print it
 *   node cdp.mjs read [n]                   # read the last n messages
 *   node cdp.mjs click <x> <y>
 *   node cdp.mjs key <key> [--ctrl] [--shift] [--alt] [--meta]
 *   node cdp.mjs eval "<expression>"
 *
 * Every command except `doctor` first runs the startup confirmation; add
 * --no-preflight to bypass it (then a closed port reports only "fetch failed").
 *
 * Every command also runs the pre-call identification (five dimensions:
 * connectivity / mode / command capability / busy-idle / status channel).
 * ready → proceed; not-ready or unknown → refuse (exit 3 / 8). --force proceeds
 * anyway and leaves an override record. --mode <chat|work|unknown> skips the
 * DOM read (diagnostics and tests).
 *
 * Exit codes: 0 ok, 1 error, 2 wait timed out, 3 not ready, 4 disabled,
 *             5 unknown job, 6 a job is still open, 8 cannot identify.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { resolveQueueDir } from '../dsh-mcp-connector/queue.mjs'
import {
  CDP_MATCH,
  CDP_PORT,
  PRECHECK_EXIT,
  PREFLIGHT_EXIT_CODE,
  commandCapability,
  formatDoubaoReport,
  formatPreCallReport,
  inspectDoubao,
  inspectPreCall,
  mapModeText,
  parseContextPanel,
  parseContextUsage,
  probeDebugPort,
  resolveCdpTarget,
  splitModelText,
} from './doubao.mjs'
import { loadConfig, recordOverride } from './status.mjs'

/**
 * 目标提前解析：`--target/--port/--match` 在 argv 里任意位置都认（和别的开关一样），
 * 所以这些值必须在命令分派之前定下来。`--target work` = 豆包工作（9223）。
 */
function earlyTargetArgs(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--target') out.target = String(argv[index + 1] ?? '')
    else if (arg === '--port') out.port = String(argv[index + 1] ?? '')
    else if (arg === '--match') out.match = String(argv[index + 1] ?? '')
  }
  return out
}

// 目标解析失败（比如 --target 写错）要给人话，而不是一段堆栈。
let TARGET
try {
  TARGET = resolveCdpTarget(earlyTargetArgs(process.argv.slice(2)))
} catch (error) {
  process.stderr.write(`error: ${String(error?.message ?? error)}\n`)
  process.exit(1)
}
const PORT = TARGET.port
const MATCH = TARGET.match

/** 输入框左侧的模式控件文字（对话 / 本地电脑 / …）。 */
const MODE_TEXT = `(() => {
  const el = document.querySelector('[data-testid="chat_input_action_mode"]');
  return el ? (el.innerText || '').trim() : '';
})()`

/**
 * 输入框旁「上下文用量」圆环（**两个 App 都有，但只在打开的对话里出现**）。
 *
 * 用量不是文字，而是画在 `conic-gradient` 的角度里：`角度 / 360 = 用量比例`。
 * Percentage is derived from the reported angle; live account values are not stored in source.
 * 这是**纯读**——不点任何菜单、不开设置，所以没有闪菜单那类副作用。
 * 找不到控件时必须先判断「是不是根本没打开对话」，否则会把状态差异报成能力差异。
 */
const CONTEXT_USAGE = `(() => {
  const messageCount = document.querySelectorAll('[data-testid*="message"],[class*="message-item"]').length;
  const el = document.querySelector('[data-testid="chat_input_action_context_usage"]');
  if (!el) return JSON.stringify({ found: false, messageCount, url: location.href });
  const ring = [...el.querySelectorAll('div')].find((d) => (d.getAttribute('style') || '').includes('conic-gradient'));
  const style = ring ? ring.getAttribute('style') : '';
  const angle = /conic-gradient\\([^,]*?\\s([0-9.]+)deg/.exec(style);
  return JSON.stringify({
    found: true,
    label: el.getAttribute('aria-label') || '',
    angleDeg: angle ? Number(angle[1]) : null,
    style,
    messageCount,
    url: location.href,
  });
})()`


/** 点开/收起「上下文窗口」：同一个圆环按钮 toggle，所以开和关是同一个动作。 */
const CONTEXT_PANEL_TOGGLE = `(() => {
  const el = document.querySelector('[data-testid="chat_input_action_context_usage"]');
  if (!el) return 'no-button';
  el.click();
  return 'clicked';
})()`

/** 读上下文窗口的内容（点开后是 `[role=dialog]` 的一坨文本）。 */
const CONTEXT_PANEL_TEXT = `(() => {
  const el = document.querySelector('[role=dialog]');
  return el ? (el.innerText || '') : '';
})()`

/** 账号头像：取矩形中心供**真实鼠标点击**（JS click 打不开这个弹层，实测过）。 */
const ACCOUNT_AVATAR_RECT = `(() => {
  const el = document.querySelector('[data-testid="chat_header_avatar_button"]');
  if (!el) return 'no-avatar';
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`

/** 账号弹层里的文本：不依赖 role（实测它不一定是 menu/dialog），按可疑容器收集。 */
const ACCOUNT_PANEL_TEXT = `(() => {
  const out = [];
  for (const sel of ['[role=menu]', '[role=dialog]', '[class*=popover]', '[class*=Popover]', '[class*=dropdown]', '[class*=Dropdown]', '[class*=account]']) {
    for (const el of document.querySelectorAll(sel)) {
      const text = (el.innerText || '').trim();
      if (text.length > 0 && text.length < 400) out.push(text);
    }
  }
  return out.join('|')
})()`
async function readModeViaCdp() {
  try {
    const target = await pickTarget()
    const client = await Cdp.connect(target.webSocketDebuggerUrl)
    try {
      await client.send('Runtime.enable')
      return mapModeText(await client.evaluate(MODE_TEXT))
    } finally {
      client.close()
    }
  } catch (error) {
    return { id: 'unknown', raw: '', error: error.message }
  }
}

/**
 * 面板要的「豆包现在长什么样」：模式 + 模型（含档位）。
 *
 * 一次 CDP 往返同时读两处，避免面板轮询时连两次：
 *   - 模式：`[data-testid=chat_input_action_mode]`
 *   - 模型：`[data-testid=chat_input_action_model]`，其 innerText 形如
 *     `豆包 2.1 Lite低`；末尾的档位是同层一个 `text-dbx-text-tertiary` span，
 *     单独取出来交给 splitModelText 剥后缀（真机实测，见 doubao.mjs 注释）。
 * 全部只读：只 querySelector + innerText，不点任何东西、不改任何状态。
 */
const STATE_DOM = `(() => {
  const text = (el) => (el && (el.innerText || el.textContent) ? (el.innerText || el.textContent).trim() : '');
  const modeEl = document.querySelector('[data-testid=chat_input_action_mode]');
  const modelEl = document.querySelector('[data-testid=chat_input_action_model]');
  let modelFull = '';
  let modelLevel = '';
  if (modelEl) {
    modelFull = text(modelEl);
    const levelEl = modelEl.querySelector('span[class*=text-dbx-text-tertiary]') || modelEl.querySelector('span.ml-4');
    modelLevel = levelEl ? (levelEl.textContent || '').trim() : '';
  }
  // 上下文用量圆环（两个 App 都有，但**只在打开的对话里出现**）：角度/360 = 比例。
  // 同一次 evaluate 里读掉，面板就不用为它多开一次 CDP。
  const usageEl = document.querySelector('[data-testid="chat_input_action_context_usage"]');
  const messageCount = document.querySelectorAll('[data-testid*="message"],[class*="message-item"]').length;
  let usage = { found: false, messageCount };
  if (usageEl) {
    const ring = [...usageEl.querySelectorAll('div')].find((d) => (d.getAttribute('style') || '').includes('conic-gradient'));
    const style = ring ? ring.getAttribute('style') : '';
    const m = /conic-gradient\\([^,]*?\\s([0-9.]+)deg/.exec(style);
    usage = { found: true, label: usageEl.getAttribute('aria-label') || '', angleDeg: m ? Number(m[1]) : null, messageCount };
  }
  return { modeText: text(modeEl), modelFull, modelLevel, usage };
})()`

/** 通过 CDP 读模式 + 模型；连不上就返回 undefined（调用方据此判「未连接」）。 */
async function readStateViaCdp() {
  const target = await pickTarget()
  const client = await Cdp.connect(target.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')
    return await client.evaluate(STATE_DOM)
  } finally {
    client.close()
  }
}

/**
 * 模式读取的 30 秒缓存（决策 12）：连续派发时不用每次都连一次 CDP。
 * 只缓存**认得出来**的模式——unknown 不缓存，否则修好了还要等 30 秒才发现。
 * 连通性与忙闲每次重算（它们变化更快，缓存它们会让「忙」漏过去）。
 */
const MODE_CACHE_TTL_MS = 30_000

async function readMode({ useCache = true } = {}) {
  const file = join(resolveQueueDir(), '.precheck-cache.json')
  if (useCache) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8'))
      if ((cached.mode === 'chat' || cached.mode === 'work') && Date.now() - Number(cached.at ?? 0) < MODE_CACHE_TTL_MS) {
        return { id: cached.mode, raw: `${cached.raw ?? ''}（30 秒内缓存）`, cached: true }
      }
    } catch {
      /* 没有缓存或读坏了：直接重新读 */
    }
  }
  const mode = await readModeViaCdp()
  if (mode.id === 'chat' || mode.id === 'work') {
    await writeFile(file, `${JSON.stringify({ mode: mode.id, raw: mode.raw, at: Date.now() })}\n`, 'utf8').catch(() => {})
  }
  return mode
}

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return response.json()
}

async function pickTarget() {
  const targets = await listTargets()
  const page = targets.find((t) => t.type === 'page' && t.url.includes(MATCH))
  if (page === undefined) {
    throw new Error(`no page target matching "${MATCH}" on port ${PORT}`)
  }
  return page
}

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 0
    this.pending = new Map()
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error(`cannot open CDP websocket at ${url}`))
    })
    const client = new Cdp(socket)
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const entry = client.pending.get(message.id)
      if (entry === undefined) return
      client.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    return client
  }

  send(method, params = {}) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      throw new Error(`page exception: ${detail}`)
    }
    return result.result.value
  }

  close() {
    this.socket.close()
  }
}

const PROBE_INPUT = `(() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')];
  return JSON.stringify(nodes.map((el, index) => ({
    index,
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 140),
    placeholder: el.getAttribute('placeholder'),
    role: el.getAttribute('role'),
    contenteditable: el.getAttribute('contenteditable'),
    visible: Boolean(el.offsetWidth || el.offsetHeight),
    text: String(el.innerText || el.value || '').slice(0, 60),
  })), null, 2);
})()`

/** Focus the largest visible editable node — the chat composer. */
const FOCUS_INPUT = `(() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter((el) => el.offsetWidth || el.offsetHeight);
  if (nodes.length === 0) return 'NO_INPUT';
  nodes.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  const el = nodes[0];
  el.focus();
  el.click();
  return el.tagName + '|' + String(el.className || '').slice(0, 80);
})()`

/** The composer's current text, used to confirm a submission actually left it. */
const COMPOSER_TEXT = `(() => {
  const nodes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter((el) => el.offsetWidth || el.offsetHeight);
  if (nodes.length === 0) return 'NO_INPUT';
  nodes.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  return (nodes[0].innerText || '').trim();
})()`

const READ_MESSAGES = (count) => `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="union_message"]')];
  const messages = nodes.map((el) => {
    const isUser = el.querySelector('[data-testid="send_message"]') !== null;
    const body = el.querySelector('[data-testid="message_text_content"]');
    return {
      role: isUser ? 'user' : 'assistant',
      text: String(body ? body.innerText : el.innerText || '').trim(),
    };
  }).filter((message) => message.text.length > 0);
  return JSON.stringify(messages.slice(-${count}));
})()`

/** Locate the send button and return its centre in CSS pixels. */
const FIND_SEND_BUTTON = `(() => {
  const candidates = [
    document.querySelector('.send-btn-wrapper'),
    ...document.querySelectorAll('button,[role="button"]'),
  ].filter(Boolean);
  for (const el of candidates) {
    const label = String(el.getAttribute('aria-label') || '') + String(el.className || '');
    if (!/send-btn|发送|send/i.test(label)) continue;
    const rect = el.getBoundingClientRect();
    if (!(rect.width || rect.height)) continue;
    return JSON.stringify({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
  }
  return null;
})()`

const COUNT_ASSISTANT = `document.querySelectorAll('[data-testid="receive_message"]').length`
const COUNT_USER = `document.querySelectorAll('[data-testid="send_message"]').length`

/**
 * Texts Doubao parks in the assistant slot while it is still working. These are
 * stable, so the "text stopped changing" heuristic would otherwise accept one
 * as the final answer — which is how a work-mode dispatch once reported
 * "正在思考" as a successful reply.
 */
const PLACEHOLDER = /^(正在|思考中|加载中|Thinking|Loading)/i

/**
 * 这句是不是「正在干活」的占位？
 *
 * 真机遇到过两种：`正在思考`（对话模式）与 `正在准备任务上下文`（工作模式）。
 * 写死列表会一直漏，所以规则是：**以「正在」开头且很短**——占位句天生短；
 * 长回复里出现「正在…」是正常内容，不能误伤。
 */
export function isPlaceholder(text) {
  const value = String(text ?? '').trim()
  if (value.length === 0) return false
  if (/^(Thinking|Loading)/i.test(value)) return true
  return PLACEHOLDER.test(value) && value.length <= 24
}

/**
 * 'answered' when the conversation ends with an assistant message, 'awaiting'
 * when the last message is still the user's. Defined this way instead of
 * "count increased" because the reply often lands while `send` is still
 * confirming the submission.
 */
const TURN_STATE = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="union_message"]')];
  if (nodes.length === 0) return 'empty';
  const last = nodes[nodes.length - 1];
  return last.querySelector('[data-testid="send_message"]') ? 'awaiting' : 'answered';
})()`

const LAST_ASSISTANT = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="receive_message"]')];
  if (nodes.length === 0) return '';
  const body = nodes[nodes.length - 1].querySelector('[data-testid="message_text_content"]');
  return String(body ? body.innerText : nodes[nodes.length - 1].innerText).trim();
})()`

async function clickAt(client, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    await sleep(80)
  }
}

/** 原生按键（合成 KeyboardEvent 会被应用忽略）。用来关掉误开的菜单。 */
async function pressKey(client, keyName) {
  const virtualKey = keyName === 'Escape' ? 27 : 0
  for (const type of ['keyDown', 'keyUp']) {
    await client.send('Input.dispatchKeyEvent', {
      type,
      modifiers: 0,
      key: keyName,
      code: keyName,
      windowsVirtualKeyCode: virtualKey,
      nativeVirtualKeyCode: virtualKey,
    })
    await sleep(60)
  }
}

/** 模式控件的可点中心（不可见时返回 null）。 */
const MODE_CONTROL_RECT = `(() => {
  const el = document.querySelector('[data-testid=chat_input_action_mode]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/** 模型控件的可点中心（不可见时返回 null）。 */
const MODEL_CONTROL_RECT = `(() => {
  const el = document.querySelector('[data-testid=chat_input_action_model]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/**
 * 菜单（点开模式控件后出现的那个）里目标选项的可点中心；找不到返回 null。
 *
 * 为什么这么绕：**菜单项和控件本身都会出现「对话」这两个字**，直接按文字找会点到
 * 控件自己。所以先定位「同时包含对话与本地电脑、且不包含控件」的最小容器（真机实测
 * 是 265×198 的那个浮层），再只在它内部找行——这样不会误点页面别处的同名标签。
 */
const modeOptionRect = (target) => `(() => {
  const want = ${JSON.stringify(target)};
  const control = document.querySelector('[data-testid=chat_input_action_mode]');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const menus = [...document.querySelectorAll('div,ul,[role=menu],[role=listbox]')]
    .filter((el) => visible(el) && el !== control && !el.contains(control))
    .map((el) => ({ el, r: el.getBoundingClientRect(), text: (el.innerText || '').trim() }))
    .filter((x) => x.text.includes('对话') && x.text.includes('本地电脑')
      && x.r.height >= 80 && x.r.height <= 520 && x.r.width >= 120 && x.r.width <= 640)
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  if (menus.length === 0) return null;
  const pattern = want === 'work' ? /本地电脑|工作/ : /^对话$/;
  const rows = [...menus[0].el.querySelectorAll('*')]
    .filter((el) => visible(el))
    .map((el) => { const r = el.getBoundingClientRect(); return { text: (el.innerText || '').trim(), r }; })
    .filter((x) => x.text.length > 0 && x.text.length < 40 && x.r.height >= 24 && x.r.height <= 64 && pattern.test(x.text))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  if (rows.length === 0) return null;
  const r = rows[0].r;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: rows[0].text };
})()`

/**
 * 切换豆包的模式（本地电脑 ↔ 对话）。**这是写操作：点它自己的 UI。**
 *
 * 纪律（与派发器同一条）：一步一步来，每一步都用**只读**读数复核——
 *   1. 先读当前模式；已经是目标就返回 changed:false（幂等，不白点一次）；
 *   2. 点模式控件 → 等菜单出现（找不到目标选项就按 Escape 关掉，报失败）；
 *   3. 点目标选项 → 轮询只读模式，直到它真的等于目标。
 * **点完读数没变就是失败**，绝不因为「我点过了」就声称切好了。返回里带上
 * modeBefore / modeAfter，让调用方能看出到底发生了什么。
 */
async function switchMode(target) {
  const before = await readModeViaCdp()
  if (before.id === target) {
    return { ok: true, changed: false, modeBefore: before.id, modeAfter: before.id }
  }
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  const readModeWith = async () => mapModeText(await client.evaluate(MODE_TEXT))
  try {
    await client.send('Runtime.enable')
    const control = await client.evaluate(MODE_CONTROL_RECT)
    if (control === null) {
      return { ok: false, changed: false, modeBefore: before.id, error: '找不到模式控件（豆包改版了？）' }
    }
    await clickAt(client, control.x, control.y)

    let option = null
    for (let attempt = 0; attempt < 12 && option === null; attempt += 1) {
      await sleep(200)
      option = await client.evaluate(modeOptionRect(target))
    }
    if (option === null) {
      await pressKey(client, 'Escape')
      return { ok: false, changed: false, modeBefore: before.id, error: '模式菜单里没找到目标选项' }
    }

    await clickAt(client, option.x, option.y)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(300)
      const now = await readModeWith()
      if (now.id === target) {
        return { ok: true, changed: true, modeBefore: before.id, modeAfter: now.id, option: option.text }
      }
    }
    const after = await readModeWith()
    await pressKey(client, 'Escape')
    return {
      ok: false,
      changed: false,
      modeBefore: before.id,
      modeAfter: after.id,
      option: option.text,
      error: `点了「${option.text}」但只读复核仍是 ${after.id}——当作没切成`,
    }
  } finally {
    client.close()
  }
}

/**
 * 账户/套餐入口的可点中心（在侧栏底部的 `sidebar_bottom` 里）。
 * **找不到就返回 null，不做「点一下试试」的兜底**——侧栏上乱点可能开出别的东西。
 */
const QUOTA_CHIP_RECT = `(() => {
  const sidebar = document.querySelector('[data-testid=sidebar_bottom]');
  if (!sidebar) return null;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const chip = [...sidebar.querySelectorAll('*')]
    .filter((el) => visible(el) && /套餐|免费版|会员|专业版/.test((el.innerText || '').trim()) && (el.innerText || '').trim().length < 24)
    .map((el) => ({ r: el.getBoundingClientRect() }))
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height)[0];
  if (chip === undefined) return null;
  const r = chip.r;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/**
 * 账户菜单打开后要读的东西：额度用量 + 重置次数 + 套餐名。
 *
 * 真机实测（豆包 2.x）：额度**不在常驻 DOM 里**，只在点开账户菜单后的浮层里出现，
 * 形如 `当前时段额度用量` + `0%`，另有 `1 次额度重置`。套餐名在侧栏那个 chip 上
 * （`显示名称 / 套餐名称`）——**只取套餐，不取账号名**。
 * 读不到就返回 null 字段（由调用方判失败），绝不猜一个数字。
 */
const QUOTA_DOM = `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  const sidebar = document.querySelector('[data-testid=sidebar_bottom]');
  const sidebarParts = sidebar ? text(sidebar).split(/\\n/).map((p) => p.trim()).filter((p) => p.length > 0) : [];
  const plan = sidebarParts.find((part) => /套餐|免费版|会员/.test(part)) ?? '';

  const rows = [...document.querySelectorAll('div,span')]
    .filter((el) => visible(el) && text(el).includes('当前时段额度用量') && text(el).includes('%'))
    .sort((a, b) => text(a).length - text(b).length);
  if (rows.length === 0) return { menuFound: false, plan };
  const rowText = text(rows[0]).replace(/\\s+/g, ' ');
  const percent = /(\\d{1,3})\\s*%/.exec(rowText);

  const menu = [...document.querySelectorAll('div')]
    .filter((el) => visible(el) && text(el).includes('退出登录') && text(el).includes('当前时段额度用量'))
    .sort((a, b) => text(a).length - text(b).length)[0];
  const menuText = menu ? text(menu).replace(/\\s+/g, ' ') : '';
  const reset = /(\\d+)\\s*次额度重置/.exec(menuText);

  return {
    menuFound: true,
    plan,
    label: rowText.split(' ')[0] ?? '当前时段额度用量',
    usedPercent: percent ? Number(percent[1]) : null,
    resets: reset ? Number(reset[1]) : null,
  };
})()`

/** 可见弹层数量：用来确认「读完之后真的关干净了」。 */
const VISIBLE_DIALOGS = `[...document.querySelectorAll('[role=dialog],[role=menu]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length`

/**
 * 额度页文本 → 窗口数组。**纯函数**，synthetic input is used in tests:
 *
 * ```
 * 示例套餐 / 订阅与额度管理 / 免费体验 / … / 当前时段 / 已用 <1% /
 * 约 3 小时后重置 / 近 7 天 / 已用 25% / 12月31日 23:59 重置 / 额度重置 / 3 次 / 订阅记录
 * ```
 *
 * 注意 `已用 <1%` 这种写法：**不能读成 1%**。它表示「不到 1%」，所以数值取 0（下界），
 * 原文 `<1%` 原样留在 `usedText` 里，并标 `approximate: true`——界面显示原文，
 * 进度条按下界画。宁可条是空的，也不把「不到 1%」说成 1%。
 */
export function parseQuotaWindows(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const windows = []
  for (let index = 0; index < lines.length; index += 1) {
    const used = /^已用\s*([<＜]?\s*\d+(?:\.\d+)?)\s*%$/.exec(lines[index])
    if (used === null) continue
    const label = index > 0 ? lines[index - 1] : ''
    const approximate = /[<＜]/.test(used[1])
    const numeric = Number(String(used[1]).replace(/[^0-9.]/g, ''))
    windows.push({
      ...quotaWindowMeta(label),
      label,
      usedText: lines[index].replace(/^已用\s*/, ''),
      usedPercent: approximate ? 0 : Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0,
      approximate,
      resetText: /重置/.test(lines[index + 1] ?? '') ? lines[index + 1] : '',
    })
  }
  const resetIndex = lines.findIndex((line) => line === '额度重置')
  const resetMatch = resetIndex >= 0 ? /(\d+)\s*次/.exec(lines[resetIndex + 1] ?? '') : null
  const planLine = lines.find((line) => /套餐/.test(line) && line.length < 20)
  return {
    windows,
    resets: resetMatch ? Number(resetMatch[1]) : null,
    plan: planLine ?? '',
  }
}

/**
 * 窗口的短名。豆包页面上写的是「当前时段」和「近 7 天」，用户嘴里叫「5h / 7d」，
 * 所以两者都留着：`short` 给界面（短），`label` 给悬停提示（原文，不翻译）。
 */
function quotaWindowMeta(label) {
  if (/时段|小时/.test(label)) return { id: 'session', short: '5h' }
  if (/7\s*天|周/.test(label)) return { id: 'week', short: '7d' }
  return { id: 'window', short: label }
}

/** 额度页目标的 URL 特征（App 里是 iframe，外部浏览器里是普通页面）。 */
const QUOTA_PAGE_MATCH = 'member/quota-management'

/** 在「包含 退出登录 的最小浮层」内找文字完全等于 label 的最小可点元素中心。 */
const menuRowRect = (label) => `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const scope = [...document.querySelectorAll('div')]
    .filter((el) => visible(el) && text(el).includes('退出登录') && text(el).includes('${label}'))
    .sort((a, b) => text(a).length - text(b).length)[0] ?? document;
  const rects = [...scope.querySelectorAll('*')]
    .filter((el) => visible(el) && text(el) === '${label}')
    .map((el) => el.getBoundingClientRect())
    .sort((a, b) => a.width * a.height - b.width * b.height);
  if (rects.length === 0) return null;
  const r = rects[0];
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/** 在全文档里找文字完全等于 label 的最小可见元素中心（用于独一无二的标签）。 */
const exactTextRect = (label) => `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rects = [...document.querySelectorAll('*')]
    .filter((el) => visible(el) && text(el) === '${label}')
    .map((el) => el.getBoundingClientRect())
    .sort((a, b) => a.width * a.height - b.width * b.height);
  if (rects.length === 0) return null;
  const r = rects[0];
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`

/** 页面上是否存在**可见**的、文字完全等于 label 的元素（用来验证「这一步真的生效了」）。 */
const hasVisibleText = (label) => `[...document.querySelectorAll('*')].filter((el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && ((el.innerText || el.textContent || '').trim() === '${label}');
}).length > 0`

/**
 * 坐标链的调试开关：`DOUBAO_QUOTA_DEBUG=1` 时把每一步看到的东西打到 stderr。
 * 这条链天生不稳（动画、幻影行、被吞的点击），没有这个开关只能靠猜。
 */
const QUOTA_DEBUG = process.env.DOUBAO_QUOTA_DEBUG === '1'
const debugLog = (...parts) => {
  if (QUOTA_DEBUG) process.stderr.write(`[quota] ${parts.join(' ')}\n`)
}

/** 读额度页的可见文本；在 timeoutMs 内没等到这个目标就返回 null。 */
async function readQuotaPageText({ timeoutMs = 12_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let polls = 0
  let lastError = null
  for (;;) {
    polls += 1
    let target
    try {
      const targets = await listTargets()
      target = targets.find((candidate) => String(candidate.url).includes(QUOTA_PAGE_MATCH))
      debugLog(
        `readQuotaPageText: 第 ${polls} 次轮询，共 ${targets.length} 个目标，额度页 =`,
        target === undefined ? '没有' : String(target.url).slice(0, 70),
      )
    } catch (error) {
      lastError = String(error?.message ?? error)
      debugLog('readQuotaPageText: 列目标失败', lastError)
      target = undefined
    }

    if (target !== undefined) {
      // **不要**让一次连接/读取失败把整条链带崩：目标是刚创建的，可能还没就绪。
      try {
        const client = await Cdp.connect(target.webSocketDebuggerUrl)
        try {
          await client.send('Runtime.enable')
          const value = await client.evaluate('document.body.innerText')
          const text = typeof value === 'string' ? value : ''
          if (text.trim().length > 0) {
            debugLog('readQuotaPageText: 读到文本长度 =', text.length)
            return text
          }
          lastError = '额度页文本为空'
        } finally {
          client.close()
        }
      } catch (error) {
        lastError = String(error?.message ?? error)
        debugLog('readQuotaPageText: 读目标失败，继续等 =', lastError)
      }
    }

    if (Date.now() >= deadline) {
      debugLog('readQuotaPageText: 超时，最后错误 =', lastError)
      return null
    }
    await sleep(300)
  }
}

/**
 * 走 App 自己的入口读「订阅与额度管理」页：账户菜单 → 设置 → 订阅与额度管理 → 读 iframe。
 *
 * 为什么走这条（而不是 createTarget）：实测 `Target.createTarget` 会挂在一个
 * **1051×677 的可见窗口**上；而这条路是 App 自己的 iframe，不额外开窗口。
 * 代价是三次点击 + 设置面板会闪开一下；**iframe 会自己消失**，所以每次都重新打开。
 *
 * 这条路**天生不稳**（真机实测：同一段代码三次里有时连「设置」都找不到，有时点到了却
 * 等不到 iframe）——菜单动画期间量到的坐标会点偏、点击会被吞。所以每一步都
 * **验证它真的生效了**并重试，宁可多花两秒也不要随机失败。
 *
 * 结构上刻意**整轮重试**（见 `openQuotaEntry` + 下面的 for）：真机上的失败模式是
 * 「面板正在关闭时仍能搜到一行」的**幻影行**——相信单次探测就会跳过开菜单、点个空，
 * 然后因为行消失而直接放弃（实测 3.7 秒就报「没等到 iframe」）。
 * 所以：不赌单次探测；行消失不放弃；没等到 iframe 就把**整条链**重走一遍。
 *
 * 无论成败都在 finally 里 Escape 两次，并确认没有残留可见弹层。
 */
async function readQuotaFromPage() {
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')
    for (let round = 0; round < 2; round += 1) {
      const row = await openQuotaEntry(client)
      if (row !== null) {
        await clickAt(client, row.x, row.y)
        const text = await readQuotaPageText({ timeoutMs: round === 0 ? 8_000 : 12_000 })
        if (text !== null && String(text).trim().length > 0) {
          const parsed = parseQuotaWindows(text)
          if (parsed.windows.length > 0) {
            return { ok: true, plan: parsed.plan, resets: parsed.resets, windows: parsed.windows, at: Date.now() }
          }
          // 页面真的打开了但解析不出窗口 → 是页面改版，不是时序问题，不必再试。
          return { ok: false, error: '额度页里没解析出窗口（页面改版了？）', pageText: String(text).slice(0, 300) }
        }
      }
      // 这一轮没成：关干净再来一轮（幻影行/被吞的点击都会在这里被纠正）。
      await escapePanel(client)
    }
    return { ok: false, error: '额度页没打开（重试 2 轮都没等到 iframe）' }
  } finally {
    await escapePanel(client)
    client.close()
  }
}

/**
 * 打开「设置」面板并返回「订阅与额度管理」那一行的坐标；打不开就返回 null。
 * 每一步都验证生效：点入口后确认 `退出登录` 可见；点「设置」后轮询那一行。
 */
async function openQuotaEntry(client) {
  // 面板已经开着（上一轮的残留）就直接用那一行。**注意**：这里可能是「正在关闭」的
  // 幻影行，所以调用方必须在点完之后验证 iframe，失败就整轮重来。
  // 这一行用**全文档**查找（`exactTextRect`），不能用账户菜单容器限定——
  // 设置面板渲染在那个浮层之外，限定后反而搜不到（真机踩过）。
  const existing = await client.evaluate(exactTextRect('订阅与额度管理'))
  debugLog('openQuotaEntry: 已有面板行 =', JSON.stringify(existing))
  if (existing !== null) return existing

  // 1) 打开账户菜单，并确认它真的开了。
  let menuOpen = false
  for (let attempt = 0; attempt < 3 && !menuOpen; attempt += 1) {
    const chip = await client.evaluate(QUOTA_CHIP_RECT)
    debugLog(`openQuotaEntry: 第 ${attempt + 1} 次点入口 chip =`, JSON.stringify(chip))
    if (chip === null) return null
    await clickAt(client, chip.x, chip.y)
    await sleep(500)
    menuOpen = await client.evaluate(hasVisibleText('退出登录'))
    debugLog('openQuotaEntry: 菜单开了吗 =', menuOpen)
  }
  if (!menuOpen) return null

  // 2) 点「设置」，等设置面板里那一行出现。
  const settings = await client.evaluate(menuRowRect('设置'))
  debugLog('openQuotaEntry: 设置 rect =', JSON.stringify(settings))
  if (settings === null) return null
  await clickAt(client, settings.x, settings.y)
  for (let wait = 0; wait < 16; wait += 1) {
    await sleep(300)
    const row = await client.evaluate(exactTextRect('订阅与额度管理'))
    if (row === null) continue
    // **关键**：面板出场有动画，动画期间量到的坐标是移动的，点上去就是点空
    // （实测症状：四步全对、日志里坐标也对，但 iframe 永远不来）。
    // 所以连续两次量到同一个坐标，才认为面板停稳、可以点。
    await sleep(250)
    const again = await client.evaluate(exactTextRect('订阅与额度管理'))
    if (again !== null && again.x === row.x && again.y === row.y) {
      debugLog(`openQuotaEntry: 第 ${wait + 1} 轮找到稳定额度行 =`, JSON.stringify(again))
      return again
    }
    debugLog(`openQuotaEntry: 第 ${wait + 1} 轮行还在动 =`, JSON.stringify(row), '→', JSON.stringify(again))
  }
  debugLog('openQuotaEntry: 16 轮都没找到稳定的额度行')
  return null
}

/** 关掉菜单/设置面板：Escape 两次，若还有可见弹层就再补一次。 */
async function escapePanel(client) {
  try {
    await pressKey(client, 'Escape')
    await sleep(200)
    await pressKey(client, 'Escape')
    await sleep(200)
    const left = await client.evaluate(VISIBLE_DIALOGS)
    if (left > 0) await pressKey(client, 'Escape')
  } catch {
    /* 连接断了就算了 */
  }
}

/**
 * 只读读额度（读数，不是闸门）：**先试额度页（有 5h/7d 两个窗口），失败就降级**到
 * 账户菜单里那个单窗口数字。降级时返回里带 `degraded: true` 与 `windowsError`，
 * 让调用方知道「只有一个窗口」不是因为页面只有这一个，而是因为没读到页面。
 *
 * 纪律（全程只读，不选任何菜单项、不改任何设置）：
 *   - 找不到入口 → 直接失败，不乱点；
 *   - 菜单/页面没出来 → 失败，不猜数字；
 *   - **无论成败都在 finally 里 Escape**，并确认没有残留可见弹层。
 */
async function readQuota() {
  const fromPage = await readQuotaFromPage().catch((error) => ({ ok: false, error: error.message }))
  if (fromPage.ok === true) return fromPage
  const fromMenu = await readQuotaFromMenu().catch((error) => ({ ok: false, error: error.message }))
  if (fromMenu.ok === true) {
    return { ...fromMenu, degraded: true, windowsError: fromPage.error }
  }
  return { ok: false, error: `${fromPage.error ?? '额度页失败'}；${fromMenu.error ?? '账户菜单也失败'}` }
}

/** 降级路径：只读账户菜单里那一个数字（`当前时段额度用量 N%`）。 */
async function readQuotaFromMenu() {
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')
    const chip = await client.evaluate(QUOTA_CHIP_RECT)
    if (chip === null) {
      return { ok: false, error: '找不到账户/套餐入口（豆包改版了？）' }
    }
    await clickAt(client, chip.x, chip.y)

    let dom = null
    for (let attempt = 0; attempt < 12 && dom === null; attempt += 1) {
      await sleep(250)
      const candidate = await client.evaluate(QUOTA_DOM)
      if (candidate !== null && candidate.menuFound === true) dom = candidate
    }
    if (dom === null) {
      return { ok: false, error: '账户菜单没出现，读不到额度（不猜数字）' }
    }
    if (!Number.isFinite(dom.usedPercent)) {
      return { ok: false, plan: dom.plan || '', error: '菜单里没有找到额度百分比' }
    }
    return {
      ok: true,
      plan: dom.plan || '',
      usedPercent: dom.usedPercent,
      resets: Number.isFinite(dom.resets) ? dom.resets : null,
      at: Date.now(),
    }
  } finally {
    // 关掉菜单——成功也要关（这正是「采样」的代价）。
    try {
      await pressKey(client, 'Escape')
      await sleep(200)
      const left = await client.evaluate(VISIBLE_DIALOGS)
      if (left > 0) await pressKey(client, 'Escape')
    } catch {
      /* 连接断了就算了，进程结束后弹层也会随页面状态变化 */
    }
    client.close()
  }
}

/**
 * 模型菜单里要读的东西：可选模型清单 + 每项的状态标注 + 当前项。
 *
 * 真机实测（豆包 2.x，2026-10-11）：
 *   `豆包 2.1 Lite / 0921 新版`、`豆包 2.1 Pro`、`豆包 2.1 Turbo / 即将下线`
 * 每项是一个「豆包…」开头的行，第二行是标注（新版 / 即将下线）。同样**只读**：
 * 点开菜单 → 读 → finally 里 Escape，不选任何一项。
 */
const MODELS_DOM = `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const control = document.querySelector('[data-testid=chat_input_action_model]');
  const inControl = (el) => control !== null && (el === control || control.contains(el));
  const current = text(control);

  const menus = [...document.querySelectorAll('div')]
    .filter((el) => visible(el) && !inControl(el))
    .map((el) => ({ el, r: el.getBoundingClientRect(), t: text(el) }))
    .filter((x) => (x.t.match(/豆包/g) || []).length >= 2 && x.r.height >= 80 && x.r.height <= 700 && x.r.width >= 120 && x.r.width <= 700)
    .sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  if (menus.length === 0) return { menuFound: false, current, items: [] };

  const rows = [...menus[0].el.querySelectorAll('*')]
    .filter((el) => visible(el) && !inControl(el))
    .map((el) => { const r = el.getBoundingClientRect(); return { t: text(el), r }; })
    .filter((x) => x.t.length > 0 && x.t.length < 48 && x.r.height >= 24 && x.r.height <= 68 && /豆包/.test(x.t))
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);

  const byRow = new Map();
  for (const row of rows) {
    const key = Math.round(row.r.y / 4);
    if (!byRow.has(key)) byRow.set(key, row);
  }
  const items = [...byRow.values()].map((row) => {
    const parts = row.t.split(/\\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    return { name: parts[0] ?? '', note: parts.slice(1).join(' · ') };
  }).filter((item) => item.name.length > 0);
  return { menuFound: true, current, items };
})()`

/** 只读读模型清单。同样是采样：点开菜单、读完关掉（成功也关）。 */
async function readModels() {
  const page = await pickTarget()
  const client = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await client.send('Runtime.enable')
    const control = await client.evaluate(MODEL_CONTROL_RECT)
    if (control === null) {
      return { ok: false, error: '找不到模型控件（豆包改版了？）' }
    }
    await clickAt(client, control.x, control.y)

    let dom = null
    for (let attempt = 0; attempt < 12 && dom === null; attempt += 1) {
      await sleep(250)
      const candidate = await client.evaluate(MODELS_DOM)
      if (candidate !== null && candidate.menuFound === true) dom = candidate
    }
    if (dom === null || dom.items.length === 0) {
      return { ok: false, error: '模型菜单没出现或没有可读项' }
    }
    // 注意：这里是 **Node 侧**的代码，不是送到页面的表达式字符串，
    // 所以换行用 /\n/（页面模板里才要写成 /\\n/）。
    const currentName = String(dom.current).split(/\n/)[0].trim()
    // 同一个模型名会出现多行（行容器 + 内层），按名字去重，优先保留带标注的那条。
    const byName = new Map()
    for (const item of dom.items) {
      const existing = byName.get(item.name)
      if (existing === undefined || (existing.note.length === 0 && item.note.length > 0)) byName.set(item.name, item)
    }
    return {
      ok: true,
      current: currentName,
      items: [...byName.values()].map((item) => ({ ...item, current: item.name === currentName })),
      at: Date.now(),
    }
  } finally {
    try {
      await pressKey(client, 'Escape')
      await sleep(200)
      const left = await client.evaluate(VISIBLE_DIALOGS)
      if (left > 0) await pressKey(client, 'Escape')
    } catch {
      /* 同上 */
    }
    client.close()
  }
}

async function main() {
  // Flags are stripped anywhere in argv so they never reach a command.
  const argv = process.argv.slice(2)
  const flags = new Set()
  const positionalArgs = []
  let modeOverride
  let expectText = ''
  let acceptLength = 0
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--no-preflight' || arg === '--force' || arg === '--json') flags.add(arg)
    else if (arg === '--target' || arg === '--port' || arg === '--match') index += 1 // 已在 earlyTargetArgs 里消费
    else if (arg === '--expect') expectText = String(argv[++index] ?? '')
    else if (arg === '--accept-length') acceptLength = Number(argv[++index] ?? 0)
    else if (arg === '--mode') {
      const value = String(argv[++index] ?? '')
      modeOverride = value === 'chat' || value === 'work' || value === 'unknown' ? { id: value, raw: `--mode ${value}` } : { id: 'unknown', raw: value }
    } else positionalArgs.push(arg)
  }
  const noPreflight = flags.has('--no-preflight')
  const force = flags.has('--force')
  const asJson = flags.has('--json')
  const [command, ...rest] = positionalArgs

  /** 五维识别：模式来自 DOM（或 --mode），其余来自 doubao.mjs。 */
  const identify = async () => {
    if (modeOverride !== undefined) return inspectPreCall({ port: PORT, match: MATCH, mode: modeOverride })
    const probe = await probeDebugPort(PORT)
    const mode = probe.up ? await readMode({ useCache: !flags.has('--no-cache') }) : { id: 'unknown', raw: '' }
    return inspectPreCall({ port: PORT, match: MATCH, mode })
  }

  // doctor: report all five dimensions and exit with the verdict's code.
  if (command === 'doctor') {
    const pre = await identify()
    const connectivity = pre.dimensions.connectivity.ok ? undefined : await inspectDoubao({ port: PORT, match: MATCH })
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ...pre, report: formatPreCallReport(pre) }, null, 2)}\n`)
    } else {
      process.stdout.write(`目标：${TARGET.label} · 端口 ${PORT} · 匹配 ${MATCH}（来源：${TARGET.source}）\n` + `${formatPreCallReport(pre)}\n`)
      // 连通性不过时补上「怎么把豆包带调试参数启起来」那段可操作说明。
      if (connectivity !== undefined) process.stdout.write(`\n${formatDoubaoReport(connectivity)}\n`)
    }
    process.exitCode = PRECHECK_EXIT[pre.verdict]
    return
  }

  // state: 面板要的只读快照（当前模式 + 当前模型）。
  // 刻意**不做调用前识别、也永远退出 0**——它是诊断读数，不是放行闸门：连不上
  // 豆包时正需要它告诉面板「未连接」，所以不能因为 not-ready 就自己失败。
  // 全部只读：读两个 data-testid 的文字，不点、不改。
  if (command === 'state') {
    const snapshot = {
      connected: false,
      mode: 'unknown',
      modeRaw: '',
      capability: 'unknown',
      model: '',
      modelLevel: '',
      at: Date.now(),
    }
    const probe = await probeDebugPort(PORT)
    if (probe.up) {
      try {
        const dom = await readStateViaCdp()
        const mode = mapModeText(dom?.modeText)
        const { model, level } = splitModelText(dom?.modelFull, dom?.modelLevel)
        snapshot.connected = true
        snapshot.mode = mode.id
        snapshot.modeRaw = mode.raw
        snapshot.capability = commandCapability(mode.id)
        snapshot.model = model
        snapshot.modelLevel = level
        // 上下文用量并进快照（同一次 evaluate 里读的，几乎是零代价）。
        // 读不到就带 reason（没开对话 / 这台没有），绝不猜数字——猜错比没有更糟。
        const usage = parseContextUsage(dom?.usage)
        snapshot.usage = {
          percent: usage.percent,
          found: usage.found,
          reason: usage.reason ?? null,
          contextOpen: usage.contextOpen === true,
        }
      } catch (error) {
        snapshot.error = error.message
      }
    } else {
      snapshot.error = probe.detail
    }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
    } else {
      process.stdout.write(
        [
          `连通性   : ${snapshot.connected ? '通' : `不通（${snapshot.error ?? '未知'}）`}`,
          `模式     : ${snapshot.modeRaw || snapshot.mode}（${snapshot.mode}）`,
          `命令能力 : ${snapshot.capability}`,
          `模型     : ${snapshot.model || '(读不到)'}${snapshot.modelLevel ? ` · 档位 ${snapshot.modelLevel}` : ''}`,
        ].join('\n') + '\n',
      )
    }
    return
  }

  // mode <work|chat>: 切换豆包的工作模式。**写操作**（点它的 UI），所以：
  //   - 也放在通用预检之前：预检要求在「工作模式」才放行，而切模式恰恰是模式不对
  //     的时候才要用的，用它自己的闸门挡住自己就没意义了；
  //   - 自己先探连通性，连不上就明确报「豆包没在跑」，绝不空转；
  //   - 成败一律以**只读复核**为准（见 switchMode）。
  if (command === 'mode') {
    const target = String(rest[0] ?? '').trim()
    if (target !== 'work' && target !== 'chat') {
      process.stderr.write('usage: cdp.mjs mode <work|chat> [--json]\n')
      process.exitCode = 1
      return
    }
    const probe = await probeDebugPort(PORT)
    let result
    if (!probe.up) {
      result = {
        ok: false,
        changed: false,
        modeBefore: 'unknown',
        error: `豆包没在跑或没开调试端口（${probe.detail}）`,
      }
    } else {
      try {
        result = await switchMode(target)
      } catch (error) {
        result = { ok: false, changed: false, modeBefore: 'unknown', error: error.message }
      }
    }
    const payload = { ...result, target, at: Date.now() }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else if (payload.ok) {
      process.stdout.write(
        payload.changed
          ? `模式已切换：${payload.modeBefore} → ${payload.modeAfter}${payload.option ? `（点了「${payload.option}」）` : ''}\n`
          : `本来就是 ${payload.modeAfter}，没有动它\n`,
      )
    } else {
      process.stdout.write(`切换失败：${payload.error}\n`)
    }
    process.exitCode = payload.ok ? 0 : 1
    return
  }

  // quota / models: **只读采样**——必须点开一次菜单才读得到（额度在账户菜单里，
  // 模型清单在模型菜单里），读完立刻关掉。与 state 一样不走通用预检：预检会因为
  // 「有未终结 job」而拒绝，而额度/模型清单跟忙不忙无关。
  // 失败一律退 1 并说明原因，绝不猜一个数字/编一份清单。
  if (command === 'quota' || command === 'models') {
    const probe = await probeDebugPort(PORT)
    let result
    if (!probe.up) {
      result = { ok: false, error: `豆包没在跑或没开调试端口（${probe.detail}）` }
    } else {
      try {
        result = command === 'quota' ? await readQuota() : await readModels()
      } catch (error) {
        result = { ok: false, error: error.message }
      }
    }
    const payload = { ...result, command, at: Number.isFinite(result.at) ? result.at : Date.now() }
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else if (command === 'quota') {
      if (payload.ok !== true) {
        process.stdout.write(`读不到额度：${payload.error}\n`)
      } else if (Array.isArray(payload.windows) && payload.windows.length > 0) {
        const lines = payload.windows.map(
          (window) => `  ${window.short}  ${window.usedText}${window.resetText ? `  （${window.resetText}）` : ''}`,
        )
        const resets = Number.isFinite(payload.resets) ? `\n  可重置 ${payload.resets} 次` : ''
        const degraded = payload.degraded === true ? `\n  （降级：只读到账户菜单那一个数字——${payload.windowsError ?? ''}）` : ''
        process.stdout.write(`额度${payload.plan ? `（${payload.plan}）` : ''}：\n${lines.join('\n')}${resets}${degraded}\n`)
      } else {
        process.stdout.write(
          `额度：${payload.usedPercent}%${payload.plan ? `（${payload.plan}）` : ''}${Number.isFinite(payload.resets) ? ` · 剩余重置 ${payload.resets} 次` : ''}\n`,
        )
      }
    } else {
      process.stdout.write(
        payload.ok
          ? `模型（当前 ${payload.current}）：\n${payload.items
              .map((item) => `  ${item.current ? '*' : ' '} ${item.name}${item.note ? `  ${item.note}` : ''}`)
              .join('\n')}\n`
          : `读不到模型清单：${payload.error}\n`,
      )
    }
    process.exitCode = payload.ok ? 0 : 1
    return
  }

  if (!noPreflight) {
    const pre = await identify()
    if (pre.verdict !== 'ready') {
      if (!force) {
        process.stderr.write(`${formatPreCallReport(pre)}\n`)
        process.exitCode = PRECHECK_EXIT[pre.verdict]
        return
      }
      // --force：放行，但必须留痕，便于事后回答「为什么这次没拦住」。
      const config = loadConfig()
      await recordOverride(
        { job: `precheck-${new Date().toISOString()}`, message: pre.reasons.join('；'), reason: 'forced before call' },
        config,
      ).catch(() => {})
      process.stderr.write(`warning: --force 跳过调用前识别（${pre.verdict}）：${pre.reasons.join('；')}\n`)
      process.stderr.write('         已在状态文件里留了一条 override 记录\n')
    }
  }

  if (command === 'targets') {
    const targets = await listTargets()
    for (const target of targets) {
      process.stdout.write(`[${target.type}] ${target.title}\n    ${target.url}\n`)
    }
    return
  }

  const target = await pickTarget()
  const client = await Cdp.connect(target.webSocketDebuggerUrl)
  await client.send('Runtime.enable')

  try {
    if (command === 'probe') {
      process.stdout.write(`${await client.evaluate(PROBE_INPUT)}\n`)
    } else if (command === 'eval') {
      process.stdout.write(`${JSON.stringify(await client.evaluate(rest.join(' ')), null, 2)}\n`)
    } else if (command === 'usage' || command === 'context') {
      // 上下文用量：纯读，不开菜单。个人版页面上没有这个控件 → 如实说「这台 App 没有」。
      const parsed = parseContextUsage(await client.evaluate(CONTEXT_USAGE))
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ ...parsed, target: TARGET.name, port: PORT, at: Date.now() }, null, 2)}\n`)
      } else if (parsed.found === false) {
        // 分两种情况说清楚：没有打开的对话 ≠ 这台 App 没有这个控件
        if (parsed.reason === 'no-open-conversation') {
          process.stdout.write(`读不到上下文用量：${TARGET.label} 现在没有打开的对话——这个圆环只在打开的对话里出现（先打开一个对话再读）\n`)
        } else {
          process.stdout.write(`这台 App 的页面上没有上下文用量控件（${TARGET.label}）\n`)
        }
      } else if (parsed.percent === null) {
        process.stdout.write(`找到控件但读不出角度：${(parsed.label ?? '')}\n`)
      } else {
        process.stdout.write(`${parsed.label}：${parsed.percent}%（圆环 ${parsed.angleDeg}°）· ${TARGET.label}\n`)
      }
      // 读不到就退 3（与 doctor 的「未就绪」同一语义），别装作 0%
      if (parsed.found === false || parsed.percent === null) process.exitCode = 3
    } else if (command === 'context-window' || command === 'panel') {
      // 点开圆环 → 读面板 → 再点一次收起（同一按钮 toggle）。
      // 面板里有**上下文明细**，还有**账户额度**（当前时段 / 近 7 天，计数形式）——
      // 比「设置 → 订阅与额度」那条会闪菜单的长链轻得多。
      const opened = await client.evaluate(CONTEXT_PANEL_TOGGLE)
      if (opened === 'no-button') {
        process.stdout.write(`没有上下文用量控件（${TARGET.label}）：它只在打开的对话里出现\n`)
        process.exitCode = 3
      } else {
        await sleep(1_200)
        const text = await client.evaluate(CONTEXT_PANEL_TEXT)
        await client.evaluate(CONTEXT_PANEL_TOGGLE) // 收起，别把面板留在人家界面上
        const panel = parseContextPanel(text)
        if (asJson) {
          process.stdout.write(`${JSON.stringify({ ...panel, target: TARGET.name, port: PORT, at: Date.now() }, null, 2)}\n`)
        } else if (panel.found !== true) {
          process.stdout.write(`点开了但读不到面板内容（${TARGET.label}）\n`)
        } else {
          const ctx = panel.context
          process.stdout.write(`上下文用量：${ctx === null ? '读不到' : `${ctx.used}/${ctx.total} · ${ctx.percent}%`} · ${TARGET.label}\n`)
          if (panel.breakdown.length > 0) process.stdout.write(`  明细：${panel.breakdown.map((b) => `${b.label} ${b.percent}%`).join(' · ')}\n`)
          if (panel.quota.session !== null) {
            process.stdout.write(`  额度·当前时段：已用 ${panel.quota.session.used}/${panel.quota.session.limit}${panel.quota.session.resetText.length > 0 ? `（${panel.quota.session.resetText} 后重置）` : ''}\n`)
          }
          if (panel.quota.week !== null) process.stdout.write(`  额度·近 7 天：已用 ${panel.quota.week.used}/${panel.quota.week.limit}\n`)
        }
        if (panel.found !== true) process.exitCode = 3
      }
    } else if (command === 'account' || command === 'login') {
      // 连接/登录状态：真实鼠标点头像 → 读弹层 → Esc 收起。
      const rect = await client.evaluate(ACCOUNT_AVATAR_RECT)
      if (rect === 'no-avatar') {
        process.stdout.write(`没有账号头像控件（${TARGET.label}）：可能未登录或界面不同\n`)
        process.exitCode = 3
      } else {
        const point = JSON.parse(rect)
        await clickAt(client, point.x, point.y)
        await sleep(1200)
        const text = await client.evaluate(ACCOUNT_PANEL_TEXT)
        for (const type of ['keyDown', 'keyUp']) {
          await client.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
        }
        const lines = String(text ?? '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line !== '---' && line.length < 60)
        // 菜单里那条是「退出登录|账号名」：账号名在**竖线之后**；套餐在别的行（含「套餐」）。
        const head = lines.find((line) => line.includes('|')) ?? ''
        const parts = head.split('|').map((part) => part.trim()).filter((part) => part.length > 0)
        const name = parts.length > 0 ? parts[parts.length - 1] : ''
        const plan = lines.find((line) => line.includes('套餐')) ?? ''
        const loggedIn = name.length > 0 && name !== '退出登录'
        const payload = { loggedIn, account: name ?? '', plan: plan ?? '', lines: lines.slice(0, 6), target: TARGET.name, port: PORT, at: Date.now() }
        if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
        else if (!loggedIn) process.stdout.write(`${TARGET.label}：没读到账号信息（可能未登录）\n`)
        else process.stdout.write(`${TARGET.label} 账号：${payload.account}${payload.plan.length > 0 ? `（${payload.plan}）` : ''}\n`)
        if (!loggedIn) process.exitCode = 3
      }
    } else if (command === 'send') {
      const text = rest.join(' ')
      if (text.trim().length === 0) throw new Error('send needs text')
      const before = await client.evaluate(COUNT_USER)
      const focused = await client.evaluate(FOCUS_INPUT)
      if (focused === 'NO_INPUT') throw new Error('no visible editable element found in the chat page')
      // 发送前先清空输入框：上一次的残留如果还在，insertText 会**叠加**进同一段文本，
      // 于是同一条消息被拼长、或被重复提交（可靠性测试里就撞到过这个现象）。
      const leftover = String((await client.evaluate(COMPOSER_TEXT)) ?? '').trim()
      if (leftover.length > 0) {
        for (const type of ['keyDown', 'keyUp']) {
          await client.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
        }
        for (const type of ['keyDown', 'keyUp']) {
          await client.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
        }
        await sleep(200)
      }
      await client.send('Input.insertText', { text })
      await sleep(400)

      // Enter does not submit in the ProseMirror composer; the send button does.
      const button = await client.evaluate(FIND_SEND_BUTTON)
      if (button !== null) {
        const { x, y } = JSON.parse(button)
        await clickAt(client, x, y)
      } else {
        for (const type of ['keyDown', 'keyUp']) {
          await client.send('Input.dispatchKeyEvent', {
            type,
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
          })
        }
      }

      // Confirm the message actually left the composer instead of trusting the
      // click. Counting user-message elements is not enough on its own: work
      // mode renders the newest message differently, so the count can lag even
      // though the text was submitted. An empty composer is the real invariant.
      let submitted = false
      let lastComposer = ''
      let newMessages = 0
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await sleep(500)
        const counted = Number(await client.evaluate(COUNT_USER)) - Number(before)
        lastComposer = await client.evaluate(COMPOSER_TEXT)
        newMessages = Number.isFinite(counted) ? counted : 0
        if (newMessages >= 1 || lastComposer.trim().length === 0) {
          submitted = true
          break
        }
      }
      if (!submitted) {
        throw new Error(`message was not submitted (composer still holds: ${JSON.stringify(lastComposer.slice(0, 40))})`)
      }
      // 判据要能抓「重复提交」：一次 send 只允许新增 1 条消息。多出来的必须报错，
      // 不能像以前那样只看「> before」——那样发重了也会被当成功。
      if (newMessages > 1) {
        throw new Error(`检测到重复提交：一次 send 新增了 ${newMessages} 条消息（before=${before}，请检查发送按钮是否被连点或输入框有残留）`)
      }
      // 注意：work 模式下这个计数**不可靠**（虚拟列表会让旧消息元素消失，delta 可能为 0 甚至负数）。
      // 所以只在 delta === 1 时才敢说「新增 1 条」，否则明说不可靠——绝不把 -1 当成正常输出。
      const countNote = newMessages === 1 ? '新增 1 条' : newMessages > 1 ? `新增 ${newMessages} 条` : '条数不可靠（work 模式虚拟列表，以「输入框已清空」判提交）'
      process.stdout.write(`sent via ${button !== null ? 'send button' : 'Enter'}: ${text.slice(0, 60)}（${countNote}）\n`)
    } else if (command === 'wait') {
      const timeoutMs = Number(rest[0] ?? 120000)
      const deadline = Date.now() + timeoutMs

      // Phase 1: the conversation must end with an assistant message.
      while (Date.now() < deadline) {
        if ((await client.evaluate(TURN_STATE)) === 'answered') break
        await sleep(1000)
      }
      if ((await client.evaluate(TURN_STATE)) !== 'answered') {
        process.stdout.write(`still awaiting a reply after ${timeoutMs} ms\n`)
        process.exitCode = 2
        return
      }

      // Phase 2: wait for the text to stop changing, so a streaming reply is
      // not reported half-finished. A thinking placeholder is stable too, so it
      // must never count as the answer — work mode parks "正在思考" in the
      // assistant slot while the real reply is still being produced.
      let previous = ''
      let stableReads = 0
      let placeholderSeen = false
      while (Date.now() < deadline) {
        const current = await client.evaluate(LAST_ASSISTANT)
        if (isPlaceholder(current)) {
          placeholderSeen = true
          previous = current
          stableReads = 0
          await sleep(1500)
          continue
        }
        if (current.length > 0 && current === previous) {
          stableReads += 1
          if (stableReads >= 2) {
            // `--expect <文本>`：**只认带这次任务标记的答复**。稳定但没出现标记的文本
            // 多半是中间态（work 模式会先出很短的过渡消息），不能当结果 —— 继续等。
            const matchedExpect = expectText.length === 0 || current.includes(expectText)
            const longEnough = acceptLength > 0 && current.length >= acceptLength
            if (!matchedExpect && !longEnough) {
              stableReads = 0
              await sleep(1000)
              continue
            }
            if (expectText.length > 0 && !current.includes(expectText) && longEnough) {
              process.stderr.write("(标记没出现，但答复已稳定且达到 --accept-length，按长度判据接受)\n")
            }
            if (placeholderSeen) process.stderr.write('(a thinking placeholder was skipped; waited for the real reply)\n')
            process.stdout.write(`${current}\n`)
            return
          }
        } else {
          stableReads = 0
        }
        previous = current
        await sleep(1500)
      }
      if (expectText.length > 0) {
        process.stdout.write(`reply never contained the expected text within ${timeoutMs} ms; last text:\n${previous}\n`)
      } else {
        process.stdout.write(`reply did not settle within ${timeoutMs} ms; last text:\n${previous}\n`)
      }
      process.exitCode = 2
    } else if (command === 'key') {
      // Native key events. Synthetic KeyboardEvent dispatched from page JS is
      // ignored by the app's shortcut handler, so this goes through CDP input.
      const keyName = rest[0]
      if (keyName === undefined) throw new Error('key needs a key name, e.g. key Escape --ctrl --shift')
      const flags = new Set(rest.slice(1))
      const modifiers =
        (flags.has('--alt') ? 1 : 0) |
        (flags.has('--ctrl') ? 2 : 0) |
        (flags.has('--meta') ? 4 : 0) |
        (flags.has('--shift') ? 8 : 0)
      const isLetter = keyName.length === 1
      const code = isLetter ? `Key${keyName.toUpperCase()}` : keyName
      const virtualKey = isLetter ? keyName.toUpperCase().charCodeAt(0) : keyName === 'Escape' ? 27 : 0
      for (const type of ['keyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', {
          type,
          modifiers,
          key: isLetter && flags.has('--shift') ? keyName.toUpperCase() : keyName,
          code,
          windowsVirtualKeyCode: virtualKey,
          nativeVirtualKeyCode: virtualKey,
        })
        await sleep(80)
      }
      process.stdout.write(`key ${keyName} modifiers=${modifiers}\n`)
    } else if (command === 'click') {
      const x = Number(rest[0])
      const y = Number(rest[1])
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('click needs x y')
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1,
        })
        await sleep(80)
      }
      process.stdout.write(`clicked ${x},${y}\n`)
    } else if (command === 'read') {
      const count = Number(rest[0] ?? 6)
      const messages = JSON.parse(await client.evaluate(READ_MESSAGES(count)))
      for (const message of messages) {
        process.stdout.write(`--- ${message.role} ---\n${message.text}\n`)
      }
      process.stdout.write(`(${messages.length} message(s))\n`)
    } else {
      process.stdout.write('usage: cdp.mjs <command> [--target personal|work] [--port <n>] [--match <s>] [--json]\n  doctor | state | mode <work|chat> | quota | models | targets | probe | send <text> | read [n] | eval <js>\n  目标：personal = 豆包个人版 9222（默认）· work = 豆包工作 9223（doubaowork-chat/chat）\n')
    }
  } finally {
    client.close()
  }
}

/** 入口守卫：被 import 时不要执行 main()（测试要导入 isPlaceholder）。 */
const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`)
    process.exit(1)
  })
}
