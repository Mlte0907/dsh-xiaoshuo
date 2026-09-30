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

/**
 * 按宿主的真实契约加载模块。
 *
 * ⚠️ 契约是 window.__ModuleLoader__.load({ id, factory: (require) => {...} })，
 * factory 只接 require 一个参数，**module / exports 由模块内部自己造**
 * （见 dsh-pangu 的写法）。第一版我按 UMD 包装测，测的是我自己造的结构，
 * 于是「测试全绿」而面板从来没显示过。
 */
const FAKE_REACT = {
  createElement: (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat() }),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
}

/** 宿主加载一次，返回它拿到的 module.exports */
function loadModule() {
  let captured = null
  const win = { __ModuleLoader__: { load: (o) => { captured = o } } }
  const prevWin = globalThis.window
  globalThis.window = win
  try {
    // 宿主把 bundle 文本当函数体执行，形参就是 load() 声明的那些
    const bundle = new Function('require', 'window', src)
    bundle(() => FAKE_REACT, win)     // require('react') 由宿主兑现
    assert.ok(captured, '模块没有调用 window.__ModuleLoader__.load()')
    assert.equal(captured.id, 'dsh-xiaoshuo', `id 不对：${captured.id}`)
    // ⚠️ factory **只接 require 一个参数**：module 是它内部自己造的
    // （const module = { exports: {} }），所以结果要靠它的 return 拿回来。
    // 我第一版传了三个参数、又从 mod.exports 取，于是永远拿到空对象。
    const exported = captured.factory(() => FAKE_REACT)
    assert.ok(exported, 'factory 没有返回 module.exports')
    return exported
  } finally { globalThis.window = prevWin }
}

console.log('\n== dsh-xiaoshuo 客户端模块测试 ==\n')

console.log('1. 模块结构')
t('契约入口 window.__ModuleLoader__.load({id, factory})', () => {
  assert.match(src, /window\.__ModuleLoader__\.load\(\{/, '缺 load() 入口')
  assert.match(src, /factory: \(require\)/, 'factory 签名应为 (require)')
})
t('factory 产出 apply 与 inject', () => {
  const mod = loadModule()
  assert.equal(typeof mod.apply, 'function', 'apply 不是函数')
  assert.equal(typeof mod.inject, 'function', 'inject 不是函数')
})
t('factory 内部自己造 module 并 return（宿主不传第三个参数）', () => {
  assert.match(src, /const module = \{ exports: \{\} \}/, '没有自造 module —— 用宿主的 module 参数会静默失效')
})
t('React 走 require 而非全局', () => {
  assert.match(src, /require\('react'\)/, "没有 require('react')")
})

console.log('\n2. 挂载路径（今天的真 bug 就在这）')
t('apply() 在调用时才 ctx.get("slots")（服务懒加载，不能顶层解引用）', () => {
  assert.ok(!/^const slots = ctx/m.test(src), '仍在模块顶层解引用 ctx')
  assert.match(src, /ctx\.get\('slots'\)/, '没有在 apply 里 ctx.get')
})
t('不再使用已失效的插槽名 sidebar.right.pane.tab', () => {
  const inCode = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l) && l.includes('sidebar.right.pane.tab'))
  assert.equal(inCode.length, 0, `代码里还有 ${inCode.length} 处`)
})


console.log('\n3. 运行时行为')
t('拿不到 slots 时安静退出、不抛错', () => {
  const mod = loadModule()
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }), 'apply 抛错了')
})
t('ctx.get 抛异常时也不炸', () => {
  const mod = loadModule()
  assert.doesNotThrow(() => mod.apply({ get: () => { throw new Error('no service') } }), 'apply 抛错了')
})
t('apply 会 inject conversation.view 并 register 连载标签', () => {
  const mod = loadModule()
  let reg = null
  let injectedSlot = null
  const ctx = {
    get: (k) => (k === 'slots'
      ? { inject: (n, fn) => { injectedSlot = n; fn() },
          register: (d, comp) => { reg = { d, comp } } }
      : undefined),
  }
  mod.apply(ctx)
  assert.equal(injectedSlot, 'conversation.view', `注入了 ${injectedSlot}`)
  assert.ok(reg, '没有调 register')
  assert.equal(reg.d.id, 'dsh-xiaoshuo', `id 不对：${reg.d.id}`)
  assert.equal(reg.d.name, 'conversation.view', `插槽名不对：${reg.d.name}`)
  assert.equal(typeof reg.comp, 'function', '组件应是函数')
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
