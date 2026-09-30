/**
 * dsh-xiaoshuo 客户端 —— 右侧边栏「连载」面板
 *
 * ## 契约（抄自 dsh-pangu，那份确定能工作）
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... module.exports = {apply, inject} } })
 *   · factory **只接 require 一个参数**，module 由工厂内部自造（`const module = { exports: {} }`）
 *   · React 走 `require('react')`，不是全局
 *   · 结果靠 `return module.exports` 交回，不是写进传入的 exports
 *
 * ## 挂载：右侧边栏
 *
 * 插槽是三层嵌套的，顶层 data-slot 清单里看不到：
 *
 *   rightbar  →  rightbar.session  →  sidebar.right.pane.tab
 *
 * 三处硬约束（都踩过）：
 *   1. `sidebarRightTabs` 与 `slots` 都是**懒加载服务**，必须
 *      `ctx.inject(['sidebarRightTabs'], inj => inj.get(...))` / `ctx.get('slots')`，
 *      模块顶层解引用只会拿到 undefined 且永不再来。
 *   2. `tabs.register({ id, kind, priority, title, guide })` 少了 kind/priority
 *      **不报错**，但不会出现在右栏。
 *   3. 内容插槽是 **keyed** 的，用 `key: id` 绑定 tab，不是 `id`。
 *   另：`tabs.register` 只注册 tab **类型**（出现在右栏「+」菜单），
 *   tab 实例要用户点「+」创建一次，之后 dockkit 按会话记住。
 *
 * ## 视觉
 *
 * 设计语言对齐「盘古」标签页：眉标 + 大标题 + 一句话说明 + 圆环指标 + 图表 + 小数字阵列。
 * 全部颜色走 `--dsw-alias-*` 真实令牌（**不要编名字** —— var() 带兜底值时
 * 错令牌不会报错，只会在暗色下悄悄失效）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-xiaoshuo',
  factory: (require) => {
  const module = { exports: {} }
  const React = require('react')
  const h = React.createElement
  const API = '/xiaoshuo/api'

/* ── 设计令牌 ────────────────────────────────────────────────────────
 * 取自实测（亮 / 暗）：
 *   label-primary     #0f1115 / #f9fafb      主文字
 *   label-secondary   #61666b / #cfd3d6      次文字
 *   label-caption     #adb2b8 / #81858c      弱文字
 *   bg-layer-1/2/3    #fff / #232324 · #2c2c2e · #353638
 *   border-l1/l2/l3   #0000000a / #ffffff0f …
 *   state-success-primary  #22c55e
 *   state-business-primary #4176e6           「已写未发」用它，不是品牌色（品牌色是反色对）
 *   state-warn-primary     #f59e0b
 *   state-error-primary    #ec1313 / #f25a5a
 */
