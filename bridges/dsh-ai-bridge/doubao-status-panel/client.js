/**
 * doubao-status-panel —— 浏览器半：侧栏底部的豆包状态徽章。
 *
 * 显示两件事（都是只读的）：
 *   1. **任务状态**（有活跃/刚结束的 job 时）：已接收 / 工作开始 / 进行中 x% /
 *      需要确认 / 已完成 / 失败；
 *   2. **豆包运行时**：当前模式（工作/对话）+ 当前模型。这一条是常驻的，因为
 *      「是不是工作模式」直接决定豆包能不能回报状态——派发前就该看得见。
 *
 * 这不是普通 ESM，而是 DSH 的模块装载器格式：`window.__ModuleLoader__.load`
 * 注册一个懒工厂，React 由浏览器的模块表提供（`require('react')`），所以不需要
 * tsc/tsdown 之类的构建链，手写即可。
 *
 * 纪律：
 *   - **注册一律 try/catch**：槽未声明或注册表不可用时静默不显示，绝不把整个
 *     Web 界面拖垮。
 *   - 每 2 秒轮询宿主半的**只读**接口 `/doubao-status/api`（宿主半自己带 15 秒
 *     快照缓存，不会每 2 秒连一次 CDP）；拿不到就隐藏徽章。
 *   - 只用主题 token（`--dsw-*`）着色，不 import 任何 `@deepseek-ai/dsh-client-*`
 *     包，亮/暗主题都由宿主决定。
 *   - 定时器在组件卸载时清掉，不留后台轮询。
 *
 * 已知取舍：界面文案是硬编码中文，没有走 Client locale 服务（第一版刻意不做，
 * 免得依赖一个可能不存在的服务把界面拖垮）。见 README「限制」。
 */

