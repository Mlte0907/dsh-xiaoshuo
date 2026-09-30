# dsh-xiaoshuo —— 小说连载流水线插件

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加一条**可无人值守的连载流水线**：
写作 → 独立审稿 → 裁决 → 自动修正 → 发布番茄，全链路定时跑，出问题才打断人。

以《夜行账房》为第一个实例，但机制本身与具体书无关。

## 它管什么、不管什么

| | |
|---|---|
| **管** | 状态读取、续写上下文打包、唤起写作/审稿/裁决/自动修正/发布/同步、以及一个可视化面板 |
| **不管** | 正文与设定。仍以工作区纯文本为准，`AGENT.md` 是唯一权威 |

引擎是 `tools/*.py`（已跑通并有本地测试），本插件是它的**控制面**：`novel_flow_*` 工具 + 会话内面板。
**不重复造内容库，也不做第二个数据源。**

## agent 工具

| 工具 | 用途 |
|---|---|
| `novel_flow_status` | 流水线全景：已发/待发/已审、卷一进度、全部定时任务、最近巡检结果 |
| `novel_flow_brief` | 「写下一章」的全部上下文：节点表、写作硬约束、平台节拍、时间线基准、最近 2 章正文（对齐语气）、弃坑雷区 |
| `novel_flow_arc` | 剧情档案：章节清单、发布/审阅状态、伏笔表位置 |
| `novel_flow_write` | 唤起写作（后台） |
| `novel_flow_review` | 唤起独立审稿代理（后台，只审不改） |
| `novel_flow_arbitrate` | 裁决待决事项，写回设定文件 |
| `novel_flow_autofix` | 跑自动修正：只改「修正类」，改完必须自证，不过就回滚 |
| `novel_flow_publish` | 手动发布（同步，回显结果） |
| `novel_flow_sync` | 把本地修正同步到平台（仅已发布章） |
| `novel_flow_heartbeat` | 巡检 + 自愈（同步） |

## 设计要点

### 修正类 vs 裁决类

流水线把问题分成两档，**这是能不能自动化的分界线**：

- **修正类** —— 规则已写死正确答案，正文只是违反了它。判据一句话：**改完不产生新的设定判断**。可以自动改，改完用 `verify` 自证。
- **裁决类** —— 需要在两个都说得通的选项间选边。**归人**；裁决器只在信息足够时代劳，信息不足就 `defer`。

`auto_fix.py` 有四道熔断：非修正类跳过 / 原文必须逐字唯一命中 / 改后自证不过则回滚 / 单章改动超阈值停手。

### 跨会话交接

定时任务的投递**锁死在创建它的会话**（DSH 源码原话 `Reminder delivery never leaves the owning session`），
所以结论不走会话，走文件：两条链路结尾都调 `tools/deliver.py --pipeline`，
把摘要投进 `data/pangu_queue.jsonl`。下次开工读一眼就知道昨晚发生了什么。
**不靠通知，靠收件箱。**

## 面板

会话内「连载」标签（`conversation.view` 插槽）：

- 分段刻度进度条：绿=已发、蓝=已写未发、灰=未写
- 定时任务一览
- 巡检异常与待裁决聚成「需要处理」，只在真有问题时出现
- 四个动作：写一章 / 审稿 / 发布 / 巡检
- 章节徽标（发 / 待发 · 已审）
- 审稿报告内嵌查看

## 安装

```bash
dsh plugin --profile web add Mlte0907/dsh-xiaoshuo
```

或手动（等价于 `dsh-pangu` 等本地插件的做法）：

```bash
# 1) profile package.json 的 dependencies 加一行
#    "dsh-xiaoshuo": "github:Mlte0907/dsh-xiaoshuo"
# 2) dsh.profile.bundles 加一项 "dsh-xiaoshuo"
# 3) pnpm install && dsh-restart
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_XIAOSHUO_ROOT` | `/home/xiaoxin/xiaoshuo` | 小说工作区路径 |

## 客户端模块的坑（踩过，值得抄）

面板的挂载契约**不要自己设计，照抄能工作的那份**（本仓 `lib/client.js` 照抄了 `dsh-pangu`）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-xiaoshuo',
  factory: (require) => {
    const module = { exports: {} }     // ← 自己造，宿主不传这个参数
    const React = require('react')     // ← 走 require，不是全局
    // ...
    module.exports = { apply, inject }
    return module.exports
  },
})
```

第一版自造了 `(function(exports, require){...})` 包装，宿主根本不认：
`module` 是 `undefined` → `module.exports` 静默失效 → **`apply` 永远不是函数，且不报任何错**。
面板从来没显示过，而当时 27 项测试全绿——**因为没有一条测「模块能否加载、能否挂上」**。

所以 `test/test-client.mjs` 把这件事变成可回归的：模块能否被 factory 加载、
`apply` 能否拿到 `slots` 并 `register`、拿不到服务时是否安静退出。

## 开发

```bash
npm test        # test-flow.mjs（数据层）+ test-client.mjs（客户端模块）
```

两套都不启动 DSH、不占端口。

## 承自 dsh-novel 的三条硬经验

1. **不 import 任何 `@deepseek-ai/*` 宿主包** —— link 安装时 Node 从物理路径往上找会 `ERR_MODULE_NOT_FOUND`
2. `parameters` / `output.schema` 必须是**原始 JSON Schema**，`required` 是数组而非 `required: true`
3. 改完先跑本地测试，**不要为了验证去启动 DSH 占端口**

## License

MIT
