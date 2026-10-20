#!/usr/bin/env node
/**
 * doubao-status-panel 的密封测试 —— 不需要 DSH，也不需要豆包。
 *
 * 验的是验收标准里那几条「只信副作用」的硬要求：
 *   1. received 折叠正确：只有 received、还没 started 的 job 也要出现在列表里；
 *   2. 接口只读：POST/PUT/DELETE/PATCH 一律 405，而且**没有触发任何读取**（无副作用）；
 *   3. 不新增端口：只注册一条相对路径的 exact 路由，宿主半源码里没有 listen/createServer；
 *   4. 读文件的失败不会伪装成崩溃，也不会伪装成「没有任务」；
 *   5. 清单/补丁/客户端半的关键形态没写错（模块装载器 id、try/catch 兜底、无 DSH 客户端依赖）。
 *
 * Usage: node panel-selftest.mjs
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStatusRoutes, createDoubaoStateCache, createModeRoutes, createSerialQueue, isLoopbackAddress, isLoopbackRequest, parseDoubaoModels, parseDoubaoQuota, parseDoubaoState, parseModeSwitch, parseSampleQuery, readDoubaoConnectorClients, readPanelJobs, resolveStatusEnv, DOUBAO_MODELS_TTL_MS, DOUBAO_QUOTA_TTL_MS, MODE_SWITCH_VALUES, STATUS_API_PATH, STATUS_MODE_PATH } from './index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------ 客户端渲染台架 */

/**
 * 用**假 React** 把 `client.js` 真跑起来，然后对渲染出的节点树做断言。
 *
 * 为什么值得写这 80 行：界面行数/进度条这种东西，只 grep 源码是验不出来的——
 * 真机上已经吃过一次「以为会自动出现第三行」的亏（其实是任务行只在有 job 时出现）。
 * 这里不测像素，但能测「给定接口返回，组件到底渲染出几条线、几条进度条、值是多少」，
 * 而这正是那次误会所在的那一层。
 *
 * 台架约束：
 *   - `window.__ModuleLoader__.load` 被替换成捕获工厂；
 *   - `require('react')` 换成假 React（createElement + 足以跑一次的 hooks）；
 *   - `fetch` 换成假实现；`setInterval` 换成 no-op（否则会拖住进程）；
 *   - effect 立即执行一次，然后等一轮微任务让假 fetch 落定，再重渲染一次。
 */
function flattenChildren(children) {
  const out = []
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flattenChildren(child))
    else if (child !== null && child !== undefined && child !== false) out.push(child)
  }
  return out
}

function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walkTree(child, visit)
}

/** 收集树里所有 role=progressbar 的节点（返回它们的 props 与填充条宽度/粗细）。 */
function collectBars(tree) {
  const bars = []
  walkTree(tree, (node) => {
    if (node.props?.role !== 'progressbar') return
    const fill = (node.children ?? [])[0]
    bars.push({
      value: node.props['aria-valuenow'],
      label: node.props['aria-label'],
      height: node.props?.style?.height,
      fillWidth: fill?.props?.style?.width,
      fillColor: fill?.props?.style?.background,
    })
  })
  return bars
}

/** 收集树里所有的文本行（每行 = 色点 + 文本）。 */
function collectLineTexts(tree) {
  const texts = []
  walkTree(tree, (node) => {
    if (node.type !== 'span') return
    const content = (node.children ?? []).filter((child) => typeof child === 'string')
    if (content.length === 1) texts.push(content[0])
  })
  return texts
}

/**
 * 加载 client.js 并渲染一次徽章。
 * @param payload 假接口返回的 JSON
 */
function renderBadge(payload, { samplePref } = {}) {
  const source = readFileSync(join(HERE, 'client.js'), 'utf8')
  const hooks = { state: [], refs: [], cursor: 0 }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: flattenChildren(children) }),
    useState: (initial) => {
      const index = hooks.cursor++
      if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? initial() : initial
      return [
        hooks.state[index],
        (next) => {
          hooks.state[index] = typeof next === 'function' ? next(hooks.state[index]) : next
        },
      ]
    },
    useEffect: (fn) => {
      fn()
    },
    useRef: (initial) => {
      const index = hooks.cursor++
      if (!(index in hooks.refs)) hooks.refs[index] = { current: initial }
      return hooks.refs[index]
    },
    useCallback: (fn) => fn,
  }

  const storage = new Map()
  if (samplePref !== undefined) storage.set('doubao-status-panel:sample', samplePref)
  const window = {
    __ModuleLoader__: { load: (definition) => modules.push(definition) },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
  }
  const modules = []
  const requested = []
  const fakeFetch = async (url) => {
    requested.push(url)
    return { ok: true, status: 200, json: async () => payload }
  }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  }

  // client.js 不是 ESM（顶层直接调 window.__ModuleLoader__.load），所以用 Function 包一层。
  const load = new Function('window', 'fetch', 'setInterval', 'clearInterval', 'require', source)
  load(window, fakeFetch, () => 0, () => {}, require)

  const registered = {}
  const fakeCtx = {
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => {
        registered[options.id] = component
        return () => {}
      },
    },
  }
  modules[0].factory(require).apply(fakeCtx)

  const render = () => {
    hooks.cursor = 0
    return registered['doubao-status-panel']({ wide: true })
  }
  let tree = render() // 第一遍：effect 跑一次，发起假 fetch
  return {
    requested,
    // 等假 fetch 落定后再渲染一遍（调用方 await）
    settle: async () => {
      // 先让一个宏任务落地：这会把所有待处理的微任务（假 fetch → json → setData 的
      // promise 链）全部冲干净。只 await 几个 Promise.resolve() 是不够的——
      // 那正是我第一版踩的坑：条数全为 0，详情里第二次 settle 才拿到数据。
      await new Promise((resolve) => setTimeout(resolve, 0))
      tree = render()
      return tree
    },
    renderedIds: Object.keys(registered),
    /** 渲染独立的「豆包」设置页（`settings.section` 那一项；宿主只给 close）。 */
    renderSection: async () => {
      hooks.cursor = 0
      registered['doubao']({ close: () => {} })
      await new Promise((resolve) => setTimeout(resolve, 0))
      hooks.cursor = 0
      return registered['doubao']({ close: () => {} })
    },
  }
}

