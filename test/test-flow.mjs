/**
 * 本地测试：不启动 DSH、不占端口。
 * 承 dsh-novel 的第 3 条经验——改完先跑本地。
 *   node test/test-flow.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { snapshot, statusText, brief, listChapters, extractSections, schedule } from '../lib/flow.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log(`  [PASS] ${name}`); pass++ }
  catch (e) { console.log(`  [FAIL] ${name}\n         ${e.message}`); fail++ }
}

const ROOT = process.env.DSH_XIAOSHUO_ROOT || '/home/xiaoxin/xiaoshuo'

console.log(`\n== dsh-xiaoshuo 流程自测（根目录 ${ROOT}）==\n`)

// ── 1. 章节解析 ──
console.log('1. 章节解析')
const chs = listChapters(ROOT)
t('至少能列出一章', () => assert.ok(chs.length > 0, `列出 ${chs.length} 章`))
t('章号升序', () => {
  for (let i = 1; i < chs.length; i++) assert.ok(chs[i].index > chs[i-1].index, '顺序错')
})
t('每章都有标题与字数', () => {
  for (const c of chs) {
    assert.ok(c.title && c.title.length > 0, `第${c.index}章缺标题`)
    assert.ok(c.chars > 500, `第${c.index}章只有 ${c.chars} 字`)
  }
})
t('标题字数都在平台下限之上（>=5）', () => {
  for (const c of chs) assert.ok([...c.title].length >= 5, `《${c.title}》不足 5 字`)
})

// ── 2. 快照 ──
console.log('\n2. 快照')
const s = snapshot(ROOT)
t('buffer = 已写未发，且不与 published 交集', () => {
  for (const i of s.buffer) assert.ok(!s.published.includes(i), `第${i}章同时在两边`)
})
t('已发章号都真实存在（不指向没写的章）', () => {
  const have = new Set(chs.map(c => c.index))
  for (const i of s.published) assert.ok(have.has(i), `已发第${i}章但文件不存在`)
})
t('latest ≥ lastPublished', () => {
  if (s.progress.lastPublished !== null) {
    assert.ok(s.progress.latest >= s.progress.lastPublished,
      `latest(${s.progress.latest}) < lastPublished(${s.progress.lastPublished})`)
  }
})
t('volumeCap 是 60（§4.3 重排后）', () => assert.equal(s.progress.volumeCap, 60))
t('快照可 JSON 序列化（要发给面板）', () => JSON.parse(JSON.stringify(s)))

// ── 3. 状态文本 ──
console.log('\n3. statusText')
const st = statusText(s)
t('含书名', () => assert.ok(st.includes('夜行账房')))
t('含已发/待发', () => assert.ok(st.includes('已发布') && st.includes('已写未发')))

// ── 4. 节点表抽取 ──
console.log('\n4. 卷一节点表抽取')
t('从 AGENT.md 抽到 6 行节点', () => assert.ok(s.nodeTable.length >= 6, `只抽到 ${s.nodeTable.length} 行`))
t('节点表含 60 章上限那行', () => assert.ok(s.nodeTable.some(r => r.includes('051'))))

// ── 5. brief 上下文 ──
console.log('\n5. brief 上下文')
const br = brief(ROOT, 2)
t('brief 不为空且够长', () => assert.ok(br.length > 1500, `只有 ${br.length} 字`))
t('brief 含番茄节拍', () => assert.ok(br.includes('番茄节拍')))
t('brief 含时间线基准', () => assert.ok(br.includes('时间线') || br.includes('2.1b')))
t('brief 含最近 2 章正文', () => {
  const tail = s.chapters.slice(-2)
  for (const c of tail) assert.ok(br.includes(c.title), `缺第${c.index}章《${c.title}》`)
})
t('brief 不含 whole AGENT.md（体积受控）', () => {
  const ag = fs.readFileSync(path.join(ROOT, 'AGENT.md'), 'utf8')
  assert.ok(br.length < ag.length, `brief ${br.length} vs AGENT.md ${ag.length}`)
})

// ── 6. 分节抽取 ──
console.log('\n6. extractSections')
const md = fs.readFileSync(path.join(ROOT, 'AGENT.md'), 'utf8')
const secs = extractSections(md, ['1.4.0', '6.1', '2.1b'])
t('能抽到 §1.4.0 番茄节拍', () => assert.ok(secs['1.4.0'] && secs['1.4.0'].includes('转折')))
t('能抽到 §6.1 五条铁律', () => assert.ok(secs['6.1'] && secs['6.1'].includes('降智')))
t('能抽到 §2.1b 时间基准表', () => assert.ok(secs['2.1b'] && secs['2.1b'].includes('周长庚')))

// ── 7. 定时任务 ──
console.log('\n7. crontab 读取')
const jobs = schedule()
t('读到 3 条定时任务', () => assert.equal(jobs.length, 3, `读到 ${jobs.length} 条：${jobs.map(j=>j.label)}`))
t('三条分别标为 写作/发布/心跳', () => {
  const labels = jobs.map(j => j.label).sort().join('')
  assert.ok(labels.includes('写作') && labels.includes('发布') && labels.includes('心跳'), `实际=${labels}`)
})

// ── 8. 缺目录时不应崩 ──
console.log('\n8. 容错（路径不存在）')
t('空目录下 snapshot 不抛', () => {
  const e = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-'))
  const s2 = snapshot(e)
  assert.equal(s2.chapters.length, 0)
  assert.equal(s2.buffer.length, 0)
  fs.rmSync(e, { recursive: true, force: true })
})
t('空目录下 statusText 仍可生成', () => {
  const e = fs.mkdtempSync(path.join(os.tmpdir(), 'xs-'))
  const txt = statusText(snapshot(e))
  assert.ok(txt.includes('夜行账房'))
  fs.rmSync(e, { recursive: true, force: true })
})

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail ? 1 : 0)