const T = {
  ink:    'var(--dsw-alias-label-primary, #0f1115)',
  dim:    'var(--dsw-alias-label-secondary, #61666b)',
  faint:  'var(--dsw-alias-label-caption, #adb2b8)',
  /* 层次关系（2026-10-01 按用户反馈定稿）：
   *
   *   容器（本面板根节点）= 透明，沿用 DSH 自己的面板底
   *   卡片               = 半透明叠加，从底色里浮出来
   *
   * 为什么不是"给容器上浅灰"：DSH 的**亮色主题是平的** —— bg-layer-1/2/3 与
   * bg-base 全是 #fff，没有更深的底色令牌可用；而暗色下 bg-skeleton 是
   * 半透明白（#ffffff14），会给容器**提亮**而不是压暗，
   * 于是"卡片比容器亮"这条关系在两套主题里方向相反。
   * 反过来做（卡片浮起）就没有这个问题：
   *   亮色  页面 #fff      → 卡片 rgba(0,0,0,.04)     ≈ #f5f5f5  更深 ✓
   *   暗色  页面 #151517   → 卡片 rgba(255,255,255,.08) ≈ #2a2a2c  更亮 ✓
   * 两套主题下卡片都与底不同，且不需要主题分支。
   */
  // 用 color-mix 把底色与文字色按比例混出一层"面"：
  //   亮色 #fff ⊕ 8% #0f1115 ≈ #ececec（明显区别于白底）
  //   暗色 #151517 ⊕ 8% #f9fafb ≈ #272729（明显亮于底）
  // 只靠 bg-skeleton(4%) 太淡；这个比例两套主题下都看得清。
  card:   'color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 92%, '
        + 'var(--dsw-alias-label-primary, #0f1115) 8%)',
  // 三层阴影，抄盘古 --v3-card-shadow：顶部内高光 + 大范围柔影 + 近距薄影。
  // 光换填充色不够 —— 亮色下 #f5f5f5 与 #fff 只差 4%，需要阴影才有"浮起来"的层次。
  shadow: '0 1px 0 var(--dsw-elevation-stroke-color, rgba(255,255,255,.5)) inset, '
        + '0 10px 24px -18px rgba(0,0,0,.28), '
        + '0 2px 6px -3px rgba(0,0,0,.10)',
  card2:  'var(--dsw-alias-bg-layer-2, transparent)',
  rail:   'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.16))',
  track:  'var(--dsw-alias-bg-skeleton, rgba(127,127,127,.14))',
  line:   'var(--dsw-alias-border-l1, rgba(127,127,127,.18))',
  line2:  'var(--dsw-alias-border-l2, rgba(127,127,127,.30))',
  hover:  'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.10))',
  edge:   'var(--dsw-elevation-stroke-color, rgba(127,127,127,.22))',
  brand:  'var(--dsw-alias-brand-primary, #2f6feb)',
  onBrand:'var(--dsw-alias-label-primary-foreground, #fff)',
  ok:     'var(--dsw-alias-state-success-primary, #22c55e)',
  biz:    'var(--dsw-alias-state-business-primary, #4176e6)',
  warn:   'var(--dsw-alias-state-warn-primary, #f59e0b)',
  bad:    'var(--dsw-alias-state-error-primary, #ef4444)',
  onBadge:'#0f1115',      // 徽标底是亮色（绿/蓝/琥珀），两套主题下都该用深字
}
const RADIUS = 10
const GAP = 12

const s = (o) => Object.assign({}, o)
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/* ── 基础件 ───────────────────────────────────────────────────────── */

const Card = (props) => h('div', {
  style: s({
    border: `1px solid ${T.line}`, borderRadius: RADIUS,
    background: T.card, boxShadow: T.shadow,
    padding: '12px 13px', ...props.style,
  }),
}, props.children)

/** 眉标：小号大写 + 字距，盘古那种「PANGU / CONTROL ROOM」 */
const Eyebrow = (t, extra) => h('div', {
  style: s({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    fontSize: 10, letterSpacing: '.13em', textTransform: 'uppercase',
    color: T.faint, fontWeight: 600,
  }),
}, h('span', null, t), extra || null)

/** 章节/区块小标题 */
const SectionTitle = (t, extra) => h('div', {
  style: s({
    display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    fontSize: 11, color: T.dim, fontWeight: 600, marginBottom: 8,
  }),
}, h('span', null, t), extra ? h('span', { style: s({ color: T.faint, fontWeight: 400 }) }, extra) : null)

const Pill = (text, color) => h('span', {
  style: s({
    fontSize: 10, lineHeight: '16px', padding: '0 7px', borderRadius: 9,
    color, border: `1px solid ${color}`, opacity: .95, whiteSpace: 'nowrap',
  }),
}, text)

