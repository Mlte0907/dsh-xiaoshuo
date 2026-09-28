/**
 * dsh-xiaoshuo —— 宿主侧：给 agent 的 7 个 novel_flow_* 工具 + 右侧栏面板用的 HTTP API
 *
 * 定位（与 dsh-novel 的区别）：
 *   dsh-novel 管的是**内容库**（大纲/人物卡/章节的结构化存储）。
 *   本插件管的是**连载流水线**（写→审→发的调度、状态、闸门），不重复造内容库：
 *   正文与设定仍以工作区里的纯文本为准（AGENT.md 是唯一权威）。
 *   引擎是 tools/*.py（已跑通），本插件是它的**控制面**：工具 + 面板。
 *
 * ⚠️ 三条从 dsh-novel 继承的硬经验（都踩过）：
 *   1) **不要 import 任何 @deepseek-ai/* 宿主包** —— link 安装时 Node 从物理路径
 *      往上找 → ERR_MODULE_NOT_FOUND。ctx.tools.register 直接收普通对象。
 *   2) parameters / output.schema 必须是**原始 JSON Schema**，
 *      `required` 是数组而不是 spec 里的 required:true。
 *   3) 改完先跑本地测试（node test/），不要为了验证去启动 DSH 占端口。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { DEFAULT_ROOT, snapshot, statusText, brief, listChapters, readChapterBody, schedule } from './flow.js'

const API = '/xiaoshuo/api'

/** 文本型工具的共用输出契约 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string', description: '返回给模型的文本' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_a, v) => [{ type: 'text', text: String(v?.text ?? '') }],
}

const str = (desc) => ({ type: 'object', properties: { text: { type: 'string', description: desc } }, required: ['text'], additionalProperties: false })

/** 后台跑一个 python 工具脚本，不阻塞 agent 回合 */
function runDetached(root, script, args = []) {
  const log = path.join(root, 'data', 'trigger.log')
  fs.mkdirSync(path.dirname(log), { recursive: true })
  const line = `[${new Date().toISOString()}] $ python3 tools/${script} ${args.join(' ')}\n`
  fs.appendFileSync(log, line)
  const out = fs.openSync(path.join(root, 'data', 'trigger.out'), 'a')
  const p = spawn('python3', [path.join(root, 'tools', script), ...args], {
    cwd: root, detached: true, stdio: ['ignore', out, out],
  })
  p.unref()
  fs.closeSync(out)
  return p.pid
}

/** 同步跑一个 python 工具脚本并取输出（带超时） */
function runSync(root, script, args = [], timeoutMs = 120000) {
  return new Promise(resolve => {
    execFile('python3', [path.join(root, 'tools', script), ...args],
      { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }))
  })
}