let failures = 0
function check(name, ok, detail = '') {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail.length > 0 ? `\n      ${detail}` : ''}\n`)
}

/** node:http 响应的最小替身：只记录 writeHead/end。 */
function fakeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

/** 一个「来自本机」的请求替身（名称/头部可覆盖，用来演同网段来源）。 */
function fakeReq(method = 'GET', overrides = {}) {
  const { body, ...rest } = overrides
  const listeners = {}
  const req = {
    method,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:43120' },
    ...rest,
    on(event, handler) {
      listeners[event] = [...(listeners[event] ?? []), handler]
      return req
    },
    setEncoding() {},
    destroy() {},
  }
  if (typeof body === 'string') {
    // 真实请求体是流：readJsonBody 会同步注册监听，所以事件放到微任务里推。
    queueMicrotask(() => {
      if (body.length > 0) for (const handler of listeners.data ?? []) handler(body)
      for (const handler of listeners.end ?? []) handler()
    })
  }
  return req
}

/** 直接往状态文件追加事件（和 status.mjs 的落盘格式一致）。 */
function writeEvents(file, events) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8')
}

async function main() {
  process.stdout.write(`doubao-status-panel selftest (node ${process.version}, platform ${process.platform})\n`)

  const scratch = mkdtempSync(join(tmpdir(), 'panel-selftest-'))
  const savedQueue = process.env.DSH_QUEUE_FILE
  const queueFile = join(scratch, 'default', 'tasks.jsonl')
  const statusFile = join(scratch, 'default', 'status.jsonl')
  process.env.DSH_QUEUE_FILE = queueFile

  try {
    // ---------------------------------------------------------- 静态形态（清单）
    const manifest = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
    check(
      '清单声明了 bundle patch 与 web 客户端半',
      manifest.dsh?.bundle?.patch === './cordis.patch.yml' && manifest.dsh?.client?.platform === 'web',
      JSON.stringify(manifest.dsh ?? null),
    )
    check(
      'client inject 指向槽的声明者（ui-sidebar）',
      (manifest.dsh?.client?.inject ?? []).includes('@deepseek-ai/dsh-client-ui-sidebar'),
      JSON.stringify(manifest.dsh?.client?.inject ?? null),
    )
    check(
      'exports 同时给出宿主半与客户端半',
      manifest.exports?.['.'] === './index.js' && manifest.exports?.['./client'] === './client.js',
      JSON.stringify(manifest.exports ?? null),
    )
    check('声明了 type: module（宿主半是 ESM）', manifest.type === 'module')
    check('private 包不会被误发布', manifest.private === true)

    const patch = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
    check(
      '补丁插入的插件行名与包名一致',
      patch.includes('insert') && patch.includes(`'${manifest.name}'`),
      patch.trim().split('\n').join(' | '),
    )

    // ---------------------------------------------------------- 不新增端口
    const hostSource = readFileSync(join(HERE, 'index.js'), 'utf8')
    check('宿主半没有起任何监听（不新增端口）', !/createServer|\.listen\s*\(/.test(hostSource))
    check('宿主半不 import 任何 DSH 运行时包', !/from\s+['"]@deepseek-ai\//.test(hostSource))
    const clientSource = readFileSync(join(HERE, 'client.js'), 'utf8')
    check(
      '客户端半是模块装载器格式，且 id 与包名一致',
      clientSource.includes('__ModuleLoader__.load') && clientSource.includes(`id: '${manifest.name}'`),
    )
    check('客户端半的槽注册有 try/catch 兜底（注册失败不带崩界面）', (clientSource.match(/catch/g) ?? []).length >= 2)
    check('客户端半不 import DSH 客户端包', !/from\s+['"]@deepseek-ai\//.test(clientSource))

    // ---------------------------------------------------------- 路径解析
    // 真机实测：DSH Web 宿主进程没有 DSH_HOME，插件会去读 ~/.dsh-mcp-connector，
    // 而豆包桥写的是 ~/.dsh/mcp-connector —— 接口 200 但面板永远空。
    check(
      '缺省 env 时补上 DSH 默认 home（否则读错目录）',
      resolveStatusEnv({}).DSH_HOME === join(homedir(), '.dsh'),
      String(resolveStatusEnv({}).DSH_HOME),
    )
    check('显式 DSH_HOME 不被覆盖', resolveStatusEnv({ DSH_HOME: 'D:/custom' }).DSH_HOME === 'D:/custom')
    const withQueue = resolveStatusEnv({ DSH_QUEUE_FILE: 'D:/q/tasks.jsonl' })
    check(
      '显式 DSH_QUEUE_FILE 时不动 DSH_HOME（用户说了算）',
      withQueue.DSH_QUEUE_FILE === 'D:/q/tasks.jsonl' && withQueue.DSH_HOME === undefined,
      JSON.stringify(withQueue),
    )

    // ---------------------------------------------------------- 路由形状
    // 运行时快照的替身：密封测试不 spawn cdp.mjs、更不碰真豆包。
    const fakeState = {
      connected: true,
      mode: 'work',
      modeRaw: '本地电脑',
      capability: 'yes',
      model: '豆包 2.1 Lite',
      modelLevel: '低',
      at: 0,
    }
    // 额度/模型采样的替身（真实现会点开豆包菜单，测试里绝不能碰）。
    const fakeQuota = { ok: true, usedPercent: 12, plan: '示例套餐', resets: 3, at: 0 }
    const fakeModels = {
      ok: true,
      current: '豆包 2.1 Lite',
      items: [
        { name: '豆包 2.1 Lite', note: '0921 新版', current: true },
        { name: '豆包 2.1 Turbo', note: '即将下线', current: false },
      ],
      at: 0,
    }
    const sampleSeams = {
      readState: async () => fakeState,
      readQuota: async () => fakeQuota,
      readModels: async () => fakeModels,
    }
    const routes = createStatusRoutes(sampleSeams)
    check('只注册一条路由', routes.length === 1, `n=${routes.length}`)
    const [route] = routes
    check('路由是 exact 精确匹配', route.kind === 'exact')
    check(
      '路径是相对路径（复用 DSH 自己的端口，而不是另开）',
      route.path === STATUS_API_PATH && route.path.startsWith('/') && !/^[a-z]+:\/\//i.test(route.path),
      route.path,
    )

    // ---------------------------------------------------------- 折叠（真实文件）
    const now = Date.now()
    writeEvents(statusFile, [
      { v: 1, type: 'status', job: 'P-1', state: 'received', at: now - 9000, message: '派发器已送出指令，等待豆包开工' },
      { v: 1, type: 'status', job: 'P-1', state: 'started', at: now - 7000 },
      { v: 1, type: 'status', job: 'P-1', state: 'progress', at: now - 3000, percent: 40, step: '拉取' },
      { v: 1, type: 'status', job: 'P-2', state: 'received', at: now - 8000 },
      { v: 1, type: 'status', job: 'P-3', state: 'done', at: now - 2000, message: '完成' },
      { v: 1, type: 'status', job: 'P-4', state: 'failed', at: now - 500_000, message: '很久以前失败' },
    ])

    const res = fakeRes()
    await route.handler(fakeReq('GET'), res)
    check(
      'GET 返回 200 + JSON',
      res.status === 200 && String(res.headers?.['content-type']).startsWith('application/json'),
      `${res.status} ${res.headers?.['content-type']}`,
    )
    const body = JSON.parse(res.body)
    check('响应标 ok 并给出状态文件路径（路径不一致时能一眼看出来）', body.ok === true && body.file === statusFile, `${body.ok} ${body.file}`)
    check('响应带上 ini 告警（配置有问题时看得见）', Array.isArray(body.warnings))
    check(
      '响应带上豆包运行时快照：模式 + 模型（面板据此显示「工作模式 / 模型名」）',
      body.doubao?.connected === true &&
        body.doubao?.mode === 'work' &&
        body.doubao?.modeRaw === '本地电脑' &&
        body.doubao?.capability === 'yes' &&
        body.doubao?.model === '豆包 2.1 Lite' &&
        body.doubao?.modelLevel === '低',
      JSON.stringify(body.doubao ?? null),
    )
    const byJob = new Map(body.jobs.map((job) => [job.job, job]))
    check(
      '进行中的 job：state=progress 且 phase=started',
      byJob.get('P-1')?.state === 'progress' && byJob.get('P-1')?.phase === 'started',
      JSON.stringify(byJob.get('P-1') ?? null),
    )
    check(
      'percent / step / 最早的 message 都带上了',
      byJob.get('P-1')?.percent === 40 && byJob.get('P-1')?.step === '拉取' && byJob.get('P-1')?.message === '派发器已送出指令，等待豆包开工',
      JSON.stringify(byJob.get('P-1') ?? null),
    )
    check(
      '只有 received、还没 started 的 job 也显示（phase=received）',
      byJob.get('P-2')?.state === 'received' && byJob.get('P-2')?.phase === 'received' && byJob.get('P-2')?.terminal === false,
      JSON.stringify(byJob.get('P-2') ?? null),
    )
    check(
      '刚完成的 job 留在列表里（让「已完成」看得见）',
      byJob.get('P-3')?.state === 'done' && byJob.get('P-3')?.terminal === true,
      JSON.stringify(byJob.get('P-3') ?? null),
    )
    check('很久以前结束的 job 不出现（这不是历史列表）', byJob.has('P-4') === false)
    check(
      '按 lastAt 升序（最后一条 = 最近发生的）',
      body.jobs.every((job, index, list) => index === 0 || (list[index - 1].lastAt ?? 0) <= (job.lastAt ?? 0)),
      body.jobs.map((job) => `${job.job}:${job.lastAt}`).join(' '),
    )

    // readPanelJobs 直接调用也要能工作（宿主半的公开面）
    const direct = await readPanelJobs()
    check('readPanelJobs 直接可调用（接口只是它的薄包装）', direct.jobs.length === 3 && direct.file === statusFile, `n=${direct.jobs.length}`)

    // ---------------------------------------------------------- 只读
    let readerCalled = 0
    const [readonlyRoute] = createStatusRoutes({
      read: () => {
        readerCalled += 1
        return { file: statusFile, now: 0, jobs: [] }
      },
    })
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const rejected = fakeRes()
      await readonlyRoute.handler(fakeReq(method), rejected)
      check(
        `${method} 返回 405 + Allow: GET（只读）`,
        rejected.status === 405 && rejected.headers?.allow === 'GET',
        `${method} -> ${rejected.status} allow=${rejected.headers?.allow}`,
      )
    }
    check('被拒的写请求没有触发任何读取（没有副作用）', readerCalled === 0, `readerCalled=${readerCalled}`)
    const allowed = fakeRes()
    await readonlyRoute.handler(fakeReq('GET'), allowed)
    check('GET 仍然可用', allowed.status === 200 && readerCalled === 1, `status=${allowed.status} called=${readerCalled}`)

    // ---------------------------------------------------------- 来源围栏
    // 真机实测：web 服务监听 0.0.0.0，而 GUI 页面本身对非本机访问要鉴权（GET / → 401）。
    // 插件路由跑在鉴权之前，所以只读路由也必须自己围栏，否则等于绕过鉴权。
    check(
      '回环判定：127.0.0.1 / ::1 / IPv4-mapped / 127.0.0.2',
      ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.2'].every((address) => isLoopbackAddress(address)),
    )
    check('回环判定：同网段地址不是回环', !isLoopbackAddress('192.168.1.50') && !isLoopbackAddress(undefined))
    check('请求围栏：本机 socket + 本机 Host 放行', isLoopbackRequest(fakeReq()))
    check(
      '请求围栏：LAN socket 拒绝',
      !isLoopbackRequest(fakeReq('GET', { socket: { remoteAddress: '192.168.1.50' } })),
    )
    check(
      '请求围栏：本机 socket 但 Host 是 LAN 地址也拒绝（绕过鉴权的典型形态）',
      !isLoopbackRequest(fakeReq('GET', { headers: { host: '192.168.1.50:43120' } })),
    )
    check(
      '请求围栏：跨站标记拒绝',
      !isLoopbackRequest(fakeReq('GET', { headers: { host: '127.0.0.1:43120', 'sec-fetch-site': 'cross-site' } })),
    )
    check(
      '请求围栏：同源 Origin 放行',
      isLoopbackRequest(fakeReq('GET', { headers: { host: '127.0.0.1:43120', origin: 'http://127.0.0.1:43120' } })),
    )

    let lanReaderCalled = 0
    const [lanRoute] = createStatusRoutes({
      read: () => {
        lanReaderCalled += 1
        return { jobs: [] }
      },
    })
    const lanRes = fakeRes()
    await lanRoute.handler(fakeReq('GET', { socket: { remoteAddress: '192.168.1.50' } }), lanRes)
    check(
      '同网段来源 GET → 403 且不读数据',
      lanRes.status === 403 && lanReaderCalled === 0 && JSON.parse(lanRes.body).code === 'forbidden',
      `${lanRes.status} called=${lanReaderCalled} ${lanRes.body?.trim()}`,
    )

    // ---------------------------------------------------------- 模式切换（写端点）
    // 写操作比读操作严：单独路径、只认 POST、只放行本机、模式白名单、
    // 成败以 cdp 的只读复核为准、成功后让快照缓存立刻失效。
    let switchCalls = []
    let invalidated = 0
    const [modeRoute] = createModeRoutes({
      switchMode: async ({ mode }) => {
        switchCalls.push(mode)
        return { ok: true, changed: true, modeBefore: 'chat', modeAfter: 'work' }
      },
      invalidate: () => {
        invalidated += 1
      },
    })
    check(
      '模式切换是独立路径（不与只读接口重合）',
      modeRoute.kind === 'exact' && modeRoute.path === STATUS_MODE_PATH && modeRoute.path !== STATUS_API_PATH,
      modeRoute.path,
    )
    check('模式白名单只有 work / chat', [...MODE_SWITCH_VALUES].sort().join(',') === 'chat,work')

    const switched = fakeRes()
    await modeRoute.handler(fakeReq('POST', { body: '{"mode":"work"}' }), switched)
    const switchedBody = JSON.parse(switched.body)
    check(
      'POST work → 200 + ok:true + 前后模式（不是只说「已切换」）',
      switched.status === 200 && switchedBody.ok === true && switchedBody.modeBefore === 'chat' && switchedBody.modeAfter === 'work',
      switched.body?.trim(),
    )
    check('切换成功后让快照缓存失效（否则面板还会显示 15 秒旧模式）', invalidated === 1, `invalidated=${invalidated}`)
    check('实际去切的就是 work', switchCalls.join(',') === 'work', JSON.stringify(switchCalls))

    const modeGet = fakeRes()
    await modeRoute.handler(fakeReq('GET'), modeGet)
    check('写端点只认 POST（GET → 405 + Allow: POST）', modeGet.status === 405 && modeGet.headers?.allow === 'POST', `GET -> ${modeGet.status}`)

    switchCalls = []
    const badMode = fakeRes()
    await modeRoute.handler(fakeReq('POST', { body: '{"mode":"rm -rf /"}' }), badMode)
    check(
      '非法模式 → 400 且**完全没有去点 UI**（白名单，不透传）',
      badMode.status === 400 && switchCalls.length === 0,
      `${badMode.status} calls=${JSON.stringify(switchCalls)}`,
    )

    const badJson = fakeRes()
    await modeRoute.handler(fakeReq('POST', { body: '{oops' }), badJson)
    check('请求体不是 JSON → 400', badJson.status === 400, `${badJson.status} ${badJson.body?.trim()}`)

    const noMode = fakeRes()
    await modeRoute.handler(fakeReq('POST', { body: '' }), noMode)
    check('空请求体 → 400（没给模式就不替你决定）', noMode.status === 400, `${noMode.status}`)

    switchCalls = []
    const lanSwitch = fakeRes()
    await modeRoute.handler(
      fakeReq('POST', { body: '{"mode":"work"}', socket: { remoteAddress: '192.168.1.50' } }),
      lanSwitch,
    )
    check(
      '非本机来源 POST → 403 且不点 UI（写端点比读端点更严）',
      lanSwitch.status === 403 && switchCalls.length === 0,
      `${lanSwitch.status} calls=${JSON.stringify(switchCalls)}`,
    )

    let failedInvalidated = 0
    const [failingModeRoute] = createModeRoutes({
      switchMode: async () => ({
        ok: false,
        changed: false,
        modeBefore: 'unknown',
        modeAfter: 'unknown',
        error: '豆包没在跑或没开调试端口（ECONNREFUSED）',
      }),
      invalidate: () => {
        failedInvalidated += 1
      },
    })
    const failedSwitch = fakeRes()
    await failingModeRoute.handler(fakeReq('POST', { body: '{"mode":"work"}' }), failedSwitch)
    const failedSwitchBody = JSON.parse(failedSwitch.body)
    check(
      '切换失败 → 200 + ok:false + 原因（预期结果，不伪装成功）',
      failedSwitch.status === 200 && failedSwitchBody.ok === false && String(failedSwitchBody.error).includes('调试端口'),
      failedSwitch.body?.trim(),
    )
    check('失败时不动快照缓存（别把「没切成」当成「已切成」）', failedInvalidated === 0, `invalidated=${failedInvalidated}`)

    const parsedSwitch = parseModeSwitch('{"ok":true,"changed":true,"modeBefore":"chat","modeAfter":"work","option":"工作任务\\n本地电脑"}')
    check(
      'parseModeSwitch 解析 cdp.mjs mode 的输出',
      parsedSwitch?.ok === true && parsedSwitch?.changed === true && parsedSwitch?.modeAfter === 'work',
      JSON.stringify(parsedSwitch ?? null),
    )
    check(
      'parseModeSwitch 对非 JSON / 非对象返回 null',
      parseModeSwitch('') === null && parseModeSwitch('x') === null && parseModeSwitch('[]') === null,
    )

    // ---------------------------------------------------------- 失败形态
    const [brokenRoute] = createStatusRoutes({
      read: () => {
        throw new Error('boom')
      },
    })
    const broken = fakeRes()
    await brokenRoute.handler(fakeReq('GET'), broken)
    const brokenBody = JSON.parse(broken.body)
    check(
      '读取抛错 → 500 并说明原因（不伪装成「没有任务」）',
      broken.status === 500 && brokenBody.ok === false && String(brokenBody.error).includes('boom'),
      `${broken.status} ${broken.body?.trim()}`,
    )

    process.env.DSH_QUEUE_FILE = join(scratch, 'empty', 'tasks.jsonl')
    const [emptyRoute] = createStatusRoutes(sampleSeams)
    const empty = fakeRes()
    await emptyRoute.handler(fakeReq('GET'), empty)
    check(
      '状态文件不存在 → 200 + 空列表（面板隐藏，而不是报错）',
      empty.status === 200 && JSON.parse(empty.body).jobs.length === 0,
      `${empty.status} ${empty.body?.trim()}`,
    )

    // ---------------------------------------------------------- 运行时快照解析
    const parsedState = parseDoubaoState(
      '{"connected":true,"mode":"work","modeRaw":"本地电脑","capability":"yes","model":"豆包 2.1 Lite","modelLevel":"低","at":123}',
    )
    check(
      'parseDoubaoState 解析 cdp.mjs state 的输出',
      parsedState?.connected === true &&
        parsedState?.mode === 'work' &&
        parsedState?.model === '豆包 2.1 Lite' &&
        parsedState?.modelLevel === '低' &&
        parsedState?.capability === 'yes',
      JSON.stringify(parsedState ?? null),
    )
    check(
      'parseDoubaoState 对非 JSON / 非对象返回 null',
      parseDoubaoState('') === null && parseDoubaoState('<html>') === null && parseDoubaoState('[]') === null && parseDoubaoState('null') === null,
    )
    const emptyParsed = parseDoubaoState('{}')
    check(
      'parseDoubaoState 缺字段时给安全默认值（不猜模式）',
      emptyParsed?.connected === false && emptyParsed?.mode === 'unknown' && emptyParsed?.model === '',
      JSON.stringify(emptyParsed ?? null),
    )

    // ---------------------------------------------------------- 快照缓存
    let reads = 0
    let clock = 1000
    const cache = createDoubaoStateCache({
      read: async () => {
        reads += 1
        return { ...fakeState, at: clock }
      },
      ttlMs: 100,
      now: () => clock,
    })
    const first = await cache()
    check('缓存首次调用会真的去读一次', reads === 1 && first.model === '豆包 2.1 Lite', `reads=${reads}`)
    clock += 50
    await cache()
    check('TTL 内不再读（面板每 2 秒轮询不该每 2 秒连一次 CDP）', reads === 1, `reads=${reads}`)
    clock += 100
    const stale = await cache()
    check('TTL 过期时先把旧值交出去（不被一次 CDP 往返拖住）', stale.model === '豆包 2.1 Lite', JSON.stringify(stale))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check('并在后台完成一次刷新', reads === 2, `reads=${reads}`)
    clock += 50
    await cache()
    check('刷新后的值在 TTL 内被复用', reads === 2, `reads=${reads}`)

    const failing = createDoubaoStateCache({
      read: async () => {
        throw new Error('boom-state')
      },
      ttlMs: 100,
      now: () => clock,
    })
    const failedState = await failing()
    check(
      '快照读取失败降级为 connected:false（豆包没开是正常状态，不是错误）',
      failedState.connected === false && String(failedState.error).includes('boom-state'),
      JSON.stringify(failedState),
    )

    // 快照爆炸不能连累任务列表：接口仍 200，jobs 照旧
    process.env.DSH_QUEUE_FILE = queueFile
    const [resilientRoute] = createStatusRoutes({
      readState: async () => {
        throw new Error('nope')
      },
      readQuota: async () => {
        throw new Error('quota-boom')
      },
      readModels: async () => {
        throw new Error('models-boom')
      },
    })
    const resilient = fakeRes()
    await resilientRoute.handler(fakeReq('GET'), resilient)
    const resilientBody = JSON.parse(resilient.body)
    check(
      '快照读取抛错时接口仍 200，任务列表与降级快照都在',
      resilient.status === 200 && resilientBody.jobs.length === 3 && resilientBody.doubao?.connected === false && String(resilientBody.doubao?.error).includes('nope'),
      `${resilient.status} ${JSON.stringify(resilientBody.doubao ?? null)}`,
    )
    check(
      '额度/模型采样抛错时也降级成 ok:false，不把接口打成 500',
      resilientBody.quota?.ok === false && String(resilientBody.quota?.error).includes('quota-boom') && resilientBody.models?.ok === false && String(resilientBody.models?.error).includes('models-boom'),
      `${JSON.stringify(resilientBody.quota ?? null)} ${JSON.stringify(resilientBody.models ?? null)}`,
    )

    // ---------------------------------------------------------- 额度 / 模型清单解析
    const quotaParsed = parseDoubaoQuota('{"ok":true,"usedPercent":0,"plan":"示例套餐","resets":3,"at":1}')
    check(
      'parseDoubaoQuota 解析额度采样',
      quotaParsed?.ok === true && quotaParsed?.usedPercent === 0 && quotaParsed?.plan === '示例套餐' && quotaParsed?.resets === 3,
      JSON.stringify(quotaParsed ?? null),
    )
    check(
      'parseDoubaoQuota 没有百分比时 ok:false（不猜数字）',
      parseDoubaoQuota('{"ok":true,"plan":"示例套餐"}')?.ok === false,
      JSON.stringify(parseDoubaoQuota('{"ok":true,"plan":"示例套餐"}') ?? null),
    )
    check('parseDoubaoQuota 夹住越界百分比', parseDoubaoQuota('{"ok":true,"usedPercent":120}')?.usedPercent === 100)
    check('parseDoubaoQuota 对非 JSON / 非对象返回 null', parseDoubaoQuota('') === null && parseDoubaoQuota('x') === null && parseDoubaoQuota('[]') === null)

    const modelsParsed = parseDoubaoModels(
      JSON.stringify({
        ok: true,
        current: '豆包 2.1 Lite',
        items: [
          { name: '豆包 2.1 Lite', note: '0921 新版', current: true },
          { name: '豆包 2.1 Lite', note: '', current: false },
          { name: '豆包 2.1 Turbo', note: '即将下线', current: false },
          { name: '', note: 'x', current: false },
        ],
      }),
    )
    check(
      'parseDoubaoModels 去重（同名只留一条）并丢掉空名',
      modelsParsed?.items.length === 2 && modelsParsed?.items[0]?.note === '0921 新版',
      JSON.stringify(modelsParsed ?? null),
    )
    check('parseDoubaoModels 只有空清单时 ok:false', parseDoubaoModels('{"ok":true,"items":[]}')?.ok === false)
    check('parseDoubaoModels 对非 JSON 返回 null', parseDoubaoModels('x') === null)

    check(
      '额度/模型是 60 秒采样（与 15 秒的 state 分开）',
      DOUBAO_QUOTA_TTL_MS === 60_000 && DOUBAO_MODELS_TTL_MS === 60_000 && DOUBAO_QUOTA_TTL_MS > 15_000,
      `quota=${DOUBAO_QUOTA_TTL_MS} models=${DOUBAO_MODELS_TTL_MS}`,
    )

    // 多窗口载荷（额度页读到的 5h + 7d）
    const windowsParsed = parseDoubaoQuota(
      JSON.stringify({
        ok: true,
        plan: '示例套餐',
        resets: 3,
        windows: [
          { id: 'session', short: '5h', label: '当前时段', usedText: '<1%', usedPercent: 0, approximate: true, resetText: '约 3 小时后重置' },
          { id: 'week', short: '7d', label: '近 7 天', usedText: '25%', usedPercent: 25, approximate: false, resetText: '12月31日 23:59 重置' },
        ],
      }),
    )
    check(
      'parseDoubaoQuota 保留两个额度窗口（含原文与重置时间）',
      windowsParsed?.windows?.length === 2 &&
        windowsParsed.windows[0].short === '5h' &&
        windowsParsed.windows[0].usedText === '<1%' &&
        windowsParsed.windows[0].approximate === true &&
        windowsParsed.windows[0].resetText === '约 3 小时后重置' &&
        windowsParsed.windows[1].usedPercent === 25,
      JSON.stringify(windowsParsed ?? null),
    )
    check(
      '有窗口时 usedPercent 取第一个窗口（老调用方不用改）',
      windowsParsed?.usedPercent === 0,
      String(windowsParsed?.usedPercent),
    )
    check(
      '降级标记原样带出（degraded + windowsError）',
      parseDoubaoQuota('{"ok":true,"usedPercent":0,"degraded":true,"windowsError":"设置面板里没找到…"}')?.degraded === true &&
        parseDoubaoQuota('{"ok":true,"usedPercent":0,"degraded":true,"windowsError":"x"}')?.windowsError === 'x',
    )
    check(
      '窗口字段缺失时给安全默认值（不炸、不猜成 100）',
      parseDoubaoQuota('{"ok":true,"windows":[{"label":"某窗口"}]}')?.windows?.[0]?.usedPercent === 0,
      JSON.stringify(parseDoubaoQuota('{"ok":true,"windows":[{"label":"某窗口"}]}')?.windows ?? null),
    )
    check(
      '空 windows 数组 + 没有百分比 → ok:false（不显示空额度）',
      parseDoubaoQuota('{"ok":true,"windows":[]}')?.ok === false,
    )

    // ---------------------------------------------------------- 菜单互斥队列
    {
      const queue = createSerialQueue()
      let running = 0
      let maxRunning = 0
      const order = []
      const task = (name, ms) =>
        queue(async () => {
          running += 1
          maxRunning = Math.max(maxRunning, running)
          order.push(`start:${name}`)
          await new Promise((resolve) => setTimeout(resolve, ms))
          order.push(`end:${name}`)
          running -= 1
        })
      await Promise.all([task('a', 25), task('b', 5), task('c', 1)])
      check(
        '串行队列：任何时刻只有一个操作在跑（不许两个菜单同时开）',
        maxRunning === 1,
        `maxRunning=${maxRunning} order=${order.join(',')}`,
      )
      check('串行队列保持发起顺序', order.join(',') === 'start:a,end:a,start:b,end:b,start:c,end:c', order.join(','))

      const queueAfterFailure = createSerialQueue()
      await queueAfterFailure(async () => {
        throw new Error('boom')
      }).catch(() => {})
      check('一次失败不会卡死队列', (await queueAfterFailure(async () => 'ok')) === 'ok')
    }

    // 接口载荷里真的带上额度与模型清单
    const sampleRes = fakeRes()
    await route.handler(fakeReq('GET'), sampleRes)
    const sampleBody = JSON.parse(sampleRes.body)
    check(
      '接口带上额度与模型清单（面板第三行与模型标注的数据来源）',
      sampleBody.quota?.usedPercent === 12 && sampleBody.quota?.plan === '示例套餐' && sampleBody.models?.items?.[1]?.note === '即将下线',
      `${JSON.stringify(sampleBody.quota ?? null)} ${JSON.stringify(sampleBody.models ?? null)}`,
    )

    // ------------------------------------------- MCP 连接器客户端（豆包工作那条线的可见性）
    {
      const connectorHome = mkdtempSync(join(tmpdir(), 'panel-connector-home-'))
      mkdirSync(join(connectorHome, 'mcp-connector'), { recursive: true })
      const now = 1_800_000_000_000
      appendFileSync(
        join(connectorHome, 'mcp-connector', 'clients.json'),
        JSON.stringify({
          clients: [
            { name: 'dsh-setup-check', version: '1', transport: 'http', initializations: 3, lastSeenAt: now - 1_000 },
            { name: 'selftest-worker', version: '1', transport: 'stdio', initializations: 2, lastSeenAt: now - 2_000 },
            { name: 'rmcp', version: '3.2.0', transport: 'http', initializations: 1, lastSeenAt: now - 120_000 },
          ],
        }),
        'utf8',
      )
      const seen = await readDoubaoConnectorClients({ env: { DSH_HOME: connectorHome }, now })
      check(
        '连接器客户端读取器：滤掉自检/测试名，只留真实客户端',
        seen.clients.length === 1 && seen.clients[0].name === 'rmcp' && seen.clients[0].transport === 'http',
        JSON.stringify(seen.clients),
      )
      check(
        '连接器客户端读取器：算得出「多久以前握手」',
        seen.clients[0].ageMs === 120_000 && seen.lastSeenAt === now - 120_000,
        `ageMs=${seen.clients[0].ageMs} lastSeenAt=${seen.lastSeenAt}`,
      )

      const emptyHome = mkdtempSync(join(tmpdir(), 'panel-connector-empty-'))
      const absent = await readDoubaoConnectorClients({ env: { DSH_HOME: emptyHome }, now })
      check(
        '连接器没跑过是正常状态：标 missing 而不报错',
        absent.missing === true && absent.clients.length === 0 && absent.error === undefined,
        JSON.stringify(absent),
      )

      const brokenHome = mkdtempSync(join(tmpdir(), 'panel-connector-broken-'))
      mkdirSync(join(brokenHome, 'mcp-connector'), { recursive: true })
      appendFileSync(join(brokenHome, 'mcp-connector', 'clients.json'), '{ not json', 'utf8')
      const broken = await readDoubaoConnectorClients({ env: { DSH_HOME: brokenHome }, now })
      check(
        '文件在但读坏时如实带 error（不伪装成「没有客户端」）',
        broken.clients.length === 0 && typeof broken.error === 'string' && broken.error.length > 0,
        JSON.stringify(broken),
      )

      const injectedClients = { file: 'x', clients: [{ name: 'rmcp', transport: 'http', initializations: 1, ageMs: 1_000 }], lastSeenAt: now }
      const [mcpRoute] = createStatusRoutes({
        readState: async () => fakeState,
        readQuota: async () => fakeQuota,
        readModels: async () => fakeModels,
        readClients: async () => injectedClients,
      })
      const mcpRes = fakeRes()
      await mcpRoute.handler(fakeReq('GET'), mcpRes)
      const mcpBody = JSON.parse(mcpRes.body)
      check(
        '接口载荷里带 mcp（连接器客户端），供徽章判断工作应用那条线',
        mcpBody.mcp?.clients?.[0]?.name === 'rmcp' && mcpBody.mcp?.lastSeenAt === now,
        JSON.stringify(mcpBody.mcp ?? null),
      )

      rmSync(connectorHome, { recursive: true, force: true })
      rmSync(emptyHome, { recursive: true, force: true })
      rmSync(brokenHome, { recursive: true, force: true })
    }

    // ---------------------------------------------------------- 采样间隔设置（查询参数）
    check(
      'parseSampleQuery 无参数时回退默认 60 秒（不是下限 30 秒）',
      parseSampleQuery('/doubao-status/api').quotaTtlMs === 60_000 && parseSampleQuery('').modelsTtlMs === 60_000,
      JSON.stringify(parseSampleQuery('/doubao-status/api')),
    )
    check(
      'parseSampleQuery 认得了完整 req.url（先切掉 ? 之前；这坑踩过一次）',
      parseSampleQuery('/doubao-status/api?sample=0').allowRefresh === false &&
        parseSampleQuery('?sample=0').allowRefresh === false &&
        parseSampleQuery('/doubao-status/api?sample=1').allowRefresh === true,
    )
    check(
      'parseSampleQuery 把间隔夹在 30 秒..1 小时',
      parseSampleQuery('?quotaTtlMs=1').quotaTtlMs === 30_000 && parseSampleQuery('?quotaTtlMs=99999999').quotaTtlMs === 3_600_000,
      `${parseSampleQuery('?quotaTtlMs=1').quotaTtlMs} / ${parseSampleQuery('?quotaTtlMs=99999999').quotaTtlMs}`,
    )
    check(
      'parseSampleQuery 接受设置项给的合法间隔（1/5/15 分钟）',
      parseSampleQuery('?quotaTtlMs=300000&modelsTtlMs=900000').quotaTtlMs === 300_000 &&
        parseSampleQuery('?modelsTtlMs=900000').modelsTtlMs === 900_000,
    )
    check('parseSampleQuery 非法值回退默认', parseSampleQuery('?quotaTtlMs=abc').quotaTtlMs === 60_000)

    // 缓存：allowRefresh:false 时**过期也不刷新**（「仅悬停时采样」的普通轮询）
    {
      let reads = 0
      let clock = 1000
      const cache = createDoubaoStateCache({
        read: async () => {
          reads += 1
          return { ...fakeState, at: clock }
        },
        ttlMs: 100,
        now: () => clock,
      })
      const cold = await cache({ allowRefresh: false })
      check('allowRefresh:false 且没有缓存 → undefined（一次都不采样）', cold === undefined && reads === 0, `reads=${reads}`)
      await cache()
      clock += 500
      const stale = await cache({ allowRefresh: false })
      check('allowRefresh:false 且有过缓存 → 交旧值、不刷新', stale?.model === '豆包 2.1 Lite' && reads === 1, `reads=${reads}`)
      clock += 500
      await cache({ ttlMs: 10_000 })
      check('请求可以指定更长的 TTL（设置项把采样调稀）', reads === 1, `reads=${reads}`)
    }

    // 接口把采样设置透传给采样器
    {
      const seen = []
      const [optRoute] = createStatusRoutes({
        readState: async () => fakeState,
        readQuota: async (options) => {
          seen.push(['quota', options])
          return fakeQuota
        },
        readModels: async (options) => {
          seen.push(['models', options])
          return fakeModels
        },
      })
      const optRes = fakeRes()
      await optRoute.handler(
        fakeReq('GET', { url: '/doubao-status/api?sample=0&quotaTtlMs=300000&modelsTtlMs=900000' }),
        optRes,
      )
      const quotaOptions = seen.find(([who]) => who === 'quota')?.[1]
      const modelsOptions = seen.find(([who]) => who === 'models')?.[1]
      check(
        '接口把采样设置透传给采样器（ttlMs + allowRefresh）',
        quotaOptions?.allowRefresh === false && quotaOptions?.ttlMs === 300_000 && modelsOptions?.ttlMs === 900_000,
        JSON.stringify(seen),
      )
    }

    // ---------------------------------------------------------- 客户端渲染（假 React 真跑一遍）
    // 这一节专门盯「界面上到底渲染出几条线 / 几条进度条」——就是上次误会的所在层。
    {
      const payloadBase = {
        ok: true,
        doubao: fakeState,
        quota: { ok: true, usedPercent: 0, plan: '示例套餐', resets: 3, at: 0 },
        models: fakeModels,
        jobs: [],
      }

      const noTask = renderBadge(payloadBase)
      const noTaskTree = await noTask.settle()

      // 悬停提示里的 MCP 一段：徽章本体不加行，但必须能回答「工作应用那条线接上没有」。
      {
        const withClient = renderBadge({
          ...payloadBase,
          mcp: {
            file: 'x',
            clients: [{ name: 'rmcp', version: '3.2.0', transport: 'http', initializations: 1, lastSeenAt: 1, ageMs: 120_000 }],
            lastSeenAt: 1,
          },
        })
        const clientTitle = String((await withClient.settle())?.props?.title ?? '')
        check(
          '提示里报告 MCP 客户端（名字/传输/握手次数 + 最近握手时间）',
          clientTitle.includes('MCP 客户端：rmcp@3.2.0（http ×1）') && clientTitle.includes('最近握手 2 分钟前'),
          clientTitle.split('\n').find((line) => line.startsWith('MCP 客户端')) ?? clientTitle.slice(0, 80),
        )

        const missingMcp = renderBadge({ ...payloadBase, mcp: { file: 'x', clients: [], lastSeenAt: null, missing: true } })
        const missingTitle = String((await missingMcp.settle())?.props?.title ?? '')
        check(
          '没有客户端记录时说「连接器没跑过」，并给出下一步命令',
          missingTitle.includes('还没有客户端记录') && missingTitle.includes('check-doubao-work.mjs'),
          missingTitle.split('\n').find((line) => line.startsWith('MCP 客户端')) ?? '',
        )

        const emptyMcp = renderBadge({ ...payloadBase, mcp: { file: 'x', clients: [], lastSeenAt: null, empty: true } })
        const emptyTitle = String((await emptyMcp.settle())?.props?.title ?? '')
        check(
          '有文件但没真实客户端时，明确说「自检探过不算」',
          emptyTitle.includes('还没有任何真实客户端握手过') && emptyTitle.includes('自检名已滤掉'),
          emptyTitle.split('\n').find((line) => line.startsWith('MCP 客户端')) ?? '',
        )
      }

      // 豆包工作那条运行时线：读得到才占一行，读不到不留空行（也不谎称「未连接」）。
      {        const workState = { connected: true, mode: 'work', modeRaw: '本地电脑', capability: 'yes', model: '豆包 2.1 Lite', modelLevel: '低', usage: { percent: 20, found: true, reason: null, contextOpen: true } }
        const workTexts = collectLineTexts(await renderBadge({ ...payloadBase, work: workState }).settle())
        const contextBars = collectBars(await renderBadge({ ...payloadBase, work: workState }).settle())
        check(
          '上下文那一行带进度条（值就是上下文百分比）',
          contextBars.some((bar) => bar.label === '上下文用量 20%' && bar.value === 20 && bar.fillColor === 'var(--dsw-alias-brand-primary)'),
          JSON.stringify(contextBars),
        )
        check(
          '连得上豆包工作：徽章多一行「豆包工作 · 模式 · 模型 · 上下文用量」',
          workTexts.includes('豆包工作 · 本地电脑 · 豆包 2.1 Lite') && workTexts.includes('上下文 20%'),
          JSON.stringify(workTexts),
        )
        const noUsageTexts = collectLineTexts(
          await renderBadge({ ...payloadBase, work: { ...workState, usage: { percent: null, found: false, reason: 'no-open-conversation', contextOpen: false } } }).settle(),
        )
        check(
          '读不到上下文用量时那一行不写用量（不用 0% 充数）',
          noUsageTexts.includes('豆包工作 · 本地电脑 · 豆包 2.1 Lite'),
          JSON.stringify(noUsageTexts),
        )
        const workTitle = String((await renderBadge({ ...payloadBase, work: workState }).settle())?.props?.title ?? '')
        check(
          '提示里说明豆包工作的模式与模型',
          workTitle.includes('豆包工作：本地电脑') && workTitle.includes('豆包工作模型：豆包 2.1 Lite'),
          workTitle.split('\n').filter((line) => line.startsWith('豆包工作')).join(' / '),
        )
        const noWork = await renderBadge({ ...payloadBase, work: { connected: false, mode: 'unknown', modeRaw: '', capability: 'unknown', model: '', modelLevel: '', error: 'ECONNREFUSED' } }).settle()
        const noWorkTexts = collectLineTexts(noWork)
        check(
          '读不到豆包工作时不加行（不把「没开调试端口」画成故障）',
          !noWorkTexts.some((text) => String(text).startsWith('豆包工作 ·')),
          JSON.stringify(noWorkTexts),
        )
        const noWorkTitle = String(noWork?.props?.title ?? '')
        check(
          '读不到时提示里说清原因（要带调试端口启动，不是坏了）',
          noWorkTitle.includes('豆包工作：读不到') && noWorkTitle.includes('9223'),
          noWorkTitle.split('\n').find((line) => line.startsWith('豆包工作')) ?? '',
        )
      }

      // Synthetic work-quota counts exercise both windows and their rendering.
      {
        const injectedWorkQuota = { ok: true, session: { used: 12, limit: 500, resetText: '12:00' }, week: { used: 80, limit: 3000 }, at: 0 }
        const [quotaRoute] = createStatusRoutes({
          readState: async () => fakeState,
          readQuota: async () => fakeQuota,
          readModels: async () => fakeModels,
          readClients: async () => ({ file: 'x', clients: [], lastSeenAt: null, empty: true }),
          readWorkState: async () => ({ connected: true, mode: 'work', modeRaw: '本地电脑', capability: 'yes', model: '豆包 2.1 Lite', modelLevel: '' }),
          readWorkQuota: async () => injectedWorkQuota,
        })
        const quotaRes = fakeRes()
        await quotaRoute.handler(fakeReq('GET'), quotaRes)
        const quotaBody = JSON.parse(quotaRes.body)
        check('接口载荷里带 workQuota（额度计数）', quotaBody.workQuota?.session?.used === 12 && quotaBody.workQuota?.week?.limit === 3000, JSON.stringify(quotaBody.workQuota ?? null))

        const workStateForQuota = { connected: true, mode: 'work', modeRaw: '本地电脑', capability: 'yes', model: '豆包 2.1 Lite', modelLevel: '' }
        const withQuota = collectLineTexts(await renderBadge({ ...payloadBase, work: workStateForQuota, workQuota: injectedWorkQuota }).settle())
        check(
          '额度两格各自一行（当前时段 / 近 7 天）',
          withQuota.some((text) => String(text).startsWith('当前时段 12/500')) && withQuota.some((text) => String(text).startsWith('近 7 天 80/3000')),
          JSON.stringify(withQuota.filter((text) => String(text).includes('额度'))),
        )
        const noQuota = collectLineTexts(await renderBadge({ ...payloadBase, work: workStateForQuota, workQuota: { ok: false, error: '尚未采样', at: 0 } }).settle())
        check(
          '额度计数读不到时不加行（不画 0/0）',
          !noQuota.some((text) => String(text).startsWith('当前时段')),
          JSON.stringify(noQuota.filter((text) => String(text).includes('额度'))),
        )
      }

      // 独立「豆包」设置页（settings.section）：真渲染一遍，验内容与默认偏好。
      {
        const harness = renderBadge(payloadBase)
        const sectionTree = await harness.renderSection()
        const texts = []
        const nodes = []
        const walk = (node) => {
          if (node === null || node === undefined || typeof node !== 'object') {
            if (typeof node === 'string') texts.push(node)
            return
          }
          if (Array.isArray(node)) {
            node.forEach(walk)
            return
          }
          nodes.push(node)
          walk(node.children)
        }
        walk(sectionTree)
        check('设置页：出现「默认打开的程序」', texts.includes('默认打开的程序'), JSON.stringify(texts.slice(0, 14)))
        const personalBtn = nodes.find((node) => node.props?.['data-dsh-part'] === 'target-option-personal')
        const workBtn = nodes.find((node) => node.props?.['data-dsh-part'] === 'target-option-work')
        check(
          '设置页：默认程序的两个单选都渲染出来了（默认选中态在这里观察不到：假 React 的 useState 不返回初始值）',
          personalBtn !== undefined && workBtn !== undefined && personalBtn.props['data-dsh-part'] === 'target-option-personal' && workBtn.props['data-dsh-part'] === 'target-option-work',
          JSON.stringify([personalBtn?.props?.['data-dsh-part'], workBtn?.props?.['data-dsh-part']]),
        )
        check(
          '设置页：采样间隔已迁到这一页',
          texts.some((text) => String(text).includes('额度/模型采样间隔')),
          JSON.stringify(texts.filter((text) => String(text).includes('采样')).slice(0, 3)),
        )
        check(
          '设置页：两个 App 的当前读数都在',
          texts.some((text) => String(text).startsWith('个人版：')) && texts.some((text) => String(text).startsWith('豆包工作：')),
          JSON.stringify(texts.filter((text) => String(text).includes('：')).slice(0, 8)),
        )
        check(
          '设置页：给出可复制的诊断命令',
          texts.some((text) => String(text).includes('check-doubao-work.mjs')),
          JSON.stringify(texts.filter((text) => String(text).includes('mjs')).slice(0, 4)),
        )
        check(
          '设置页：通用页不再注册采样行（已迁走）',
          harness.renderedIds.includes('doubao') && !harness.renderedIds.includes('doubao-status-panel-sample'),
          JSON.stringify(harness.renderedIds),
        )
      }

      const noTaskBars = collectBars(noTaskTree)
      check(
        '没有任务时：只有一条进度条（额度那条；任务行本来就不渲染）',
        noTaskBars.length === 1 && noTaskBars[0].value === 0 && noTaskBars[0].fillWidth === '0%',
        JSON.stringify(noTaskBars),
      )
      check(
        '没有任务时：请求带默认采样参数（1 分钟档）',
        String(noTask.requested[0]).includes('sample=1') && String(noTask.requested[0]).includes('quotaTtlMs=60000'),
        JSON.stringify(noTask.requested),
      )
      check(
        '徽章与设置页两个占用者都注册了（设置项已迁成独立页）',
        noTask.renderedIds.includes('doubao-status-panel') && noTask.renderedIds.includes('doubao'),
        JSON.stringify(noTask.renderedIds),
      )

      const withTask = renderBadge({
        ...payloadBase,
        jobs: [{ job: 'X', state: 'progress', percent: 55, terminal: false, stale: false, lastAt: 1 }],
      })
      const withTaskTree = await withTask.settle()
      const withTaskBars = collectBars(withTaskTree)
      check(
        '有任务（progress 55%）时：任务 + 额度两条进度条，值分别是 55 与 0',
        withTaskBars.length === 2 &&
          withTaskBars.some((bar) => bar.value === 55 && bar.fillWidth === '55%') &&
          withTaskBars.some((bar) => bar.value === 0),
        JSON.stringify(withTaskBars),
      )
      const withTaskTexts = collectLineTexts(withTaskTree)
      check(
        '有任务时三条线：任务 / 运行时 / 额度',
        withTaskTexts.includes('进行中 55%') &&
          withTaskTexts.some((text) => text.includes('本地电脑')) &&
          withTaskTexts.some((text) => text.startsWith('额度 0%')),
        JSON.stringify(withTaskTexts),
      )
      check(
        '运行时那条带上模型状态标注（0921 新版）',
        withTaskTexts.some((text) => text.includes('0921 新版')),
        JSON.stringify(withTaskTexts),
      )

      const startedOnly = renderBadge({
        ...payloadBase,
        jobs: [{ job: 'X', state: 'started', terminal: false, stale: false, lastAt: 1 }],
      })
      const startedBars = collectBars(await startedOnly.settle())
      check(
        '任务没有可靠百分比时（started）不画任务条——不编造进度',
        startedBars.length === 1,
        JSON.stringify(startedBars),
      )

      const doneJob = renderBadge({
        ...payloadBase,
        jobs: [{ job: 'X', state: 'done', terminal: true, stale: false, lastAt: 1 }],
      })
      const doneBars = collectBars(await doneJob.settle())
      check(
        'done 视为 100%：任务条满格',
        doneBars.some((bar) => bar.value === 100 && bar.fillWidth === '100%'),
        JSON.stringify(doneBars),
      )

      const highQuotaRun = renderBadge({
        ...payloadBase,
        quota: { ok: true, usedPercent: 96, plan: '示例套餐', at: 0 },
      })
      const highBars = collectBars(await highQuotaRun.settle())
      check(
        '额度 ≥95% 时进度条用 error 色（不是绿）',
        highBars.some((bar) => bar.value === 96 && String(bar.fillColor).includes('state-error-primary')),
        JSON.stringify(highBars),
      )

      const hoverMode = renderBadge(payloadBase, { samplePref: 'hover' })
      await hoverMode.settle()
      check(
        '「仅悬停时」档：普通轮询请求 sample=0（一次菜单都不开）',
        String(hoverMode.requested[0]).includes('sample=0'),
        JSON.stringify(hoverMode.requested),
      )

      // 两个额度窗口（额度页读到 5h + 7d）：一个窗口一行、各一条 5px 条
      const twoWindowsQuota = {
        ok: true,
        plan: '示例套餐',
        resets: 3,
        usedPercent: 0,
        windows: [
          { id: 'session', short: '5h', label: '当前时段', usedText: '<1%', usedPercent: 0, approximate: true, resetText: '约 3 小时后重置' },
          { id: 'week', short: '7d', label: '近 7 天', usedText: '25%', usedPercent: 25, approximate: false, resetText: '12月31日 23:59 重置' },
        ],
      }
      const twoWindows = renderBadge({ ...payloadBase, quota: twoWindowsQuota })
      const twoWindowsTree = await twoWindows.settle()
      const twoWindowsBars = collectBars(twoWindowsTree)
      const twoWindowsTexts = collectLineTexts(twoWindowsTree)
      check(
        '两个额度窗口 → 两条额度行、各带一条进度条（没任务时共 2 条）',
        twoWindowsBars.length === 2 && twoWindowsBars.some((bar) => bar.value === 0) && twoWindowsBars.some((bar) => bar.value === 25),
        JSON.stringify(twoWindowsBars),
      )
      check(
        '两个窗口的文字用页面原文：`5h 额度 <1%` 与 `7d 额度 25%`',
        twoWindowsTexts.includes('5h 额度 <1%') && twoWindowsTexts.includes('7d 额度 25%'),
        JSON.stringify(twoWindowsTexts),
      )
      check(
        '进度条粗细是 5px（用户要求）',
        twoWindowsBars.length > 0 && twoWindowsBars.every((bar) => bar.height === 5),
        JSON.stringify(twoWindowsBars.map((bar) => bar.height)),
      )
      check(
        '「不到 1%」的条按下界画（0），不画成 1%',
        twoWindowsBars.some((bar) => bar.value === 0 && bar.fillWidth === '0%'),
        JSON.stringify(twoWindowsBars),
      )

      const taskPlusWindows = renderBadge({
        ...payloadBase,
        quota: twoWindowsQuota,
        jobs: [{ job: 'X', state: 'progress', percent: 55, terminal: false, stale: false, lastAt: 1 }],
      })
      const taskPlusBars = collectBars(await taskPlusWindows.settle())
      check(
        '任务在跑且有两个窗口时 → 3 条进度条（任务 + 5h + 7d）',
        taskPlusBars.length === 3,
        JSON.stringify(taskPlusBars),
      )
    }
  } catch (error) {
    check('panel selftest 完整跑完', false, String(error?.stack ?? error))
  } finally {
    if (savedQueue === undefined) delete process.env.DSH_QUEUE_FILE
    else process.env.DSH_QUEUE_FILE = savedQueue
    rmSync(scratch, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
