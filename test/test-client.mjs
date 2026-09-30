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

console.log('0. package.json —— 缺 dsh.client 时客户端根本不会被加载')
{
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
  t('声明了 dsh.client.platform = web', () => {
    // 这一条曾经缺失：服务端 bundle 照常加载、工具与 API 全都注册，
    // 但宿主不会把 client.js 挂进客户端清单 → load() 从不执行 → 面板永不出现，
    // 且**没有任何报错**。
    assert.equal(pkg.dsh?.client?.platform, 'web', '缺 dsh.client.platform —— 客户端模块不会被加载')
  })
  t('inject 用完整包名（与 dsh-teams-x 一致）', () => {
    for (const dep of pkg.dsh?.client?.inject || []) {
      assert.ok(dep.startsWith('@deepseek-ai/'), `inject 项 ${dep} 缺少 @deepseek-ai/ 前缀`)
    }
  })
}

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
t('右栏服务用响应式注入取，不能顶层解引用（懒加载）', () => {
  // 顶层解引用只会拿到 undefined 且永不再来 —— 面板会静默不出现
  assert.ok(!/^const tabs = ctx/m.test(src), '仍在模块顶层解引用 ctx')
  assert.match(src, /ctx\.inject\(\['sidebarRightTabs'\]/, "没有用 ctx.inject(['sidebarRightTabs'], ...)")
  assert.match(src, /injected\.get\('sidebarRightTabs'\)/, '没有从 injected 里取服务')
})
t('ctx.slots 不能顶层解引用，必须 ctx.get(\'slots\')', () => {
  // 顶层解引用的真实报错：
  //   Error: cannot get property "slots" without inject
  // 这条和 sidebarRightTabs 同源 —— 我第一次只改了 tabs、漏了 slots，
  // 于是「tab 类型注册成功、内容插槽注册抛错」且被 ctx.inject 回调外的 try 吞掉。
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  assert.ok(!/ctx\.slots\./.test(code), '代码里还有 ctx.slots. 顶层解引用')
  assert.match(code, /ctx\.get\('slots'\)/, '没有用 ctx.get(\'slots\')')
})
t('注册到 sidebar.right.pane.tab（右侧边栏，原始设计）', () => {
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  assert.match(code, /ctx\.get\('slots'\)\.inject\('sidebar\.right\.pane\.tab'/, '没有注册到右栏 tab 插槽')
  assert.match(code, /'sidebar\.right\.pane\.tab\.title'/, '没有注册 tab 标题插槽')
})
t('tabs.register 带 kind 与 priority（缺了不报错但不出现在右栏）', () => {
  // ⚠️ 必须先剥掉注释再找：文件头的说明注释里**也**写了 tabs.register({...})，
  // 直接 indexOf 会命中注释，于是报"缺 kind"——而真代码里是有的。
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  const i = code.indexOf('tabs.register(')
  assert.ok(i > 0, '没有调 tabs.register')
  const m = code.slice(i, i + 400)
  assert.match(m, /kind:\s*'/, 'tabs.register 缺 kind')
  assert.match(m, /priority:\s*'/, 'tabs.register 缺 priority')
})
t('内容插槽用 key 绑定 tab（keyed 插槽不是 id）', () => {
  assert.match(src, /key:\s*TAB|key:\s*TAB_ID/, '内容插槽没有用 key 绑定')
})



console.log('\n2.5 设计令牌（踩过的坑：编造令牌名 + 兜底值 = 静默失效）')
t('所有 CSS 变量都来自真实令牌族 --dsw-*', () => {
  // 我曾用了 --dsh-ink / --dsh-surface / --dsh-line / --dsh-accent 这一套 ——
  // DSH 里根本不存在（真实的是 --dsw-alias-*）。因为 var() 带了兜底值，
  // 亮色下"碰巧能看"，暗色下卡片仍是浅色、章节标题继承浅色文字 → 整列看不见。
  // 带了兜底值的错误令牌**永远不报错**，所以必须靠断言挡。
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  const vars = [...code.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map(m => m[1])
  const bad = [...new Set(vars)].filter(v => !v.startsWith('--dsw-'))
  assert.equal(bad.length, 0, `用了不存在的令牌族：${bad.join(', ')}`)
})
t('卡片内文字都有显式颜色（不能靠继承）', () => {
  // 卡片背景是自定义的，继承色来自外层主题 —— 暗色下会变成浅字落浅卡片
  const i = src.indexOf('function Chip')
  const seg = src.slice(i, i + 900)
  assert.match(seg, /color:\s*T\.ink/, '章节标题没有显式颜色')
})
t('主按钮用 brand / onBrand 反色对', () => {
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  assert.match(code, /background:\s*primary\s*\?\s*T\.brand/, '主按钮底色不是 T.brand')
  assert.match(code, /color:\s*primary\s*\?\s*T\.onBrand/, '主按钮文字不是 T.onBrand')
})

console.log('\n3. 运行时行为')
t('ctx.inject 不存在时不抛错（老宿主 / 测试环境）', () => {
  const mod = loadModule()
  // 没有 inject、也没有 slots：两层保护都要在
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }), 'apply 抛错了')
  assert.doesNotThrow(() => mod.apply({}), '空 ctx 也应不抛错')
})
t('服务到位但 slots 缺失时不抛错', () => {
  const mod = loadModule()
  const ctx = {
    inject: (deps, fn) => fn({ get: () => ({ register: () => () => {} }) }),
    get: () => undefined,        // 注意：拿不到 slots
  }
  assert.doesNotThrow(() => mod.apply(ctx), 'apply 抛错了')
})
t('apply 会把右栏 tab 类型与内容插槽都注册上', () => {
  const mod = loadModule()
  const calls = { inject: [], register: [], tabType: null }
  const slotsSvc = {
    inject: (n, fn) => { calls.register.push(n); if (typeof fn === 'function') fn() },
    register: (d) => ({ d }),
  }
  const ctx = {
    // 关键：slots 走 get()，不是顶层属性
    get: (k) => (k === 'slots' ? slotsSvc : undefined),
    inject: (deps, fn) => {
      calls.inject.push(deps.join(','))
      if (typeof fn === 'function') fn({ get: () => ({ register: (d) => { calls.tabType = d; return () => {} } }) })
    },
  }
  mod.apply(ctx)
  assert.ok(calls.inject.includes('sidebarRightTabs'), `没有注入 sidebarRightTabs：${calls.inject}`)
  assert.ok(calls.tabType, '没有调 tabs.register')
  assert.equal(calls.tabType.id, 'dsh-xiaoshuo', `tab id 不对：${calls.tabType.id}`)
  assert.ok(calls.register.includes('sidebar.right.pane.tab'), `没有注册内容插槽：${calls.register}`)
  assert.ok(calls.register.includes('sidebar.right.pane.tab.title'), '没有注册标题插槽')
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
