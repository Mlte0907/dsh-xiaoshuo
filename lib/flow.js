/**
 * 流水线状态读取（纯逻辑，无副作用，可单测）
 *
 * 定位：dsh-xiaoshuo **不重写** 写作/发布引擎（那部分已经在 tools/*.py 里跑通了），
 * 本文件只做一件事：把散落在磁盘上的状态读成一个结构化快照，
 * 供 agent 工具与侧边栏面板共用。
 *
 * 状态来源（都是既有产物，不新增数据源）：
 *   manuscript/.published.json  已发布章号
 *   manuscript/第NNN章-*.txt    已写章节
 *   data/heartbeat.json         最近一次巡检结果
 *   data/reviewed.json          已审章号
 *   data/review_report*.md      审稿报告
 *   AGENT.md                    设定圣经（唯一权威）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const DEFAULT_ROOT = process.env.DSH_XIAOSHUO_ROOT || '/home/xiaoxin/xiaoshuo'

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}
const readText = p => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }

/** 从 AGENT.md 抽出某几节的一级正文（用于 novel_flow_brief，控制上下文体积） */
export function extractSections(md, prefixes) {
  const out = {}
  const lines = md.split('\n')
  let cur = null
  let buf = []
  const flush = () => {
    if (cur) { out[cur.key] = buf.join('\n').trim(); cur = null; buf = [] }
  }
  for (const line of lines) {
    const m = /^#{2,4}\s+(.+)$/.exec(line)
    if (m) {
      flush()
      const title = m[1].trim()
      const hit = prefixes.find(p => title.startsWith(p))
      if (hit) cur = { key: hit, title }
      continue
    }
    if (cur) buf.push(line)
  }
  flush()
  return out
}

/** 已写章节 */
export function listChapters(root = DEFAULT_ROOT) {
  const dir = path.join(root, 'manuscript')
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const f of names) {
    const m = /^第(\d+)章-(.+)\.txt$/.exec(f)
    if (!m) continue
    const raw = readText(path.join(dir, f))
    const nl = raw.indexOf('\n')
    const body = raw.slice(nl + 1).replace(/^\r?\n+/, '').trim()
    out.push({
      index: Number(m[1]),
      title: m[2],
      file: f,
      chars: body.replace(/\s/g, '').length,
      firstLine: raw.slice(0, nl).trim(),
    })
  }
  return out.sort((a, b) => a.index - b.index)
}

export function readChapterBody(root, index) {
  const c = listChapters(root).find(x => x.index === Number(index))
  if (!c) return null
  const raw = readText(path.join(root, 'manuscript', c.file))
  return { ...c, body: raw.slice(raw.indexOf('\n') + 1).replace(/^\r?\n+/, '').trim() }
}