/* ── 圆环（SVG 描边，抄盘古 V3 的做法）───────────────────────────── */
function Ring({ pct, size = 78, stroke = 7, color, children }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const off = c * (1 - Math.max(0, Math.min(1, pct)))
  return h('div', { style: s({ position: 'relative', width: size, height: size, flex: '0 0 auto' }) },
    h('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`,
                style: s({ transform: 'rotate(-90deg)' }), 'aria-hidden': 'true' },
      h('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: T.track, strokeWidth: stroke }),
      h('circle', {
        cx: size / 2, cy: size / 2, r, fill: 'none', stroke: color, strokeWidth: stroke,
        strokeLinecap: 'round', strokeDasharray: c, strokeDashoffset: off,
        style: s({ transition: 'stroke-dashoffset .9s ease' }),
      })),
    h('div', {
      style: s({
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
      }),
    }, children))
}

/** 大数字 + 小标签 */
const Metric = (value, label, color) => h('div', { style: s({ minWidth: 0 }) },
  h('div', {
    style: s({
      fontSize: 22, fontWeight: 700, letterSpacing: '-.03em', lineHeight: '26px',
      color: color || T.ink, fontVariantNumeric: 'tabular-nums',
    }),
  }, value),
  h('div', { style: s({ fontSize: 10.5, color: T.faint, marginTop: 1, whiteSpace: 'nowrap' }) }, label))

/* ── 进度轨道：按章状态分段的整条 ─────────────────────────────────── */
function Rail({ written, published, cap }) {
  const n = Math.max(cap, 1)
  const seg = (from, to, color, radius) => {
    const w = ((to - from) / n) * 100
    if (w <= 0) return null
    return h('div', {
      key: from, title: `${from + 1}–${to}`,
      style: s({ width: `${w}%`, background: color, borderRadius: radius }),
    })
  }
  return h('div', {
    style: s({
      display: 'flex', gap: 2, height: 9, background: T.track,
      borderRadius: 5, overflow: 'hidden',
    }),
  },
    seg(0, published, T.ok, '4px 0 0 4px'),
    seg(published, written, T.biz, null),
    seg(written, cap, 'transparent', null))
}

/** 图例 */
const Legend = (items) => h('div', {
  style: s({ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8 }),
}, items.map(([color, text]) => h('span', {
  key: text, style: s({ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: T.dim }),
}, h('i', { style: s({ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }) }), text)))

/* ── 字数分布柱图 ─────────────────────────────────────────────────── */
function Bars({ chapters, lo, hi }) {
  if (!chapters.length) return h('div', { style: s({ fontSize: 11, color: T.faint }) }, '（尚无章节）')
  const peak = Math.max(hi, ...chapters.map(c => c.chars))
  const pctOf = (n) => `${(n / peak) * 100}%`
  return h('div', { style: s({ position: 'relative', height: 58 }) },
    /* 参考带：§6.2 的 2200–2800 —— 柱子在带内 = 合规，越出 = 越界。
       没有这条带，光看柱子高度读者不知道"多高算合适"。 */
    h('div', {
      title: `合规区间 ${lo}–${hi} 字`,
      style: s({
        position: 'absolute', left: 0, right: 0,
        bottom: pctOf(lo), height: `${((hi - lo) / peak) * 100}%`,
        background: T.track, borderRadius: 3,
      }),
    }),
    h('div', {
      style: s({ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 3, height: '100%' }),
    },
      chapters.map(c => {
        const over = c.chars > hi || c.chars < lo
        return h('div', {
          key: c.index,
          title: `第${c.index}章 ${c.chars} 字${over ? '（越界）' : ''}`,
          style: s({
            flex: '1 1 0', minWidth: 0, height: pctOf(c.chars),
            background: over ? T.warn : T.biz, opacity: over ? 1 : .85,
            borderRadius: '2px 2px 0 0', transition: 'height .5s ease',
          }),
        })
      })))
}