window.__ModuleLoader__.load({
  id: '@local/doubao-status-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主半注册的只读接口（同源、同一个 DSH 端口）。 */
    const API_PATH = '/doubao-status/api'
    /** 模式切换接口：只接受 POST，只放行本机（宿主半用同一个来源围栏）。 */
    const MODE_PATH = '/doubao-status/api/mode'

    /**
     * 采样间隔偏好（毫秒，或 `hover` = 只在鼠标悬停时采样）。
     *
     * 为什么要给用户调：额度/模型清单只能靠**打开一次豆包菜单**来读，采一次菜单就闪一下。
     * 所以把它做成设置项，而不是我替用户定一个频率。
     */
    const SAMPLE_PREF_KEY = 'doubao-status-panel:sample'
    const SAMPLE_OPTIONS = [
      { value: '60000', label: '每 1 分钟' },
      { value: '300000', label: '每 5 分钟' },
      { value: '900000', label: '每 15 分钟' },
      { value: 'hover', label: '仅鼠标悬停时（零打扰）' },
    ]
    const SAMPLE_VALUES = new Set(SAMPLE_OPTIONS.map((option) => option.value))
    const SAMPLE_DEFAULT = '60000'

    /** 读偏好：读不到/被禁用（隐私模式）就用默认值，绝不抛。 */
    function readSamplePref() {
      try {
        const stored = window.localStorage.getItem(SAMPLE_PREF_KEY)
        return SAMPLE_VALUES.has(stored) ? stored : SAMPLE_DEFAULT
      } catch {
        return SAMPLE_DEFAULT
      }
    }

    /**
     * 「默认打开的程序」偏好：`personal`（豆包个人版 9222）或 `work`（豆包工作 9223）。
     *
     * 和采样偏好一样只存 localStorage——它是**这台机器上的人的使用偏好**，不是插件配置，
     * 所以不碰宿主 Config（也就不需要任何 schema / 重启）。
     * 用途：徽章主行优先展示哪个 App、以及 README 里「打开/驱动豆包」这类动作的默认目标。
     */
    const TARGET_PREF_KEY = 'doubao-status-panel:default-target'
    const TARGET_OPTIONS = [
      { value: 'personal', label: '豆包（个人版）', hint: '调试端口 9222 · 有对话/工作两种模式' },
      { value: 'work', label: '豆包工作', hint: '调试端口 9223 · 固定本地电脑模式' },
    ]
    function readTargetPref() {
      try {
        return window.localStorage.getItem(TARGET_PREF_KEY) === 'work' ? 'work' : 'personal'
      } catch {
        return 'personal'
      }
    }
    function writeTargetPref(value) {
      try {
        window.localStorage.setItem(TARGET_PREF_KEY, value === 'work' ? 'work' : 'personal')
      } catch {
        /* 隐私模式：偏好存不住就算了，不报错 */
      }
    }

    /** 写偏好：存不下也算本次生效（界面状态自己留着）。 */
    function writeSamplePref(value) {
      try {
        window.localStorage.setItem(SAMPLE_PREF_KEY, value)
      } catch {
        /* 忽略：只是下次打开回到默认 */
      }
    }
    /** 轮询间隔：够快到能看见「已接收 → 工作开始」，又不至于把宿主吵醒。 */
    const POLL_MS = 2000
    /** 侧栏底部的常驻动作位（由 ui-sidebar 声明，list 类型，可多人共用）。 */
    const SLOT = 'sidebar.footer.action'

    /** 任务状态 → 中文（验收要求的那几个词）。 */
    const STATE_TEXT = {
      received: '已接收',
      started: '工作开始',
      progress: '进行中',
      need_input: '需要确认',
      done: '已完成',
      failed: '失败',
    }

    /** 任务状态 → 主题 token（不写死颜色，亮/暗主题各自正确）。 */
    const STATE_TONE = {
      received: 'var(--dsw-alias-state-idle-primary)',
      started: 'var(--dsw-alias-brand-primary)',
      progress: 'var(--dsw-alias-brand-primary)',
      need_input: 'var(--dsw-alias-state-warn-primary)',
      done: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
    }

    const IDLE_TONE = 'var(--dsw-alias-state-idle-primary)'

    /** 额度告警阈值：正常绿 / ≥80% 琥珀 / ≥95% 红。 */
    const QUOTA_WARN = 80
    const QUOTA_RED = 95

    /** 一条 job 显示成什么字。 */
    function labelOf(job) {
      const base = STATE_TEXT[job.state] ?? String(job.state)
      if (job.state === 'progress' && Number.isFinite(job.percent)) return `${base} ${job.percent}%`
      if (job.terminal !== true && job.stale === true) return `${base}（疑似卡死）`
      return base
    }

    /**
     * 从接口返回的 job 列表里挑「最该显示的那一条」。
     * 优先正在跑的，其次刚结束的（让「已完成」看得见），最后是疑似卡死的。
     * 都没有 → undefined（那一行不显示）。
     */
    function pickJob(jobs) {
      if (!Array.isArray(jobs) || jobs.length === 0) return undefined
      const sorted = [...jobs].sort((left, right) => (left.lastAt ?? 0) - (right.lastAt ?? 0))
      const running = sorted.filter((job) => job.terminal !== true && job.stale !== true)
      if (running.length > 0) return running[running.length - 1]
      const finished = sorted.filter((job) => job.terminal === true)
      if (finished.length > 0) return finished[finished.length - 1]
      return sorted[sorted.length - 1]
    }

    /**
     * 豆包运行时那一行：模式 + 模型 + 模型状态标注。
     * 模式文字直接用页面读到的原文（`本地电脑` / `对话`），不自己翻译；
     * 对话模式明确标出「不回报状态」，因为那正是派发会被拒的原因；
     * 模型标注来自模型菜单（`0921 新版` / `即将下线`），是「采样」来的，可能是几十秒前的。
     */
    function runtimeText(runtime, note = '') {
      if (runtime === undefined || runtime === null) return ''
      if (runtime.connected !== true) return '豆包未连接'
      const mode =
        runtime.modeRaw || (runtime.mode === 'work' ? '工作模式' : runtime.mode === 'chat' ? '对话' : '模式未知')
      const warn = runtime.capability === 'no' ? '（不回报状态）' : ''
      const model = typeof runtime.model === 'string' && runtime.model.length > 0 ? ` · ${runtime.model}` : ''
      const suffix = note.length > 0 ? ` · ${note}` : ''
      return `${mode}${warn}${model}${suffix}`
    }

    /** 当前模型在菜单里的状态标注（例如 `即将下线`）。采样读不到就返回空串。 */
    function currentModelNote(models) {
      const items = Array.isArray(models?.items) ? models.items : []
      const current =
        items.find((item) => item.current === true) ??
        items.find((item) => item.name === models?.current)
      return typeof current?.note === 'string' ? current.note : ''
    }

    /** 「即将下线」这类标注要显眼，所以单独判一次。 */
    function isRetiringNote(note) {
      return /下线|停用|弃用|deprecated/i.test(String(note ?? ''))
    }

    /** 额度那一行（**降级**载荷：只有一个扁平百分比时）：读不到就空串，不占位置。 */
    function quotaText(quota) {
      if (quota === undefined || quota === null || quota.ok !== true || !Number.isFinite(quota.usedPercent)) return ''
      if (Array.isArray(quota.windows) && quota.windows.length > 0) return ''
      const plan = typeof quota.plan === 'string' && quota.plan.length > 0 ? ` · ${quota.plan}` : ''
      const resets = Number.isFinite(quota.resets) ? ` · 可重置 ${quota.resets} 次` : ''
      return `额度 ${quota.usedPercent}%${plan}${resets}`
    }

    /** 额度色点：正常绿 / ≥80% 琥珀 / ≥95% 红。 */
    function quotaTonePercent(percent) {
      if (!Number.isFinite(percent)) return IDLE_TONE
      if (percent >= QUOTA_RED) return 'var(--dsw-alias-state-error-primary)'
      if (percent >= QUOTA_WARN) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-success-primary)'
    }

    /** 额度色点（整份额度对象版）。 */
    function quotaTone(quota) {
      const used = quota?.ok === true ? quota.usedPercent : Number.NaN
      return quotaTonePercent(used)
    }

    /** 额度窗口那一行的文字：`5h 额度 <1%`。原文优先（`<1%` 就显示 `<1%`）。 */
    function quotaWindowText(window) {
      const name = typeof window?.short === 'string' && window.short.length > 0
        ? window.short
        : typeof window?.label === 'string'
          ? window.label
          : '额度'
      const used = typeof window?.usedText === 'string' && window.usedText.length > 0
        ? window.usedText
        : `${Number.isFinite(window?.usedPercent) ? window.usedPercent : 0}%`
      return `${name} 额度 ${used}`
    }

    /** 没有任务时，用模式决定色点颜色：能回报状态=绿，不能=琥珀，读不到=灰。 */
    function runtimeTone(runtime, note = '') {
      if (isRetiringNote(note)) return 'var(--dsw-alias-state-warn-primary)'
      if (runtime === undefined || runtime === null || runtime.connected !== true) return IDLE_TONE
      if (runtime.capability === 'yes') return 'var(--dsw-alias-state-success-primary)'
      if (runtime.capability === 'no') return 'var(--dsw-alias-state-warn-primary)'
      return IDLE_TONE
    }

    /** 把毫秒差写成「多久以前」；读不到就空串（不编）。 */
    function formatAge(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒前`
      if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`
      if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时前`
      return `${Math.round(ms / 86_400_000)} 天前`
    }

    /**
     * 悬停提示：任务 / 运行时 / 额度 / 模型清单 / **MCP 侧的客户端**（正文可能很长，只放这里）。
     *
     * MCP 一段回答的是「工作应用那条线接上没有」——豆包本体那条线靠模式+模型就能看出来，
     * 走 MCP 的这条线只能看连接器有没有记到真实客户端（自检名已在宿主半滤掉）。
     */
    function tooltipFor(job, runtime, quota, models, mcp, work) {
      const parts = []
      if (work !== undefined && work !== null) {
        // 豆包工作这条线：读得到就说清模式/模型；读不到要说清「是没带调试端口」，不是坏。
        if (work.connected === true) {
          parts.push(`豆包工作：${work.modeRaw || work.mode}（状态回报能力：${work.capability === 'yes' ? '可以' : work.capability === 'no' ? '不行' : '未知'}）`)
          if (typeof work.model === 'string' && work.model.length > 0) {
            parts.push(`豆包工作模型：${work.model}${work.modelLevel ? `（档位 ${work.modelLevel}）` : ''}`)
          }
          // 上下文用量：读得到才写；读不到要说清是「没开对话」还是「这台没有」。
          if (Number.isFinite(work.usage?.percent)) parts.push(`豆包工作上下文用量：${work.usage.percent}%`)
          else if (work.usage?.reason === 'no-open-conversation') parts.push('豆包工作上下文用量：读不到（没有打开的对话——这个圆环只在打开的对话里出现）')
          else if (work.usage?.found === false) parts.push('豆包工作上下文用量：这台 App 的页面上没有这个控件')
        } else {
          parts.push('豆包工作：读不到（它要带 --remote-debugging-port=9223 启动才能读；不带就是读不到，不是坏了）')
        }
      }
      if (job !== undefined) {
        parts.push(`任务 ${job.job}：${labelOf(job)}`)
        if (typeof job.step === 'string' && job.step.length > 0) parts.push(`步骤：${job.step}`)
        if (typeof job.message === 'string' && job.message.length > 0) parts.push(`正文：${job.message}`)
      }
      if (runtime !== undefined && runtime !== null) {
        if (runtime.connected !== true) {
          parts.push('豆包未连接：调试端口 9222 未监听（用 --remote-debugging-port=9222 启动豆包）')
        } else {
          const ability =
            runtime.capability === 'yes' ? '可以' : runtime.capability === 'no' ? '不行' : '未知'
          parts.push(`模式：${runtime.modeRaw || runtime.mode}（状态回报：${ability}）`)
          if (typeof runtime.model === 'string' && runtime.model.length > 0) {
            parts.push(`模型：${runtime.model}${runtime.modelLevel ? `（档位 ${runtime.modelLevel}）` : ''}`)
          }
        }
        if (typeof runtime.error === 'string' && runtime.error.length > 0) parts.push(`读取失败：${runtime.error}`)
      }
      if (quota !== undefined && quota !== null) {
        const windows = Array.isArray(quota.windows) ? quota.windows : []
        if (quota.ok === true && windows.length > 0) {
          const resets = Number.isFinite(quota.resets) ? `，可重置 ${quota.resets} 次` : ''
          const lines = windows.map((window) => {
            const used = typeof window.usedText === 'string' && window.usedText.length > 0 ? window.usedText : `${window.usedPercent}%`
            const approx = window.approximate === true ? '（页面写的是「不到」，进度条按下界画）' : ''
            const reset = window.resetText ? `，${window.resetText}` : ''
            return `· ${window.short}（${window.label}）：已用 ${used}${approx}${reset}`
          })
          parts.push(`额度${quota.plan ? `（${quota.plan}）` : ''}${resets}:\n${lines.join('\n')}`)
          if (quota.degraded === true) {
            parts.push(`（降级：只读到账户菜单那一个数字——${quota.windowsError ?? ''}）`)
          }
        } else if (quota.ok === true && Number.isFinite(quota.usedPercent)) {
          const resets = Number.isFinite(quota.resets) ? `，可重置 ${quota.resets} 次` : ''
          const degraded = quota.degraded === true ? '（降级：额度页没读到，这只是账户菜单里的数字）' : ''
          parts.push(`额度：已用 ${quota.usedPercent}%${quota.plan ? `（${quota.plan}）` : ''}${resets}${degraded}`)
        } else if (typeof quota.error === 'string' && quota.error.length > 0) {
          parts.push(`额度读不到：${quota.error}`)
        }
      }
      const items = Array.isArray(models?.items) ? models.items : []
      if (items.length > 0) {
        const listed = items
          .map((item) => `${item.current ? '● ' : '· '}${item.name}${item.note ? `（${item.note}）` : ''}`)
          .join('\n')
        parts.push(`可选模型（约 60 秒采样）:\n${listed}`)
      } else if (typeof models?.error === 'string' && models.error.length > 0) {
        parts.push(`模型清单读不到：${models.error}`)
      }
      // MCP 侧：豆包工作这类客户端有没有真的接过（自检名已在宿主半滤掉）。
      if (mcp !== undefined && mcp !== null) {
        const clients = Array.isArray(mcp.clients) ? mcp.clients : []
        if (clients.length === 0) {
          if (mcp.missing === true) {
            parts.push('MCP 客户端：连接器还没有客户端记录（豆包工作那条线没接上；先跑 check-doubao-work.mjs）')
          } else if (typeof mcp.error === 'string' && mcp.error.length > 0) {
            parts.push(`MCP 客户端记录读不到：${mcp.error}`)
          } else {
            parts.push('MCP 客户端：还没有任何真实客户端握手过（自己在端点上探过不算——自检名已滤掉）')
          }
        } else {
          const listed = clients
            .map((client) => `${client.name}${client.version ? `@${client.version}` : ''}（${client.transport || '未知传输'} ×${client.initializations}）`)
            .join('、')
          const age = formatAge(Math.min(...clients.map((client) => (Number.isFinite(client.ageMs) ? client.ageMs : Number.POSITIVE_INFINITY))))
          parts.push(`MCP 客户端：${listed}${age.length > 0 ? ` · 最近握手 ${age}` : ''}`)
        }
      }
      return parts.join('\n')
    }

    /**
     * 一条细进度条（0..100）。
     * track 用背景层级、fill 用状态色，全是主题 token；带 `role="progressbar"` 与
     * `aria-valuenow`，所以读屏也能念出进度，不是纯装饰。
     */
    function progressBar(percent, tone, label) {
      const value = Math.max(0, Math.min(100, Math.round(percent)))
      return h(
        'div',
        {
          role: 'progressbar',
          'aria-valuenow': value,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-label': `${label} ${value}%`,
          style: {
            width: '100%',
            height: 5,
            marginTop: 4,
            borderRadius: 3,
            background: 'var(--dsw-alias-bg-layer-1)',
            overflow: 'hidden',
          },
        },
        h('div', {
          style: {
            width: `${value}%`,
            height: '100%',
            borderRadius: 3,
            background: tone,
            transition: 'width .2s linear',
          },
        }),
      )
    }

    /**
     * 任务进度：**没有可靠百分比就不画条**，绝不编造。
     * 有 `percent` 就用它；`done` 视为 100%；其余（received / started / need_input / failed）
     * 进度未知 → 返回 undefined（那一行只显示文字）。
     */
    function taskPercent(job) {
      if (job === undefined) return undefined
      if (Number.isFinite(job.percent)) return Math.max(0, Math.min(100, job.percent))
      return job.state === 'done' ? 100 : undefined
    }

    /** 一个「色点 + 文字（+ 可选尾部节点 + 可选进度条）」的行。有进度条时行内变成上下两截。 */
    function line(key, tone, text, extraStyle, trailing, bar) {
      return h(
        'div',
        { key, style: { display: 'flex', flexDirection: 'column', minWidth: 0, width: '100%' } },
        [
          h(
            'div',
            {
              key: 'row',
              style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: '100%', ...extraStyle },
            },
            [
              h('span', {
                key: 'dot',
                'aria-hidden': true,
                style: { flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: tone },
              }),
              h(
                'span',
                {
                  key: 'text',
                  style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                },
                text,
              ),
              trailing ?? null,
            ],
          ),
          bar ?? null,
        ],
      )
    }

    /**
     * 设置项：额度/模型采样间隔。
     *
     * 放在 `settings.general.item`——那个位就是「一条不需要独立页面的偏好」。
     * 只依赖 localStorage，不碰宿主配置，所以插件不需要任何 Config schema。
     *
     * 样式**刻意对齐官方那一列的行**（从 `dsh-client-ui-settings-general` 的 CSS 抄的数值）：
     * `border-bottom: .5px solid var(--dsw-alias-border-l2)`、`justify-content: space-between`、
     * `gap: 24px`、`padding: 16px 0`；标题 14/20，描述 12px 次要色。
     * 第一版我用了自造的内联样式、**没画下边框**，结果在那一列里既不像设置项也容易被漏看。
     */
    function SampleIntervalSetting() {
      const [value, setValue] = React.useState(() => readSamplePref())
      return h(
        'div',
        {
          'data-dsh-plugin': 'doubao-status-panel',
          'data-dsh-part': 'sample-setting',
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 24,
            padding: '16px 0',
            width: '100%',
            boxSizing: 'border-box',
            borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
          },
        },
        [
          h('div', { key: 'text', style: { minWidth: 0 } }, [
            h('div', { key: 'title', style: { fontSize: 14, lineHeight: '20px' } }, '豆包状态面板：额度/模型采样间隔'),
            h(
              'div',
              {
                key: 'desc',
                style: {
                  marginTop: 4,
                  fontSize: 12,
                  lineHeight: '16px',
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
              '额度与模型清单只能靠短暂打开一次豆包菜单读取，采样越密菜单闪得越勤',
            ),
          ]),
          h(
            'select',
            {
              key: 'select',
              value,
              'aria-label': '豆包额度与模型采样间隔',
              onChange: (event) => {
                const next = event.target.value
                setValue(next)
                writeSamplePref(next)
              },
              style: {
                flex: '0 0 auto',
                padding: '4px 8px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 13,
              },
            },
            SAMPLE_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
        ],
      )
    }

    /** 侧栏底部的状态徽章。owner 只给一个 `wide`（false = 56px 窄栏）。 */
    function DoubaoStatusBadge({ wide }) {
      // null = 「还没拿到可信数据」或「接口不通」；这两种情况都隐藏徽章。
      const [data, setData] = React.useState(null)
      // 切换模式中/上次失败的原因；失败**照实显示**，不假装成功。
      const [switchState, setSwitchState] = React.useState({ busy: false, error: '' })
      // 自增一次就重启轮询 effect：切换成功后立刻重取，不用等下一个 2 秒。
      const [reloadToken, setReloadToken] = React.useState(0)
      const [expanded, setExpanded] = React.useState(false)
      /**
       * 整体折叠：把豆包工作那几行（上下文/额度两格/明细）收成一行，只留主行。
       * 偏好存 localStorage（和采样/默认程序一样）；默认展开。
       */
      const COLLAPSED_KEY = 'doubao-status-panel:collapsed'
      const [collapsed, setCollapsed] = React.useState(() => {
        try {
          return window.localStorage.getItem(COLLAPSED_KEY) === '1'
        } catch {
          return false
        }
      })
      const toggleCollapsed = () => {
        setCollapsed((value) => {
          const next = value !== true
          try {
            window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
          } catch {
            /* 隐私模式：存不住就算了 */
          }
          return next
        })
      }      // 鼠标是否悬停在徽章上（「仅悬停时采样」用）。
      const hovering = React.useRef(false)

      React.useEffect(() => {
        let alive = true
        let timer = null
        const tick = () => {
          // 每次轮询重读偏好：设置里改完立刻生效，不需要跨组件同步。
          const pref = readSamplePref()
          const url =
            pref === 'hover'
              ? `${API_PATH}?sample=${hovering.current ? '1' : '0'}`
              : `${API_PATH}?sample=1&quotaTtlMs=${pref}&modelsTtlMs=${pref}`
          let request
          try {
            request = fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
          } catch {
            if (alive) setData(null)
            return
          }
          request
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
            .then((payload) => {
              if (alive) setData(payload !== null && typeof payload === 'object' ? payload : null)
            })
            .catch(() => {
              // 接口没挂上 / 网络抖动 / 返回的不是 JSON（例如 SPA fallback 的 HTML）：
              // 当作「没有可显示的状态」，不是错误状态。
              if (alive) setData(null)
            })
        }
        tick()
        timer = setInterval(tick, POLL_MS)
        return () => {
          alive = false
          if (timer !== null) clearInterval(timer)
        }
      }, [reloadToken])

      /** 请求把豆包切到工作模式；成败以接口返回的 ok 为准（宿主半内部已做只读复核）。 */
      const switchToWork = React.useCallback(() => {
        setSwitchState({ busy: true, error: '' })
        let request
        try {
          request = fetch(MODE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode: 'work' }),
          })
        } catch (error) {
          setSwitchState({ busy: false, error: String(error?.message ?? error) })
          return
        }
        request
          .then((response) => response.json().then((payload) => ({ status: response.status, payload })).catch(() => ({ status: response.status, payload: null })))
          .then(({ status, payload }) => {
            if (payload === null || payload.ok !== true) {
              throw new Error(payload?.error ?? `HTTP ${status}`)
            }
            setSwitchState({ busy: false, error: '' })
            setReloadToken((token) => token + 1)
          })
          .catch((error) => setSwitchState({ busy: false, error: String(error?.message ?? error) }))
      }, [])

      if (data === null) return null
      const runtime = data.doubao
      const quota = data.quota
      const models = data.models
      const job = pickJob(data.jobs)
      const modelNote = currentModelNote(models)
      const runtimeLabel = runtimeText(runtime, modelNote)
      const quotaLabel = quotaText(quota)
      // 额度窗口：有 windows 就一个窗口一行（5h / 7d 各一条 5px 条）；否则退回扁平的单个百分比。
      const quotaWindows = Array.isArray(quota?.windows)
        ? quota.windows.filter((window) => Number.isFinite(window?.usedPercent))
        : []
      const quotaLines =
        quotaWindows.length > 0
          ? quotaWindows.map((window, index) =>
              line(
                `quota-${window.id ?? index}`,
                quotaTonePercent(window.usedPercent),
                quotaWindowText(window),
                {
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 11,
                  lineHeight: '14px',
                },
                null,
                progressBar(window.usedPercent, quotaTonePercent(window.usedPercent), `${window.short ?? '额度'} 用量`),
              ),
            )
          : []
      if (job === undefined && runtimeLabel.length === 0 && quotaLabel.length === 0 && quotaLines.length === 0) {
        return null
      }

      const taskTone = job === undefined ? runtimeTone(runtime, modelNote) : STATE_TONE[job.state] ?? IDLE_TONE
      const taskLabel = job === undefined ? runtimeLabel : labelOf(job)
      const showSecondLine = job !== undefined && runtimeLabel.length > 0
      // 只有「豆包在线且不是工作模式」才给切换按钮——工作模式下它没有意义，
      // 豆包没开时点了也没用（那种情况该显示的是「未连接」）。
      const canSwitchToWork = runtime !== undefined && runtime !== null && runtime.connected === true && runtime.mode !== 'work'

      const switchButton = canSwitchToWork
        ? h(
            'button',
            {
              key: 'switch',
              type: 'button',
              'data-dsh-part': 'switch-mode',
              disabled: switchState.busy,
              title: switchState.error.length > 0 ? `上次切换失败：${switchState.error}` : '把豆包切到「本地电脑」（工作模式）——只有工作模式才能回报状态',
              onClick: switchToWork,
              style: {
                flex: '0 0 auto',
                marginLeft: 'auto',
                padding: '1px 6px',
                fontSize: 11,
                lineHeight: '14px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'var(--dsw-alias-bg-layer-1)',
                color: switchState.error.length > 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
                cursor: switchState.busy ? 'default' : 'pointer',
                whiteSpace: 'nowrap',
              },
            },
            switchState.busy ? '切换中…' : switchState.error.length > 0 ? '重试' : '切到工作',
          )
        : null

      // 上下文/额度这几行的颜色统一用品牌蓝（与豆包工作自己那个上下文窗口一致）
      const ACCENT_TONE = readAccentTone()
      const runtimeLineStyle = {
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11,
        lineHeight: '14px',
      }

      /**
       * 豆包工作那一行：**只有真的读到了才显示**（它必须带调试端口启动才可读）。
       *
       * 为什么不做成常驻行：它没开调试端口时是「读不到」，不是「坏了」——常驻一行
       * 「未连接」只会在徽章上常年占地方。读得到时显示模式 + 模型，和上面个人版那条一致。
       */
      const work = data.work
      const workConnected = work !== undefined && work !== null && work.connected === true
      // 上下文用量（只在打开的对话里读得到）。**读不到就不写**，绝不用 0% 充数。
      // 进度条：任务完成度（有可靠百分比才有）+ 每个额度窗口各一条。
      const taskBarValue = taskPercent(job)
      const taskBar = taskBarValue === undefined ? null : progressBar(taskBarValue, taskTone, '任务进度')
      const quotaBarValue =
        quotaWindows.length === 0 && quota?.ok === true && Number.isFinite(quota.usedPercent)
          ? quota.usedPercent
          : undefined
      const quotaBar = quotaBarValue === undefined ? null : progressBar(quotaBarValue, quotaTone(quota), '额度用量')

      // 没有任务时，运行时信息就是主行；此时切换按钮挂在主行尾部。
      const runtimeLine = showSecondLine
        ? line('runtime', runtimeTone(runtime, modelNote), runtimeLabel, runtimeLineStyle, switchButton)
        : line('runtime', runtimeTone(runtime, modelNote), runtimeLabel, switchButton === null ? undefined : { gap: 6 }, switchButton)
      // 降级载荷（没有 windows）：只有一条「额度 N%」+ 一条进度条；读不到就整行不显示。
      const flatQuotaLine =
        quotaWindows.length === 0 && quotaLabel.length > 0
          ? line('quota', quotaTone(quota), quotaLabel, runtimeLineStyle, null, quotaBar)
          : null

      // 第一行：豆包工作的模式与模型（额度计数改成下面自己的行，和截图里的分区一致）
      const workUsagePercent = Number.isFinite(work?.usage?.percent) ? work.usage.percent : undefined
      const workDetail = data.workQuota
      const fmtK = (value) => (Number.isFinite(value) ? (value >= 1000 ? Math.round(value / 100) / 10 + 'K' : String(value)) : '')
      const workLabel = workConnected
        ? '豆包工作 · ' + (work.modeRaw || work.mode) + (typeof work.model === 'string' && work.model.length > 0 ? ' · ' + work.model : '')
        : ''
      // 第二行：上下文用量（绝对值 + 百分比）单独一行，带进度条
      const contextPercent = Number.isFinite(workDetail?.context?.percent) ? workDetail.context.percent : workUsagePercent
      const contextText = workDetail?.context
        ? '上下文 ' + fmtK(workDetail.context.used) + '/' + fmtK(workDetail.context.total) + ' · ' + workDetail.context.percent + '%'
        : Number.isFinite(workUsagePercent) ? '上下文 ' + workUsagePercent + '%' : ''
      // 折叠开关（紧凑/展开）：点一下切明细
      const detailToggle = h('button', {
        type: 'button',
        'data-dsh-part': 'context-toggle',
        'aria-expanded': expanded === true ? 'true' : 'false',
        onClick: () => setExpanded((value) => value !== true),
        style: { flex: '0 0 auto', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      }, expanded === true ? '▾' : '▸')
      const contextLine = contextText.length > 0
        ? line('context', ACCENT_TONE, contextText, runtimeLineStyle, detailToggle, Number.isFinite(contextPercent) ? progressBar(contextPercent, ACCENT_TONE, '上下文用量') : null)
        : null
      // 额度两格：各自一行 + 进度条（与截图一致）
      const counterPercent = (counter) => (counter !== null && counter !== undefined && Number(counter.limit) > 0 ? Math.round((Number(counter.used) / Number(counter.limit)) * 100) : undefined)
      const sessionPercent = counterPercent(workDetail?.session)
      const sessionLine = workDetail?.session
        ? line('work-session', ACCENT_TONE, '当前时段 ' + workDetail.session.used + '/' + workDetail.session.limit + (workDetail.session.resetText ? '（' + workDetail.session.resetText + ' 重置）' : ''), runtimeLineStyle, null, Number.isFinite(sessionPercent) ? progressBar(sessionPercent, ACCENT_TONE, '当前时段用量') : null)
        : null
      const weekPercent = counterPercent(workDetail?.week)
      const weekLine = workDetail?.week
        ? line('work-week', ACCENT_TONE, '近 7 天 ' + workDetail.week.used + '/' + workDetail.week.limit, runtimeLineStyle, null, Number.isFinite(weekPercent) ? progressBar(weekPercent, ACCENT_TONE, '近 7 天用量') : null)
        : null
      // 展开时的 4 条明细（对话消息 / 系统提示词 / 工具及子智能体 / 技能）
      const detailLines = expanded === true && Array.isArray(workDetail?.breakdown)
        ? workDetail.breakdown.map((item, index) => line('detail-' + index, item.percent > 0 ? ACCENT_TONE : IDLE_TONE, item.label + ' ' + item.percent + '%', runtimeLineStyle, null))
        : []
      // 整体折叠开关（▾ 展开 / ▸ 收起），挂在工作行末尾
      const collapseToggle = h(
        'button',
        {
          type: 'button',
          'data-dsh-part': 'collapse-toggle',
          'aria-expanded': collapsed === true ? 'false' : 'true',
          'aria-label': collapsed === true ? '展开豆包工作信息' : '折叠豆包工作信息',
          onClick: toggleCollapsed,
          style: { flex: '0 0 auto', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
        },
        collapsed === true ? '▸' : '▾',
      )
      const workLine = workLabel.length > 0 ? line('work', runtimeTone(work, ''), workLabel, runtimeLineStyle, collapseToggle) : null
      // 折叠时这几行整块不渲染（明细本来就是可展开的，整体折叠优先）
      const workBlock = collapsed === true ? [] : [contextLine, sessionLine, weekLine, ...detailLines]

      return h(
        'div',
        {
          'data-dsh-plugin': 'doubao-status-panel',
          'data-dsh-part': 'badge',
          'data-doubao-state': job === undefined ? 'idle' : job.state,
          'data-doubao-mode': (runtime && runtime.mode) || 'unknown',
          'data-doubao-quota': quotaLabel.length > 0 ? String(quota.usedPercent) : 'unknown',
          role: 'status',
          'aria-label': `豆包：${taskLabel}`,
          title: tooltipFor(job, runtime, quota, models, data.mcp, data.work),
          // 「仅悬停时采样」模式：鼠标进来立刻采一次（重启轮询 effect 触发立即 fetch），
          // 离开只是把标记放下，不额外请求。
          onMouseEnter: () => {
            hovering.current = true
            if (readSamplePref() === 'hover') setReloadToken((token) => token + 1)
          },
          onMouseLeave: () => {
            hovering.current = false
          },
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'stretch',
            justifyContent: 'center',
            gap: 2,
            minWidth: 0,
            maxWidth: '100%',
            boxSizing: 'border-box',
            padding: wide ? '4px 8px' : '6px',
            borderRadius: wide ? 10 : '50%',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            lineHeight: '16px',
          },
        },
        wide
          ? job === undefined
            ? // 没有任务：运行时那一行就是主行（切换按钮挂它尾部），下面逐个额度窗口
              [runtimeLine, ...quotaLines, flatQuotaLine, workLine, ...workBlock]
            : // 有任务：任务那一行带自己的进度条（没有可靠百分比时 taskBar 为 null）
              [line('main', taskTone, taskLabel, undefined, null, taskBar), runtimeLine, ...quotaLines, flatQuotaLine, workLine, ...workBlock]
          : [
              // 窄栏（56px rail）：只放一个状态色点，任务优先、否则表示模式。
              h('span', {
                key: 'dot',
                'aria-hidden': true,
                style: { alignSelf: 'center', width: 8, height: 8, borderRadius: '50%', background: taskTone },
              }),
            ],
      )
    }

    /**
     * 徽章高亮色（上下文/额度那几行用）：**任意自定义颜色**，存 localStorage。
     * 值为 `theme` 时用品牌蓝 token（浅色/深色主题下都稳）；自定义值必须是 #rrggbb，
     * 非法值一律回退到 theme——绝不把坏值写到界面上。
     */
    const ACCENT_PREF_KEY = 'doubao-status-panel:accent'
    const ACCENT_DEFAULT = 'theme'
    const ACCENT_HEX = /^#[0-9a-fA-F]{6}$/
    function readAccentValue() {
      try {
        const stored = window.localStorage.getItem(ACCENT_PREF_KEY)
        return typeof stored === 'string' && ACCENT_HEX.test(stored) ? stored.toLowerCase() : ACCENT_DEFAULT
      } catch {
        return ACCENT_DEFAULT
      }
    }
    function readAccentTone() {
      const value = readAccentValue()
      return value === ACCENT_DEFAULT ? 'var(--dsw-alias-brand-primary)' : value
    }
    function writeAccentValue(value) {
      try {
        if (value === ACCENT_DEFAULT) window.localStorage.removeItem(ACCENT_PREF_KEY)
        else if (ACCENT_HEX.test(String(value))) window.localStorage.setItem(ACCENT_PREF_KEY, String(value).toLowerCase())
      } catch {
        /* 隐私模式：存不住就算了 */
      }
    }

    /** 设置页里的一行：左边标题+描述，右边控件，底部细分隔线（与官方设置行同构）。 */
    function SettingRow({ title, description, children, last }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 24,
            padding: '16px 0',
            width: '100%',
            boxSizing: 'border-box',
            ...(last === true ? {} : { borderBottom: '0.5px solid var(--dsw-alias-border-l2)' }),
          },
        },
        [
          h('div', { key: 'text', style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } }, [
            h('div', { key: 'title', style: { fontSize: 14, lineHeight: '20px' } }, title),
            description === undefined
              ? null
              : h('div', { key: 'desc', style: { fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' } }, description),
          ]),
          children ?? null,
        ],
      )
    }

    /**
     * 独立的「豆包」设置页（`settings.section` 的一项）。
     *
     * 页里四件事：默认打开的程序（偏好，存 localStorage）、采样间隔（**从「通用」页迁来**）、
     * 当前读数（只读，来自 `/doubao-status/api`）、诊断命令（浏览器不能直接跑脚本，只给命令与说明）。
     */
    function DoubaoSettingsSection() {
      const [target, setTarget] = React.useState(readTargetPref())
      const [accent, setAccent] = React.useState(readAccentValue())
      const [readings, setReadings] = React.useState(null)
      const [readError, setReadError] = React.useState('')
      React.useEffect(() => {
        let alive = true
        fetch('/doubao-status/api?sample=0')
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((data) => {
            if (alive) setReadings(data)
          })
          .catch((error) => {
            if (alive) setReadError(String(error?.message ?? error))
          })
        return () => {
          alive = false
        }
      }, [])
      const choose = (value) => {
        setTarget(value)
        writeTargetPref(value)
      }
      const radio = (option) =>
        h(
          'button',
          {
            key: option.value,
            type: 'button',
            'data-dsh-part': `target-option-${option.value}`,
            'aria-pressed': target === option.value ? 'true' : 'false',
            onClick: () => choose(option.value),
            style: {
              padding: '4px 10px',
              fontSize: 12,
              lineHeight: '18px',
              borderRadius: 6,
              cursor: 'pointer',
              border: `1px solid ${target === option.value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
              background: target === option.value ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: target === option.value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            },
          },
          option.label,
        )
      const line = (text, key) =>
        h('div', { key, style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, text)
      const usageText = (state) => {
        const parts = []
        if (state?.connected === true) {
          parts.push(`${state.modeRaw || state.mode}`)
          if (typeof state.model === 'string' && state.model.length > 0) parts.push(state.model)
          if (Number.isFinite(state.usage?.percent)) parts.push(`上下文 ${state.usage.percent}%`)
        } else {
          parts.push('读不到（未连接 / 没带调试端口）')
        }
        return parts.join(' · ')
      }
      return h('div', { 'data-dsh-plugin': 'doubao-status-panel', 'data-dsh-part': 'settings-section' }, [
        SettingRow({
          title: '默认打开的程序',
          description: TARGET_OPTIONS.find((option) => option.value === target)?.hint ?? '',
          children: h('div', { key: 'radio', style: { display: 'flex', gap: 8, flexShrink: 0 } }, TARGET_OPTIONS.map(radio)),
        }),
        SettingRow({
          title: '徽章高亮色',
          description: '任意自定义颜色（上下文与额度那几行用）；「跟随主题」用品牌蓝，浅色/深色下最稳',
          children: h('div', { key: 'accent', style: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 } }, [
            h('input', {
              key: 'picker',
              type: 'color',
              'data-dsh-part': 'accent-picker',
              'aria-label': '徽章高亮色',
              value: accent === ACCENT_DEFAULT ? '#4d6bfe' : accent,
              onChange: (event) => {
                const value = String(event?.target?.value ?? '').toLowerCase()
                if (ACCENT_HEX.test(value)) {
                  setAccent(value)
                  writeAccentValue(value)
                }
              },
              style: { width: 32, height: 24, padding: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, background: 'transparent', cursor: 'pointer' },
            }),
            h(
              'button',
              {
                key: 'reset',
                type: 'button',
                'data-dsh-part': 'accent-reset',
                onClick: () => {
                  setAccent(ACCENT_DEFAULT)
                  writeAccentValue(ACCENT_DEFAULT)
                },
                style: { padding: '2px 8px', fontSize: 12, lineHeight: '18px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
              },
              '跟随主题',
            ),
          ]),
        }),
        SampleIntervalSetting(),
        SettingRow({
          title: '当前读数',
          description: '只读：来自面板接口（2 秒轮询的那一份数据）',
          children: h('div', { key: 'readings', style: { display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right', minWidth: 0 } }, [
            line(`个人版：${usageText(readings?.doubao)}`, 'personal'),
            line(`豆包工作：${usageText(readings?.work)}`, 'work'),
            readError.length > 0 ? line(`接口读不到：${readError}`, 'err') : null,
          ]),
        }),
        SettingRow({
          title: '诊断命令',
          description: '浏览器里不能直接跑脚本，复制到终端执行（详见仓库 scripts/ 与 doubao-cdp/README.md）',
          last: true,
          children: h('div', { key: 'cmds', style: { display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'right', fontFamily: 'monospace', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, [
            line('node scripts/check-doubao-work.mjs', 'doctor'),
            line('node cdp.mjs context-window --target work', 'usage'),
            line('node scripts/doubao-work-debug.mjs --status', 'launch'),
          ]),
        }),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 槽注册整体包 try/catch：注册到未声明的槽会在加载时抛错，而一个装饰
        // 组件出错不应该让整个界面起不来。
        try {
          ctx.slots.inject(SLOT, () => {
            try {
              return ctx.slots.register({ name: SLOT, id: 'doubao-status-panel', order: 5 }, DoubaoStatusBadge)
            } catch {
              return () => {}
            }
          })
        } catch {
          /* 静默：没有徽章也比白屏好 */
        }

        // 独立的「豆包」设置页：`settings.section` 每一项就是一个设置页（宿主只给 close）。
        // 这一页承载：默认打开的程序 / 采样间隔（从「通用」页迁过来）/ 当前读数 / 诊断命令。
        try {
          ctx.slots.inject('settings.section', () => {
            try {
              return ctx.slots.register(
                { name: 'settings.section', id: 'doubao', order: 26, label: '豆包' },
                DoubaoSettingsSection,
              )
            } catch {
              return () => {}
            }
          })
        } catch {
          /* 静默 */
        }
      },
    }
  },
})