/** 一次读全部状态 */
export function snapshot(root = DEFAULT_ROOT) {
  const chapters = listChapters(root)
  const published = readJson(path.join(root, 'manuscript', '.published.json'), { published: [] }).published || []
  const reviewed = readJson(path.join(root, 'data', 'reviewed.json'), { reviewed: [] }).reviewed || []
  const hb = readJson(path.join(root, 'data', 'heartbeat.json'), null)
  const buffer = chapters.filter(c => !published.includes(c.index)).map(c => c.index)
  const lastPub = published.length
    ? Math.max(...published)
    : null
  return {
    root,
    book: '夜行账房',
    chapters,
    published,
    reviewed,
    buffer,
    /** 已发到第几章 / 一共写了几章 / 卷一上限（AGENT.md §4.3 重排后为 60） */
    progress: {
      lastPublished: lastPub,
      written: chapters.length,
      latest: chapters.length ? chapters[chapters.length - 1].index : 0,
      volumeCap: 60,
    },
    /** 卷一节点表（从 AGENT.md 抽的，写给 agent 对齐节奏用） */
    nodeTable: (() => {
      const md = readText(path.join(root, 'AGENT.md'))
      const lines = md.split('\n')
      const rows = []
      let inNode = false
      for (const l of lines) {
        if (/^###\s*4\.3/.test(l)) { inNode = true; continue }
        if (inNode && /^###\s*4\.4/.test(l)) break
        if (inNode && /^\|\s*\*?\*?\d{3}/.test(l)) {
          const cells = l.split('|').map(s => s.trim()).filter(Boolean)
          if (cells.length >= 3) rows.push(cells.slice(0, 3).join(' | '))
        }
      }
      return rows
    })(),
    heartbeat: hb && {
      overall: hb.overall,
      ts: hb.ts,
      results: hb.results,
      actions: hb.actions || [],
    },
    /**
     * 真正需要人拍板的条数（面板「需要处理」用）。
     *
     * ⚠️ 2026-10-01 修：原来数的是 pending_decisions.md 里的 `^## ` 标题 ——
     * 那 5 个是 §1~§5 的**章节标题**，不是待决条目；而且那个文件是 2026-09-28 的
     * 历史快照，13 条早已全部裁完（decisions.jsonl 里有留痕）。
     * 结果面板**永远显示「5 条待裁决」**，是纯粹的假警报。
     *
     * 正确判据：decisions.jsonl 里 `defer: true` 且**之后没被再裁**的条目。
     * defer 的语义就是「信息不足，交回作者」，这才是真正需要人的。
     */
    pendingDecisions: (() => {
      try {
        const f = path.join(root, 'data', 'decisions.jsonl')
        if (!fs.existsSync(f)) return 0
        const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        const open = new Set(rows.filter(r => r.defer === true).map(r => r.id))
        for (const r of rows) if (r.defer !== true) open.delete(r.id)   // 后来裁掉了
        return open.size
      } catch { return 0 }
    })(),
    hasReviewReport: fs.existsSync(path.join(root, 'data', 'review_report.md'))
      || fs.existsSync(path.join(root, 'data', 'review_report_round2.md')),
  }
}

/** crontab 三条任务 + 下次触发（给面板用） */
export function schedule() {
  let out = []
  try { out = execFileSync('crontab', ['-l'], { encoding: 'utf8' }).split('\n').filter(Boolean) } catch { return [] }
  const jobs = []
  for (const raw of out) {
    // ⚠️ 必须先剔除注释行：2026-09-29 停用 23:30 那条时我把它注释掉了（#30 23 * * * ...），
    // 而正则只匹配 "pipeline-cron.sh" 这个子串，于是**注释行也被算成一条任务**——
    // 面板显示 5 个任务，实际只有 4 个。判据要独立于被解析的对象。
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (!/xiaoshuo\/(tools|.*cron)/.test(line) && !/(wq|fq|hb)-cron/.test(line)) continue
    const parts = line.trim().split(/\s+/)
    const expr = parts.slice(0, 5).join(' ')   // 分 时 日 月 周
    const cmd = parts.slice(5).join(' ')
    // 标签从文件名反推，不穷举：今天加 pipeline-cron.sh 时就是穷举版把它标成 '?' 的。
    // 新增 cron 不用回来改这里。
    const m2 = /([a-z-]+)-cron\.sh/.exec(line)
    const NAME = {
      wq: '写作', fq: '发布', hb: '心跳', pipeline: '全链路',
    }
    const label = m2 ? (NAME[m2[1]] || m2[1]) : '?'
    jobs.push({ expr, label, cmd })
  }
  return jobs
}

/** 格式化给模型看的状态文本 */
export function statusText(s = snapshot()) {
  const L = []
  L.push(`《${s.book}》流水线状态`)
  L.push(`  已发布：${s.published.length ? s.published.join(',') : '（无）'}  最新第 ${s.progress.lastPublished ?? '-'} 章`)
  L.push(`  已写未发：${s.buffer.length ? s.buffer.join(',') : '（无）'}`)
  L.push(`  已审：${s.reviewed.length ? s.reviewed.join(',') : '（无）'}   已写共 ${s.progress.written} 章 / 卷一上限 ${s.progress.volumeCap}`)
  if (s.heartbeat) {
    L.push(`  心跳：${s.heartbeat.overall} @ ${s.heartbeat.ts}`)
    for (const [k, v] of Object.entries(s.heartbeat.results || {})) {
      L.push(`    ${v.ok ? '✓' : '✗'} ${k}：${String(v.msg).slice(0, 70)}`)
    }
    if (s.heartbeat.actions?.length) L.push(`    本轮自愈：${s.heartbeat.actions.join('、')}`)
  } else {
    L.push('  心跳：尚无记录')
  }
  const jobs = schedule()
  if (jobs.length) {
    L.push('  定时：')
    for (const j of jobs) L.push(`    ${j.label}  ${j.expr}`)
  }
  return L.join('\n')
}

/** 写下一章所需的上下文（对应 dsh-novel 的 novel_context，但对齐我们纯文本+AGENT.md 的形态） */
export function brief(root = DEFAULT_ROOT, recent = 2) {
  const s = snapshot(root)
  const md = readText(path.join(root, 'AGENT.md'))
  const secs = extractSections(md, ['1.4.0', '1.4.1', '1.4.1b', '2.1b', '2.4', '3.1', '3.2', '6.1', '6.2', '7.1', '9.5b', '9.14'])
  const tail = s.chapters.slice(-recent)
  const parts = []
  parts.push(`# 《${s.book}》续写上下文`)
  parts.push(`\n## 一、当前进度\n${statusText(s)}\n`)
  if (s.nodeTable.length) {
    parts.push(`\n## 二、第一卷节点表（下一章应落在哪一段）\n${s.nodeTable.join('\n')}\n`)
  }
  const last = s.chapters[s.chapters.length - 1]
  if (last && !s.published.includes(last.index)) {
    const nxt = s.progress.latest + 1
    const rows = (s.nodeTable.find(r => r.startsWith(`| **${String(nxt).padStart(3, '0')}`)) || '')
    parts.push(`\n## 三、下一章（第 ${nxt} 章）落在\n${rows || '（按 §4.3 节点表推进）'}\n`)
  }
  parts.push('\n## 四、写作硬约束（必读）')
  for (const k of ['6.1', '6.2']) if (secs[k]) parts.push(secs[k])
  parts.push('\n## 五、番茄节拍（最容易违反）')
  if (secs['1.4.0']) parts.push(secs['1.4.0'])
  if (secs['1.4.1']) parts.push(secs['1.4.1'])
  if (secs['1.4.1b']) parts.push(secs['1.4.1b'])
  parts.push('\n## 六、时间线基准（写任何"N 天前"都要回表核对）')
  if (secs['2.1b']) parts.push(secs['2.1b'])
  parts.push('\n## 七、最近正文（对齐语气，不要重写它们）')
  for (const c of tail) {
    const b = readChapterBody(root, c.index)
    parts.push(`\n### 第${c.index}章《${c.title}》\n${b ? b.body : '（读不到）'}`)
  }
  parts.push(`\n## 八、弃坑雷区\n${secs['7.1'] || '（见 AGENT.md §7.1）'}`)
  return parts.join('\n')
}