/* ── 单章一行：序号 · 名 · 内嵌条 · 字数 · 徽标 ───────────────────── */
function ChapterRow({ c, published, reviewed }) {
  const isPub = published.includes(c.index)
  const isRev = reviewed.includes(c.index)
  const lo = 2200, hi = 2800
  const pct = Math.max(8, Math.min(100, ((c.chars - lo * .82) / (hi - lo * .82)) * 100))
  const over = c.chars > hi || c.chars < lo
  return h('div', {
    style: s({ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 }),
  },
    h('span', { style: s({ color: T.faint, fontVariantNumeric: 'tabular-nums', width: 18, flex: '0 0 auto' }) },
      String(c.index).padStart(2, '0')),
    h('span', {
      style: s({
        flex: '0 1 auto', minWidth: 0, maxWidth: '38%', color: T.ink,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }),
    }, c.title),
    h('span', { style: s({ flex: '1 1 20px', minWidth: 16, height: 4, background: T.track, borderRadius: 2, overflow: 'hidden' }) },
      h('i', { style: s({ display: 'block', width: `${pct}%`, height: '100%', background: over ? T.warn : T.line2, borderRadius: 2 }) })),
    h('span', {
      style: s({ color: over ? T.warn : T.faint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }),
    }, num(c.chars)),
    h('span', {
      style: s({
        flex: '0 0 auto', fontSize: 10, lineHeight: '15px', padding: '0 6px', borderRadius: 8,
        background: isPub ? (isRev ? T.ok : T.warn) : 'transparent',
        color: isPub ? T.onBadge : T.faint,
        border: isPub ? 'none' : `1px solid ${T.line}`,
      }),
    }, isPub ? (isRev ? '已审' : '已发') : '待发'))
}

/* ── 按钮 ─────────────────────────────────────────────────────────── */
const Btn = (label, onClick, primary, disabled) => h('button', {
  onClick, disabled,
  style: s({
    padding: '7px 9px', fontSize: 12,
    cursor: disabled ? 'wait' : 'pointer', whiteSpace: 'nowrap',
    background: primary ? T.brand : 'transparent',
    color: primary ? T.onBrand : T.ink,
    border: `1px solid ${primary ? T.brand : T.line}`,
    borderRadius: 7, opacity: disabled ? .55 : 1,
    transition: 'opacity .15s ease',
  }),
}, label)

