/**
 * dsh-xiaoshuo 客户端 —— 「连载」面板
 *
 * ## 契约（照抄 dsh-pangu 那份确定能工作的，2026-09-30）
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... module.exports = {apply, inject} } })
 *
 * 我此前自己造了一套 UMD 包装（`(function(exports, require){...})`）并按它写测试，
 * 结果**面板从来没显示过**：那个文件结构宿主根本不认，`exports.apply` 从未被赋值，
 * 而宿主侧表现为「插件加载了但没有 apply」，比直接加载失败更难查。
 * ⇒ 教训：**契约照抄能工作的那份，不要自己"设计"一个。**
 *
 * ## 挂在哪里：右侧边栏（这是原始设计，2026-09-30 被我擅自改成标签页又改回来）
 *
 * 插槽是**三层嵌套**的，所以顶层 data-slot 清单里根本看不到它：
 *
 *   rightbar                       （整栏，宿主提供）
 *     └─ rightbar.session          （keyed，按会话）
 *          └─ sidebar.right.pane.tab   ← 我们注册的地方
 *
 * 我一度以为 `sidebar.right.pane.tab` 「在当前版本不存在」——
 * 错在**只在顶层 data-slot 里查**，而右栏没展开时整棵子树都不挂载。
 *
 * 三处真实的坑（都踩过）：
 *   0. **`ctx.slots` 同样不能顶层解引用**，必须 `ctx.get('slots')` ——
 *      报错是 `cannot get property "slots" without inject`。
 *      这条与下面第 1 条同源，而我第一次只改了 tabs、漏了 slots。
 *   1. `sidebarRightTabs` 是**懒加载服务**，必须用
 *      `ctx.inject(['sidebarRightTabs'], injected => injected.get('sidebarRightTabs'))`
 *      —— 响应式注入，服务晚到会自动重跑；顶层解引用只会拿到 undefined 且永不再来。
 *   2. `tabs.register` 的参数是 `{ id, kind, priority, title, guide }`，
 *      少了 `kind` / `priority` 不报错，但不会出现在右栏。
 *   3. 内容插槽是 **keyed** 的，用 `key: id` 绑定 tab，不是 `id`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-xiaoshuo',
  factory: (require) => {
  // ⚠️ 这两行照抄 dsh-pangu 的写法（那份确定能工作）：
  //   1) module 由 factory **自己造**，不是宿主传进来的 —— 我之前用宿主的 module 参数，
  //      结果 module 是 undefined，`module.exports = {...}` 静默失效，apply 永远不是函数。
  //   2) React 用 require('react') 拿，不是全局 —— 宿主已经把它打进 require 了。
  const module = { exports: {} }
  const React = require('react')
  const h = React.createElement



  const API = '/xiaoshuo/api'

  /* ── 设计令牌（跟随 DSH 亮/暗两套）── */
  const T = {
    ink: 'var(--dsh-ink, #1c2128)',
    dim: 'var(--dsh-ink-2, #6b7280)',
    faint: 'var(--dsh-ink-3, #9aa3ad)',
    line: 'var(--dsh-line, #e3e6ea)',
    card: 'var(--dsh-surface, #f6f7f9)',
    accent: 'var(--dsh-accent, #2f6feb)',
    ok: '#1f9d55',
    warn: '#c47f16',
    bad: '#d3453b',
    radius: 8,
    gap: 10,
  }

  const s = (o) => Object.assign({}, o)

  /* ── 小组件 ── */
  // ⚠️ children 必须在 props 里显式取出再传给 h() 的第三个参数；
  // 直接写 (props) 会把 children 丢掉（h 的多参数不会被组件自动透传）。
  const Card = (props) => h('div', {
    style: s({
      border: `1px solid ${T.line}`, borderRadius: T.radius,
      padding: '10px 11px', background: T.card, ...props.style,
    }),
  }, props.children)

  const Label = (t) => h('div', {
    style: s({ fontSize: 11, color: T.faint, letterSpacing: '.04em', marginBottom: 6 }),
  }, t)

  const Dot = (color) => h('span', { style: s({ display: 'inline-block', width: 7, height: 7, borderRadius: 4, background: color, marginRight: 6 }) })

  const Btn = (label, onClick, primary, disabled) => h('button', {
    onClick, disabled,
    style: s({
      flex: '1 1 auto', padding: '6px 8px', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
      background: primary ? T.accent : 'transparent',
      color: primary ? '#fff' : T.ink,
      border: `1px solid ${primary ? T.accent : T.line}`,
      borderRadius: 6, opacity: disabled ? .5 : 1,
    }),
  }, label)

  const kv = (k, v, color) => h('div', { style: s({ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, lineHeight: 1.7 }) },
    h('span', { style: s({ color: T.dim }) }, k),
    h('span', { style: s({ color: color || T.ink, fontVariantNumeric: 'tabular-nums' }) }, v))

  /* ── 进度条：分段刻度，每段 5 章 ── */
  function Progress({ written, cap, published }) {
    const segs = []
    for (let i = 0; i < cap; i += 5) {
      const n = Math.min(5, cap - i)
      const done = Math.max(0, Math.min(n, published - i))
      segs.push(h('div', { key: i, style: s({ flex: n, display: 'flex', gap: 2 }) },
        ...Array.from({ length: n }, (_, k) => h('div', {
          key: k,
          style: s({
            height: 6, borderRadius: 2,
            background: k < done ? T.ok : (i + k < written ? T.accent : T.line),
          }),
        })),
      ))
    }
    return h('div', { style: s({ display: 'flex', gap: 4, margin: '4px 0 6px' }) }, segs)
  }

  /* ── 章节徽标 ── */
  function Chip({ c, published, reviewed }) {
    const isPub = published.includes(c.index)
    const isRev = reviewed.includes(c.index)
    return h('div', { style: s({ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', fontSize: 12 }) },
      h('span', { style: s({ color: T.faint, fontVariantNumeric: 'tabular-nums', width: 26 }) }, String(c.index).padStart(2, '0')),
      h('span', { style: s({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }, c.title),
      h('span', { style: s({ color: T.faint, fontSize: 11, fontVariantNumeric: 'tabular-nums' }) }, `${c.chars}`),
      h('span', {
        style: s({
          fontSize: 10, padding: '1px 5px', borderRadius: 4, lineHeight: '15px',
          background: isPub ? (isRev ? T.ok : T.warn) : 'transparent',
          color: isPub ? '#fff' : T.faint,
          border: isPub ? 'none' : `1px solid ${T.line}`,
        }),
      }, isPub ? (isRev ? '已审' : '已发') : '待发'),
    )
  }

  /* ── 主面板 ── */
  function Panel(props) {
    const [snap, setSnap] = React.useState(null)
    const [sched, setSched] = React.useState([])
    const [busy, setBusy] = React.useState('')
    const [msg, setMsg] = React.useState(null)
    const [report, setReport] = React.useState(null)
    const [fail, setFail] = React.useState('')

    const load = React.useCallback(async () => {
      try {
      const r = await fetch(`${API}/status`)
        const j = await r.json()
        if (j.ok) { setSnap(j.snapshot); setSched(j.schedule || []); setFail('') }
        else setFail(j.error || '状态接口返回异常')
      } catch (e) { setFail('读状态失败：' + e.message) }
    }, [])

    React.useEffect(() => {
      load()
      const t = setInterval(load, 20000)
      return () => clearInterval(t)
    }, [load])

    const fire = async (action, label) => {
      setBusy(action); setMsg(null)
      try {
        const r = await fetch(`${API}/trigger`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        const j = await r.json()
        setMsg({ ok: j.ok, text: j.ok ? `${label}：${j.note || j.output || '已启动'}` : `${label}失败：${j.error || '未知'}` })
        if (j.ok) setTimeout(load, 3000)
      } catch (e) { setMsg({ ok: false, text: `${label}失败：${e.message}` }) }
      setBusy('')
    }

    if (fail && !snap) {
      return h('div', { style: s({ padding: 14, fontSize: 12, color: T.bad }) },
        '读取流水线状态失败',
        h('div', { style: s({ marginTop: 6, color: T.dim, fontSize: 11 }) }, fail),
        h('button', { onClick: load, style: s({ marginTop: 10, padding: '4px 10px', fontSize: 12, cursor: 'pointer', background: 'transparent', border: `1px solid ${T.line}`, borderRadius: 6, color: T.ink }) }, '重试'))
    }
    if (!snap) {
      return h('div', { style: s({ padding: 14, fontSize: 12, color: T.faint }) }, '读取流水线状态…')
    }

    const p = snap.progress
    const cap = p.volumeCap || 60
    const hb = snap.heartbeat
    const hbColor = !hb ? T.faint : hb.overall === 'OK' ? T.ok : hb.overall === 'WARN' ? T.warn : T.bad
    const badChecks = hb ? Object.entries(hb.results || {}).filter(([, v]) => !v.ok) : []
    const recent = snap.chapters.slice(-7)
    const pendingDecisions = snap.pendingDecisions || 0

    // 「需要处理」块。⚠️ 写成「三元表达式嵌在 h() 参数位」时，Card 那个多行 props
    // 很容易让末尾的 : null 悬空（第一版就栽在这，报 Unexpected token ')'）。
    // 先算成变量、再放进参数列表，就不会有这个问题。
    const needAction = (pendingDecisions > 0 || badChecks.length > 0)
      ? h(Card, { style: s({ borderColor: T.warn, background: 'transparent' }) },
          Label('需要处理'),
          pendingDecisions > 0
            ? h('div', { style: s({ fontSize: 12, color: T.warn }) },
                `${pendingDecisions} 条待裁决（自动裁决器处理中）`)
            : null,
          badChecks.map(([k, v]) => h('div', {
            key: k, style: s({ fontSize: 11, color: T.bad, marginTop: 3 }),
          }, `${k}：${String(v.msg).slice(0, 60)}`)))
      : null

    return h('div', { style: s({ padding: 12, display: 'flex', flexDirection: 'column', gap: T.gap, fontSize: 12 }) },

      /* 头部 */
      h('div', { style: s({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }) },
        h('div', { style: s({ fontSize: 14, fontWeight: 650, letterSpacing: '.01em' }) }, snap.book),
        h('div', { style: s({ fontSize: 11, color: T.faint }) },
          hb ? `心跳 ${hb.overall === 'OK' ? '正常' : hb.overall}` : '心跳无记录')),

      /* 进度 */
      h(Card, null,
        h('div', { style: s({ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: T.dim }) },
          h('span', null, '卷一进度'),
          h('span', { style: s({ fontVariantNumeric: 'tabular-nums' }) }, `${p.latest || 0} / ${cap} 章`)),
        h(Progress, { written: p.written, cap, published: p.lastPublished || 0 }),
        h('div', { style: s({ display: 'flex', gap: 14, fontSize: 11, color: T.faint }) },
          h('span', null, '已发 ', h('b', { style: s({ color: T.ink, fontWeight: 600 }) }, String(snap.published.length))),
          h('span', null, '待发 ', h('b', { style: s({ color: T.ink, fontWeight: 600 }) }, String(snap.buffer.length))),
          h('span', null, '已审 ', h('b', { style: s({ color: T.ink, fontWeight: 600 }) }, String(snap.reviewed.length))))),

      needAction,

      /* 定时 */
      h(Card, null,
        Label('定时任务'),
        sched.length === 0
          ? h('div', { style: s({ fontSize: 12, color: T.bad }) }, '未读到 crontab')
          : sched.map((j, i) => h('div', { key: i, style: s({ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0' }) },
            h('span', { style: s({ color: T.dim }) }, j.label),
            h('code', { style: s({ color: T.ink, fontSize: 11, fontVariantNumeric: 'tabular-nums' }) }, j.expr)))),

      /* 操作 */
      h(Card, null,
        Label('操作'),
        h('div', { style: s({ display: 'flex', gap: 6, flexWrap: 'wrap' }) },
          Btn('写一章', () => fire('write', '写作'), true, busy === 'write'),
          Btn('审稿', () => fire('review', '审稿'), false, busy === 'review'),
          Btn('发布', () => fire('publish', '发布'), false, busy === 'publish'),
          Btn('巡检', () => fire('heartbeat', '巡检'), false, busy === 'heartbeat'),
          h('button', {
            onClick: async () => {
              const r = await fetch(`${API}/report`); const j = await r.json()
              setReport(j.ok ? j : null)
              if (!j.ok) setMsg({ ok: false, text: j.error || '还没有审稿报告' })
            },
            style: s({ flex: '1 1 auto', padding: '6px 8px', fontSize: 12, cursor: 'pointer', background: 'transparent', border: `1px solid ${T.line}`, borderRadius: 6, color: T.ink }),
          }, '审稿报告')),
        msg ? h('div', {
          style: s({
            marginTop: 8, fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap',
            color: msg.ok ? T.ok : T.bad,
          }),
        }, msg.text) : null),

      /* 章节 */
      h(Card, null,
        Label(`章节（最近 ${recent.length} / 共 ${snap.chapters.length}）`),
        recent.length === 0
          ? h('div', { style: s({ fontSize: 12, color: T.faint }) }, '（尚无）')
          : recent.map(c => h(Chip, { key: c.index, c, published: snap.published, reviewed: snap.reviewed }))),

      /* 报告 */
      report ? h(Card, null,
        Label(report.file || '审稿报告'),
        h('pre', {
          style: s({
            maxHeight: 340, overflow: 'auto', whiteSpace: 'pre-wrap',
            fontSize: 11, lineHeight: 1.65, margin: 0, color: T.ink,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }),
        }, report.text || ''),
        h('button', {
          onClick: () => setReport(null),
          style: s({ marginTop: 8, padding: '4px 10px', fontSize: 11, cursor: 'pointer', background: 'transparent', border: `1px solid ${T.line}`, borderRadius: 6, color: T.ink }),
        }, '关闭')) : null,

      h('div', { style: s({ fontSize: 10, color: T.faint, lineHeight: 1.6, marginTop: 2 }) },
        '只读状态，不改内容。正文与设定以工作区纯文本为准，AGENT.md 是唯一权威。'),
    )
  }

  // 右栏 tab 的标题（宿主用它在 tab 栏画标题）
function TabTitle() {
  return h('div', { style: s({ fontSize: 12, padding: '0 4px' }) }, '连载')
}

/* ── 挂载 ── */
  const TAB_ID = 'dsh-xiaoshuo'

async function apply(ctx) {
  try {
    const TAB = 'dsh-xiaoshuo'

    // ① 注册 tab 类型 —— 走响应式注入，服务晚到会自动重跑这一步
    ctx.inject(['sidebarRightTabs'], (injected) => {
      const tabs = injected.get('sidebarRightTabs')
      if (tabs === undefined) return
      const disposeType = tabs.register({
        id: TAB,
        kind: 'xiaoshuo',
        priority: 'extension',
        title: () => '连载',
        guide: [{
          id: 'open', order: 20, title: () => '连载',
          description: () => '流水线进度、定时与巡检',
        }],
      })

      // ② 注册内容插槽（keyed：用 key 绑到上面那个 tab id）
      const disposers = []
      try {
        disposers.push(ctx.get('slots').inject('sidebar.right.pane.tab', () =>
          ctx.get('slots').register(
            { name: 'sidebar.right.pane.tab', key: TAB,
              inject: (sessionId) => ({ ...injected, sessionId }) },
            Panel,
          )))
        disposers.push(ctx.get('slots').inject('sidebar.right.pane.tab.title', () =>
          ctx.get('slots').register(
            { name: 'sidebar.right.pane.tab.title', key: TAB,
              inject: () => ({ title: () => '连载' }) },
            TabTitle,
          )))
      } catch (e) {
        // slots.inject 在 ctx.inject 的回调里执行，异常到不了外层 try —— 这里单独兜住。
        console.error('[dsh-xiaoshuo] 内容插槽注册失败:', e)
      }
      return () => {
        for (const d of disposers.reverse()) { try { d() } catch {} }
        try { disposeType() } catch {}
      }
    })
  } catch (e) { console.error('[dsh-xiaoshuo] apply error:', e) }
}

const inject = apply
module.exports = { apply, inject }
  return module.exports
  },
})
