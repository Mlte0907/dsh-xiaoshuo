/**
 * dsh-xiaoshuo 客户端半 —— 右侧栏「连载」面板
 *
 * 交付格式：DSH 客户端模块（window.__ModuleLoader__）
 *   - 宿主把本文件挂在 /plugins/dsh-xiaoshuo/client.js
 *   - 浏览器内核加载它，factory(require) 的 require 由宿主提供
 *   - 所以**不需要 import 任何东西**，也没有打包/JSX 步骤，统一 React.createElement
 *   （以上三条承 dsh-novel 的做法）
 *
 * 注册方式：借 dsh-better-sidebar 的 ctx.betterSidebar.registerTab(descriptor)
 *
 * 面板只做两件事：
 *   1. 让**人**一眼看到流水线到哪了（进度/定时/心跳/待办）
 *   2. 四个按钮把写作/审稿/发布/巡检拉起来
 * 它不碰正文，改动一律走 tools/*.py —— 面板不是第二个数据源。
 */

const API = '/xiaoshuo/api'

const h = React.createElement

function Panel() {
  const [snap, setSnap] = React.useState(null)
  const [sched, setSched] = React.useState([])
  const [busy, setBusy] = React.useState('')
  const [log, setLog] = React.useState('')
  const [report, setReport] = React.useState(null)

  const load = React.useCallback(async () => {
    try {
      const r = await fetch(`${API}/status`)
      const j = await r.json()
      if (j.ok) { setSnap(j.snapshot); setSched(j.schedule || []) }
    } catch (e) { setLog('读状态失败：' + e.message) }
  }, [])

  React.useEffect(() => {
    load()
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
  }, [load])

  const fire = async (action) => {
    setBusy(action); setLog('')
    try {
      const r = await fetch(`${API}/trigger`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const j = await r.json()
      setLog(j.ok ? `已启动「${action}」。${j.note || j.output || ''}` : `失败：${j.error || '未知'}`)
      setTimeout(load, 3000)
    } catch (e) { setLog('调用失败：' + e.message) }
    setBusy('')
  }

  const showReport = async () => {
    const r = await fetch(`${API}/report`)
    const j = await r.json()
    setReport(j.ok ? j : null)
  }

  if (!snap) return h('div', { style: { padding: 12, color: '#888' } }, '读取流水线状态…')

  const p = snap.progress
  const done = p.lastPublished || 0
  const pct = Math.min(100, Math.round((p.written / p.volumeCap) * 100))
  const hb = snap.heartbeat
  const hbColor = !hb ? '#888' : hb.overall === 'OK' ? '#3fb950' : hb.overall === 'WARN' ? '#d29922' : '#f85149'
  const undone = snap.chapters.filter(c => !snap.reviewed.includes(c.index))

  const card = { border: '1px solid #30363d', borderRadius: 6, padding: '8px 10px', margin: '8px 0' }
  const bar = { height: 6, background: '#21262d', borderRadius: 3, overflow: 'hidden', margin: '6px 0' }
  const btn = (label, action, primary) => h('button', {
    onClick: () => fire(action), disabled: busy === action,
    style: {
      marginRight: 6, marginTop: 6, padding: '4px 10px', fontSize: 12, cursor: busy ? 'wait' : 'pointer',
      background: primary ? '#238636' : '#21262d', color: '#e6edf3',
      border: '1px solid #30363d', borderRadius: 5, opacity: busy && busy !== action ? 0.5 : 1,
    },
  }, busy === action ? '启动中…' : label)

  return h('div', { style: { padding: 12, fontSize: 12, lineHeight: 1.6 } },
    h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, `《${snap.book}》连载`),

    h('div', { style: { color: '#8b949e', fontSize: 11 } },
      `卷一 ${p.written}/${p.volumeCap} 章 · 已发 ${snap.published.length} · 待发 ${snap.buffer.length} · 已审 ${snap.reviewed.length}`),
    h('div', { style: bar },
      h('div', { style: { width: pct + '%', height: '100%', background: '#2ea043' } })),
    h('div', { style: { color: '#8b949e', fontSize: 11 } },
      snap.buffer.length ? `缓冲：第 ${snap.buffer.join(',')} 章` : '缓冲空（写作器会补）'),

    h('div', { style: { ...card } },
      h('div', { style: { fontWeight: 600 } }, '定时任务'),
      sched.length === 0 ? h('div', { style: { color: '#f85149' } }, '⚠ crontab 里没有本项目的任务')
        : sched.map((j, i) => h('div', { key: i },
          h('code', { style: { color: '#79c0ff' } }, j.expr), ` ${j.label}`))),

    h('div', { style: { ...card } },
      h('div', { style: { fontWeight: 600 } },
        h('span', { style: { color: hbColor, marginRight: 6 } }, '●'),
        `心跳 ${hb ? hb.overall : '无记录'}`),
      hb ? h('div', { style: { color: '#8b949e', fontSize: 11 } }, hb.ts) : null,
      hb && hb.actions && hb.actions.length
        ? h('div', { style: { color: '#d29922', fontSize: 11 } }, '自愈：' + hb.actions.join('、')) : null,
      hb && Object.entries(hb.results || {}).filter(([, v]) => !v.ok).map(([k, v], i) =>
        h('div', { key: i, style: { color: '#f85149', fontSize: 11 } }, `✗ ${k}：${String(v.msg).slice(0, 60)}`))),

    h('div', { style: { ...card } },
      h('div', { style: { fontWeight: 600 } }, '操作'),
      h('div', null,
        btn('写一章', 'write', true), btn('审稿', 'review'), btn('发布', 'publish')),
      h('div', null,
        btn('巡检+自愈', 'heartbeat'),
        undone.length
          ? h('button', { onClick: showReport, style: { marginTop: 6, padding: '4px 10px', fontSize: 12, background: '#21262d', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 5, cursor: 'pointer' } },
            `看审稿报告 (${undone.length} 章未审)`)
          : null),
      log ? h('div', { style: { marginTop: 8, color: '#79c0ff', fontSize: 11, whiteSpace: 'pre-wrap' } }, log) : null),

    h('div', { style: { ...card } },
      h('div', { style: { fontWeight: 600 } }, '章节'),
      snap.chapters.length === 0
        ? h('div', { style: { color: '#8b949e' } }, '（尚无）')
        : snap.chapters.slice(-6).map(c => h('div', { key: c.index, style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('span', { style: { color: '#8b949e' } }, `第${String(c.index).padStart(3, '0')}`),
          h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `《${c.title}》`),
          h('span', { style: { color: '#8b949e', fontSize: 11 } }, `${c.chars}字`),
          snap.published.includes(c.index) ? h('span', { style: { color: '#3fb950' } }, '发')
            : h('span', { style: { color: '#d29922' } }, '待'),
          snap.reviewed.includes(c.index) ? h('span', { style: { color: '#3fb950' } }, '审') : null,
        ))),

    report
      ? h('div', { style: { ...card } },
        h('div', { style: { fontWeight: 600, marginBottom: 4 } }, report.file),
        h('pre', { style: { maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#c9d1d9', fontSize: 11, margin: 0 } }, report.text || report.error),
        h('button', { onClick: () => setReport(null), style: { marginTop: 6, padding: '3px 8px', fontSize: 11, background: '#21262d', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 5, cursor: 'pointer' } }, '关闭'))
      : null,

    h('div', { style: { color: '#484f58', fontSize: 10, marginTop: 10 } },
      '正文与设定以工作区纯文本为准，AGENT.md 是唯一权威；本面板只读状态、不改内容。'),
  )
}

export function client(ctx) {
  const betterSidebar = ctx && ctx.betterSidebar
  if (!betterSidebar || typeof betterSidebar.registerTab !== 'function') return
  betterSidebar.registerTab({
    id: 'xiaoshuo',
    title: '连载',
    icon: '📖',
    render: () => h(Panel),
  })
}

export default client