/* ── 主面板 ───────────────────────────────────────────────────────── */
function Panel() {
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

  const openReport = async () => {
    try {
      const r = await fetch(`${API}/report`); const j = await r.json()
      if (j.ok) setReport(j); else setMsg({ ok: false, text: j.error || '还没有审稿报告' })
    } catch (e) { setMsg({ ok: false, text: '读取报告失败：' + e.message }) }
  }

  /* 加载 / 失败态 */
  if (fail && !snap) {
    return h('div', { style: s({ padding: 16, fontSize: 12 }) },
      h('div', { style: s({ color: T.bad, fontWeight: 600, marginBottom: 6 }) }, '读不到流水线状态'),
      h('div', { style: s({ color: T.dim, fontSize: 11, lineHeight: 1.6 }) }, fail),
      h('button', {
        onClick: load,
        style: s({ marginTop: 10, padding: '5px 12px', fontSize: 12, cursor: 'pointer',
                   background: 'transparent', border: `1px solid ${T.line}`, borderRadius: 7, color: T.ink }),
      }, '重试'))
  }
  if (!snap) {
    return h('div', { style: s({ padding: 16, fontSize: 12, color: T.faint }) }, '读取流水线状态…')
  }

  const p = snap.progress || {}
  const cap = p.volumeCap || 60
  const written = p.written || snap.chapters.length
  const publishedN = snap.published.length
  const bufferN = snap.buffer.length
  const reviewedN = snap.reviewed.length
  const hb = snap.heartbeat
  const hbOk = hb && hb.overall === 'OK'
  const hbColor = !hb ? T.faint : hbOk ? T.ok : hb.overall === 'WARN' ? T.warn : T.bad
  const badChecks = hb ? Object.entries(hb.results || {}).filter(([, v]) => !v.ok) : []
  const recent = snap.chapters.slice(-8).reverse()
  const pending = snap.pendingDecisions || 0
  const overCap = snap.chapters.filter(c => c.chars > 2800 || c.chars < 2200)
  const pct = Math.min(1, written / cap)

  const needAction = (pending > 0 || badChecks.length > 0)
    ? h(Card, { style: s({ borderColor: T.warn, background: 'transparent' }) },
        SectionTitle('需要处理', null),
        pending > 0
          ? h('div', { style: s({ fontSize: 11.5, color: T.warn, lineHeight: 1.6 }) },
              `${pending} 条待裁决（自动裁决器处理中）`)
          : null,
        badChecks.map(([k, v]) => h('div', {
          key: k, style: s({ fontSize: 11, color: T.bad, marginTop: 3, lineHeight: 1.5 }),
        }, `${k}：${String(v.msg || v).slice(0, 64)}`)),
        overCap.length
          ? h('div', { style: s({ fontSize: 11, color: T.warn, marginTop: 3 }) },
              `字数越界 ${overCap.length} 章`)
          : null)
    : null

  return h('div', {
    style: s({
      display: 'flex', flexDirection: 'column', gap: GAP,
      padding: '14px 13px 18px', fontSize: 12, color: T.ink,
      background: T.panel,
      height: '100%', overflowY: 'auto', boxSizing: 'border-box',
    }),
  },

    /* ① 头部：眉标 + 大标题 + 一句话 */
    h('div', null,
      Eyebrow('xiaoshuo / pipeline',
        h('span', { style: s({ display: 'inline-flex', alignItems: 'center', gap: 5, textTransform: 'none', letterSpacing: 0 }) },
          h('i', { style: s({ width: 6, height: 6, borderRadius: 3, background: hbColor, display: 'inline-block' }) }),
          h('span', { style: s({ color: hbColor, fontWeight: 600 }) }, hb ? (hbOk ? '心跳正常' : hb.overall) : '无心跳'))),
      h('div', { style: s({ fontSize: 21, fontWeight: 700, letterSpacing: '-.02em', margin: '6px 0 2px' }) }, snap.book),
      h('div', { style: s({ fontSize: 11.5, color: T.dim }) },
        `卷一 · 已写 ${written} / ${cap} 章 · 已发 ${publishedN} 章`)),

    /* ② 英雄区：圆环 + 三个指标 */
    h(Card, null,
      h('div', { style: s({ display: 'flex', alignItems: 'center', gap: 14 }) },
        h(Ring, { pct, color: T.biz },
          h('div', { style: s({ fontSize: 19, fontWeight: 700, letterSpacing: '-.03em', lineHeight: '21px' }) }, `${Math.round(pct * 100)}%`),
          h('div', { style: s({ fontSize: 9.5, color: T.faint, marginTop: 1 }) }, '卷一')),
        h('div', { style: s({ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, flex: 1, minWidth: 0 }) },
          Metric(publishedN, '已发布', T.ink),
          Metric(bufferN, '待发布', bufferN ? T.ink : T.faint),
          Metric(reviewedN, '已审阅', T.ink)))),

    /* ③ 进度轨道 */
    h(Card, null,
      SectionTitle('卷一进度', `${written} / ${cap}`),
      h(Rail, { written, published: publishedN, cap }),
      Legend([
        [T.ok, `已发 ${publishedN}`],
        [T.biz, `待发 ${bufferN}`],
        [T.track, `未写 ${Math.max(0, cap - written)}`],
      ])),

    /* ④ 需要处理（只在真有问题时出现）
       ⚠️ 先算成变量再放进参数列表。写成「三元表达式嵌在 h() 的参数位」时，
       多层嵌套很容易多/少一个右括号，而报错位置会落到几十行之外。 */
    needAction,

    /* ⑤ 字数分布 */
    h(Card, null,
      SectionTitle('字数分布', overCap.length ? `${overCap.length} 章越界` : '全部在 2200–2800'),
      h(Bars, { chapters: snap.chapters, lo: 2200, hi: 2800 })),

    /* ⑥ 章节 */
    h(Card, null,
      SectionTitle('章节', `最近 ${recent.length} / 共 ${snap.chapters.length}`),
      recent.length
        ? recent.map(c => h(ChapterRow, { key: c.index, c, published: snap.published, reviewed: snap.reviewed }))
        : h('div', { style: s({ fontSize: 11, color: T.faint }) }, '（尚无）')),

    /* ⑦ 定时 */
    h(Card, null,
      SectionTitle('定时任务', `${sched.length} 条`),
      sched.length === 0
        ? h('div', { style: s({ fontSize: 11.5, color: T.bad }) }, '未读到 crontab')
        : sched.map((j, i) => h('div', {
            key: i,
            style: s({ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '2px 0' }),
          },
          h('span', { style: s({ color: T.dim, fontSize: 11.5 }) }, j.label),
          h('code', {
            style: s({ color: T.faint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
                       fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }),
          }, j.expr)))),

    /* ⑧ 操作 */
    h(Card, null,
      SectionTitle('操作', busy ? '执行中…' : null),
      /* ⚠️ 用 grid 而不是 flex+wrap：flex 的换行取决于各项内容宽度，
         实测会出现「写一章独占一行、审稿孤零零」这种参差。grid 每行必 2 个。 */
      h('div', { style: s({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }) },
        Btn('写一章', () => fire('write', '写作'), true, busy === 'write'),
        Btn('审稿', () => fire('review', '审稿'), false, busy === 'review'),
        Btn('发布', () => fire('publish', '发布'), false, busy === 'publish'),
        Btn('巡检', () => fire('heartbeat', '巡检'), false, busy === 'heartbeat'),
        h('button', {
          onClick: openReport,
          style: s({ gridColumn: '1 / -1', padding: '7px 9px', fontSize: 12, cursor: 'pointer',
                     background: 'transparent', border: `1px solid ${T.line}`, borderRadius: 7, color: T.ink }),
        }, '查看审稿报告')),
      msg ? h('div', {
        style: s({ marginTop: 8, fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap',
                   color: msg.ok ? T.ok : T.bad }),
      }, msg.text) : null),

    /* ⑨ 报告 */
    report ? h(Card, null,
      SectionTitle(report.file || '审稿报告', null),
      h('pre', {
        style: s({
          maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0,
          fontSize: 10.5, lineHeight: 1.65, color: T.ink,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }),
      }, report.text || ''),
      h('button', {
        onClick: () => setReport(null),
        style: s({ marginTop: 8, padding: '5px 12px', fontSize: 11, cursor: 'pointer',
                   background: 'transparent', border: `1px solid ${T.line}`, borderRadius: 7, color: T.ink }),
      }, '关闭')) : null,

    h('div', { style: s({ fontSize: 10, color: T.faint, lineHeight: 1.6 }) },
      '只读状态，不改内容。正文与设定以工作区纯文本为准，AGENT.md 是唯一权威。'),
  )
}

/* ── tab 标题 ─────────────────────────────────────────────────────── */
function TabTitle() {
  return h('div', { style: s({ fontSize: 12, padding: '0 4px' }) }, '连载')
}

/* ── 挂载 ─────────────────────────────────────────────────────────── */
async function apply(ctx) {
  try {
    const TAB = 'dsh-xiaoshuo'

    // ① tab 类型 —— 响应式注入，服务晚到会自动重跑
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
          description: () => '流水线进度、字数分布与定时任务',
        }],
      })

      // ② 内容插槽（keyed：用 key 绑到上面那个 tab id）
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
        // slots.inject 在 ctx.inject 的回调里执行，异常到不了外层 try —— 单独兜住。
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
