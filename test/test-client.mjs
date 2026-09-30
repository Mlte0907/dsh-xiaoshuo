/**
 * 客户端模块加载测试 —— 不启动 DSH、不占端口。
 *
 * 为什么需要它（2026-09-30 的教训）：
 *   面板**从来没显示过**，而当时 27 项测试全绿 —— 因为没有任何一条测"客户端模块能不能加载、
 *   能不能挂上"。根因是 `const tabs = ctx.sidebarRightTabs` 在模块顶层解引用，
 *   而 better-sidebar 的服务是懒加载的（它源码注释原话：probed at call time），
 *   于是永远拿到 undefined，且**不报任何错**。
 *
 * 本测试把这几件事钉住：
 *   1. 模块能被宿主的 factory(exports, require) 形式加载
 *   2. apply() 在拿不到 sidebarRight 时安静退出、不抛错
 *   3. apply() 在拿得到时会调 register，且 id 正确
 *   4. 不再使用已失效的插槽名 sidebar.right.pane.tab
 *   5. React 从全局取，而不是 require('react')（插件目录没有 node_modules）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// 本文件是 ESM，里面没有 require；而被测的客户端模块是 CJS 包装、需要 require 参数。
const require_ = createRequire(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'lib', 'client.js')
const src = fs.readFileSync(SRC, 'utf8')

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); console.log(`  [PASS] ${name}`); pass++ }
  catch (e) { console.log(`  [FAIL] ${name}\n         ${e.message}`); fail++ }
}

/** 用极简 React stub 加载模块（不依赖真的 react 包） */
function load() {
  const el = (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat() })
  const React = {
    createElement: el,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useCallback: (f) => f,
  }
  const exportsObj = {}
  const prev = globalThis.React
  globalThis.React = React
  try {
    // 宿主的加载方式：factory(exports, require, module)。
    // ⚠️ 必须把 require 显式传进 new Function 的参数列表 ——
    // 直接在函数体里用 require 会报 "require is not defined"（它不在那个作用域里）。
    const factory = new Function('exports', 'require', 'module', src)
    factory(exportsObj, require_, { exports: exportsObj })
    return { mod: exportsObj, React }
  } finally { globalThis.React = prev }
}

console.log('\n== dsh-xiaoshuo 客户端模块测试 ==\n')

console.log('1. 模块结构')
t('UMD 包装：factory(exports, require) 形式', () => {
  assert.match(src, /^\(function \(exports, require\)/m, '缺 UMD 包装')
})
t('导出 apply 与 inject', () => {
  const { mod } = load()
  assert.equal(typeof mod.apply, 'function', 'apply 不是函数')
  assert.equal(typeof mod.inject, 'function', 'inject 不是函数')
})
t('能实际加载且不抛错', () => {
  const { mod } = load()
  assert.ok(mod, '加载返回空')
})

console.log('\n2. 挂载路径（今天的真 bug 就在这）')
t('apply() 在调用时才 ctx.get("sidebarRight")', () => {
  // 服务是懒加载的：顶层解引用会永远拿到 undefined
  assert.ok(!/^const tabs = ctx/m.test(src), '仍在模块顶层解引用 ctx')
  assert.match(src, /ctx\.get\(['"]sidebarRight['"]\)/, '没有在 apply 里 ctx.get')
})
t('不再使用已失效的插槽名 sidebar.right.pane.tab', () => {
  const inCode = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l) && l.includes('sidebar.right.pane.tab'))
  assert.equal(inCode.length, 0, `代码里还有 ${inCode.length} 处`)
})
t('React 从全局取，不用 require("react")', () => {
  assert.ok(/globalThis\.React/.test(src), '没有从全局取 React')
  const req = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l) && /require\(\s*['"]react['"]\s*\)/.test(l))
  assert.equal(req.length, 0, `仍有 require('react')：${req[0]}`)
})

console.log('\n3. 运行时行为')
t('拿不到 sidebarRight 时安静退出、不抛错', () => {
  const { mod } = load()
  let registered = false
  const ctx = { get: () => null }
  assert.doesNotThrow(() => mod.apply(ctx), 'apply 抛错了')
  assert.equal(registered, false)
})
t('ctx.get 抛异常时也不炸', () => {
  const { mod } = load()
  const ctx = { get: () => { throw new Error('no service') } }
  assert.doesNotThrow(() => mod.apply(ctx), 'apply 抛错了')
})
t('拿得到服务时会调 register，且 id 正确', () => {
  const { mod } = load()
  let reg = null
  const ctx = {
    get: (k) => (k === 'sidebarRight'
      ? { tabs: { register: (d) => { reg = d } } }
      : null),
  }
  mod.apply(ctx)
  assert.ok(reg, '没有调 register')
  assert.equal(reg.id, 'dsh-xiaoshuo', `id 不对：${reg.id}`)
  assert.equal(typeof reg.title, 'function', 'title 应是函数')
  assert.equal(typeof reg.render, 'function', 'render 应是函数')
})
t('服务存在但没有 register() 时安静退出', () => {
  const { mod } = load()
  const ctx = { get: () => ({}) }        // 没有 tabs
  assert.doesNotThrow(() => mod.apply(ctx), 'apply 抛错了')
})

console.log('\n4. 面板要用到的数据字段')
{
  const m = await import('../lib/flow.js')
  const s = m.snapshot()
  t('snapshot 字段齐全（面板全靠这些）', () => {
    for (const k of ['book', 'chapters', 'published', 'reviewed', 'buffer', 'progress', 'heartbeat', 'pendingDecisions'])
      assert.ok(k in s, `缺字段 ${k}`)
  })
  t('progress 含面板用到的三个数', () => {
    for (const k of ['written', 'latest', 'lastPublished', 'volumeCap'])
      assert.ok(k in s.progress, `progress 缺 ${k}`)
  })
}

console.log(`\n== 结果：${pass} 通过 / ${fail} 失败 ==\n`)
process.exit(fail ? 1 : 0)
