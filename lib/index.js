/**
 * dsh-xiaoshuo —— 宿主侧：给 agent 的 10 个 novel_flow_* 工具 + 右侧栏面板用的 HTTP API
 *
 * 定位（与 dsh-novel 的区别）：
 *   dsh-novel 管的是**内容库**（大纲/人物卡/章节的结构化存储）。
 *   本插件管的是**连载流水线**（写→审→发的调度、状态、闸门），不重复造内容库：
 *   正文与设定仍以工作区里的纯文本为准（AGENT.md 是唯一权威）。
 *   引擎是 tools/*.py（已跑通），本插件是它的**控制面**：工具 + 面板。
 *
 * ⚠️ 四条从 dsh-novel 继承的硬经验（都踩过）：
 *   1) **不要 import 任何 @deepseek-ai/* 宿主包** —— link 安装时 Node 从物理路径
 *      往上找 → ERR_MODULE_NOT_FOUND。ctx.reflect.get('tools', false).register
 *      直接收普通对象。
 *   2) parameters / output.schema 必须是**原始 JSON Schema**，
 *      `required` 是数组而不是 spec 里的 required:true。
 *   3) 改完先跑本地测试（node test/），不要为了验证去启动 DSH 占端口。
 *   4) **服务只能通过 ctx.get / ctx.reflect.get / ctx.inject 拿** —— 裸读
 *      `ctx.tools` / `ctx.http` 会撞 Cordis 上下文代理的 get 陷阱，直接抛
 *      "cannot get property X without inject"，可选链挡不住（陷阱自己抛）。
 *      路由也没有 `.get()`：webserver 只认 { kind, path, handler(req,res) }，
 *      同一路径注册两条会抛 duplicate，所以 GET/POST 必须在 handler 里自己分。
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

/** 按 webserver 的约定回 JSON：handler 独占响应生命周期，no-store 让侧边栏每次拿到新状态 */
function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/** 读 JSON 请求体：空体当 {}，超过 4MB 直接拒 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体太大（>4MB）'))
        req.destroy?.()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export default function activate(ctx) {
  const root = () => process.env.DSH_XIAOSHUO_ROOT || DEFAULT_ROOT

  // ── 浏览器 API（给侧边栏面板用，同源 fetch） ──
  // webserver 只认 { kind, path, handler(req, res) }，没有 .get()/.post()；
  // 5 条路径互不相同，各自一条 exact 路由，方法在 handler 内部分支。
  const apiRoutes = [
    {
      kind: 'exact',
      path: `${API}/status`,
      handler(_req, res) {
        sendJson(res, 200, { ok: true, snapshot: snapshot(root()), schedule: schedule() })
      },
    },
    {
      kind: 'exact',
      path: `${API}/brief`,
      handler(_req, res) {
        sendJson(res, 200, { ok: true, text: brief(root(), 2) })
      },
    },
    {
      kind: 'exact',
      path: `${API}/chapter`,
      handler(req, res) {
        const index = new URL(req.url || '/', 'http://localhost').searchParams.get('index')
        const c = readChapterBody(root(), Number(index))
        sendJson(res, c ? 200 : 404, c
          ? { ok: true, chapter: c }
          : { ok: false, error: `没有第 ${index} 章` })
      },
    },
    {
      kind: 'exact',
      path: `${API}/report`,
      handler(_req, res) {
        const d = path.join(root(), 'data')
        const files = fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^review_report.*\.md$/.test(f)) : []
        files.sort()
        const last = files[files.length - 1]
        sendJson(res, last ? 200 : 404, last
          ? { ok: true, file: last, text: fs.readFileSync(path.join(d, last), 'utf8') }
          : { ok: false, error: '还没有审稿报告' })
      },
    },
    {
      kind: 'exact',
      path: `${API}/trigger`,
      async handler(req, res) {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          res.statusCode = 405
          res.setHeader('Allow', 'POST')
          res.end()
          return
        }
        try {
          const body = await readBody(req)
          const map = { write: 'write_daily.py', review: 'reviewer.py', publish: 'publish_daily.mjs', heartbeat: 'heartbeat.py' }
          if (body.action === 'publish') {
            const r = await runSync(root(), 'publish_daily.mjs', [])
            sendJson(res, 200, { ok: !r.err, action: 'publish', output: (r.stdout + r.stderr).slice(-4000) })
            return
          }
          const s = map[body.action]
          if (!s) {
            sendJson(res, 400, { ok: false, error: `未知动作 ${body.action}` })
            return
          }
          const pid = runDetached(root(), s)
          sendJson(res, 200, { ok: true, action: body.action, pid, note: '已后台启动，进度看 data/trigger.out' })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
      },
    },
  ]

  // 等 webServer 就绪再挂：activate 跑的时候它可能还没起来。
  // ctx.inject 会等到声明的服务可用，路由的 disposer 交给 ctx.effect，卸载时自动摘掉。
  ctx.inject(['webServer'], (httpCtx) => {
    const webServer = httpCtx.get('webServer')
    if (!webServer) {
      console.log('[dsh-xiaoshuo] webServer 服务不可用，浏览器 API 未注册')
      return
    }
    for (const route of apiRoutes) {
      httpCtx.effect(() => webServer.register(route), `dsh-xiaoshuo: ${route.path}`)
    }
    console.log(`[dsh-xiaoshuo] 已注册浏览器 API（${apiRoutes.length} 条）：${apiRoutes.map(r => r.path).join('、')}`)
  })

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
      name: 'novel_flow_arbitrate',
      description: '裁决待决事项：读 data/pending_decisions.md，对每条给出决策并写回 AGENT.md（带理由与时间戳），同时把裁决涉及的正文修正追加进 data/auto_fix_queue.json。这是「决策者」动作，只该由你（captain）调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: async () => {
        const r = await runSync(root(), 'arbiter.py', [], 30 * 60 * 1000)
        return { text: (r.stdout + r.stderr).slice(-6000) || '(无输出)' }
      },
    },
    {
      name: 'novel_flow_autofix',
      description: '跑自动修正执行器：读 data/auto_fix_queue.json 的修正类条目逐条改正文，每条改完必须自证（verify 命令由失败变通过），不通过即回滚，四道熔断任一不过就停手。这是「执行者」动作，无需人工。',
      parameters: { type: 'object', properties: { dryRun: { type: 'boolean', description: 'true=只演算不写盘' } }, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: async (a = {}) => {
        const r = await runSync(root(), 'auto_fix.py', a.dryRun ? ['--dry-run'] : [], 10 * 60 * 1000)
        return { text: (r.stdout + r.stderr).slice(-6000) || '(无输出)' }
      },
    },
    {
      name: 'novel_flow_sync',
      description: '把本地已修正的章节同步到番茄（仅限已发布章）。逐章走平台编辑器改稿流程，改前必须等原章节内容真的加载出来，否则拒绝写入。同步执行并回显每章结果。',
      parameters: { type: 'object', properties: { chapters: { type: 'array', items: { type: 'integer' }, description: '要同步的章号；省略则自动比对本地与平台字数，找出不一致的章' } }, additionalProperties: false },
      output: TEXT_OUTPUT,
      execute: async (a = {}) => {
        const args = a.chapters && a.chapters.length ? a.chapters.map(String) : ['--auto-detect']
        const r = await runSync(root(), 'fix_published.mjs', args, 40 * 60 * 1000)
        return { text: (r.stdout + r.stderr).slice(-8000) || '(无输出)' }
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
  // 等 tools 服务就绪再注册：activate 跑在它前面还是后面取决于 bundle 加载顺序，
  // 裸读会时有时无。ctx.inject 两种顺序都成立，disposer 交给 ctx.effect。
  // register 一次只收一个 ToolDefinition，传数组会按 name=undefined 抛掉。
  ctx.inject(['tools'], (toolCtx) => {
    const toolService = toolCtx.get('tools')
    if (!toolService) {
      console.log('[dsh-xiaoshuo] tools 服务不可用，跳过注册')
      return
    }
    for (const tool of tools) {
      toolCtx.effect(() => toolService.register(tool), `dsh-xiaoshuo: ${tool.name}`)
    }
    console.log(`[dsh-xiaoshuo] 已注册工具：${tools.map((t) => t.name).join(' / ')}`)
  })
}