export default function activate(ctx) {
  const root = () => process.env.DSH_XIAOSHUO_ROOT || DEFAULT_ROOT

  // ── 浏览器 API（给侧边栏面板用，同源 fetch） ──
  const routes = {
    [`GET ${API}/status`]: () => ({ ok: true, snapshot: snapshot(root()), schedule: schedule() }),
    [`GET ${API}/brief`]: () => ({ ok: true, text: brief(root(), 2) }),
    [`GET ${API}/chapter`]: (q) => {
      const c = readChapterBody(root(), Number(q.get('index')))
      return c ? { ok: true, chapter: c } : { ok: false, error: `没有第 ${q.get('index')} 章` }
    },
    [`GET ${API}/report`]: () => {
      const d = path.join(root(), 'data')
      const files = fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^review_report.*\.md$/.test(f)) : []
      files.sort()
      const last = files[files.length - 1]
      return last
        ? { ok: true, file: last, text: fs.readFileSync(path.join(d, last), 'utf8') }
        : { ok: false, error: '还没有审稿报告' }
    },
    [`POST ${API}/trigger`]: async (body) => {
      const map = { write: 'write_daily.py', review: 'reviewer.py', publish: 'publish_daily.mjs', heartbeat: 'heartbeat.py' }
      if (body.action === 'publish') {
        const r = await runSync(root(), 'publish_daily.mjs', [])
        return { ok: !r.err, action: 'publish', output: (r.stdout + r.stderr).slice(-4000) }
      }
      const s = map[body.action]
      if (!s) return { ok: false, error: `未知动作 ${body.action}` }
      const pid = runDetached(root(), s)
      return { ok: true, action: body.action, pid, note: '已后台启动，进度看 data/trigger.out' }
    },
  }

  for (const [route, fn] of Object.entries(routes)) {
    ctx.http?.get?.(route, fn) ?? ctx.router?.get?.(route, fn)
  }

  // ── 给 agent 的工具 ──
  const tools = [
    {
      name: 'novel_flow_status',
      description: '《夜行账房》连载流水线全景：已发布/已写未发/已审、卷一进度、三条定时任务、最近一次心跳巡检结果。开始任何写作或发布动作前先看这个。',
      parameters: str('流水线状态摘要'),
      output: TEXT_OUTPUT,
      execute: async () => ({ text: statusText(snapshot(root())) }),
    },
    {
      name: 'novel_flow_brief',
      description: '取出「写下一章」所需的全部上下文：当前进度、卷一节点表、写作硬约束、番茄节拍、时间线基准、最近 2 章正文（对齐语气）、弃坑雷区。续写前先调这个，不要凭空写。',
      parameters: str('续写上下文'),
      output: TEXT_OUTPUT,
      execute: async () => ({ text: brief(root(), 2) }),
    },
    {
      name: 'novel_flow_arc',
      description: '《夜行账房》剧情档案：全部章节清单、已发布/待发、卷一节点表、审稿报告位置。只读，不动文件。',
      parameters: str('剧情档案'),
      output: TEXT_OUTPUT,
      execute: async () => {
        const s = snapshot(root())
        const L = [`《${s.book}》剧情档案`, `卷一上限：第 ${s.progress.volumeCap} 章`]
        L.push('\n已写章节：')
        for (const c of s.chapters) {
          L.push(`  第${String(c.index).padStart(3, '0')}章《${c.title}》 ${c.chars}字 ${s.published.includes(c.index) ? '[已发]' : '[待发]'}${s.reviewed.includes(c.index) ? '[已审]' : ''}`)
        }
        if (s.nodeTable.length) L.push('\n卷一节点表：', ...s.nodeTable.map(r => '  ' + r))
        L.push('\n审稿报告：', s.hasReviewReport ? 'data/review_report.md（第一轮）、review_report_round2.md（复验）' : '（无）')
        return { text: L.join('\n') }
      },
    },
    {
      name: 'novel_flow_write',
      description: '唤起写作：按 AGENT.md 的规则与番茄节拍写下一批章节，落到 manuscript/。后台运行。缓冲已满时会直接拒绝。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: async () => {
        const s = snapshot(root())
        if (s.progress.latest >= s.progress.volumeCap) {
          return { text: `已写到卷一末章（第 ${s.progress.volumeCap} 章），写作器会停手等卷二规划。` }
        }
        const pid = runDetached(root(), 'write_daily.py')
        return { text: `已后台启动写作器（pid ${pid}）。下一章将是第 ${s.progress.latest + 1} 章。进度见 data/writer.log 与 data/trigger.out。` }
      },
    },
    {
      name: 'novel_flow_review',
      description: '唤起独立审稿代理：只审不改，逐章比对 AGENT.md 出报告到 data/review_report.md。后台运行。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: async () => {
        const pid = runDetached(root(), 'reviewer.py')
        return { text: `已后台启动审稿代理（pid ${pid}）。报告写�� data/review_report.md。` }
      },
    },
    {
      name: 'novel_flow_publish',
      description: '把缓冲里的章节发到番茄。同步执行并回显结果。只有审核时段 7:00-24:00 内可用，且受平台每日提交字数上限约束。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: async () => {
        const r = await runSync(root(), 'publish_daily.mjs', [], 20 * 60 * 1000)
        return { text: (r.stdout + r.stderr).slice(-4000) || '(无输出)' }
      },
    },
    {
      name: 'novel_flow_heartbeat',
      description: '跑一次流水线巡检（9 项）+ 自愈，并回读结果。同步执行。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: async () => {
        const r = await runSync(root(), 'heartbeat.py', [], 5 * 60 * 1000)
        return { text: (r.stdout + r.stderr).slice(-4000) || '(无输出)' }
      },
    },
  ]
  ctx.tools?.register?.(tools)
}
