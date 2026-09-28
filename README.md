# dsh-xiaoshuo —— 《夜行账房》连载流水线插件

给 DSH 加一个**连载流水线的控制面**：7 个 agent 工具 + 一个右侧栏仪表盘。

## 它管什么、不管什么

| | |
|---|---|
| **管** | 状态读取、上下文打包、唤起写作/审稿/发布/巡检、面板可视化 |
| **不管** | 正文与设定。仍以工作区纯文本为准，`AGENT.md` 是唯一权威 |

引擎是 `tools/*.py`（已跑通并有本地测试），本插件是它的控制面，**不重写、不复制数据源**。

## agent 工具

| 工具 | 用途 |
|---|---|
| `novel_flow_status` | 流水线全景：已发/待发/已审、卷一进度、三条定时、心跳结果 |
| `novel_flow_brief` | 「写下一章」全部上下文：节点表、硬约束、番茄节拍、时间线基准、最近 2 章正文、弃坑雷区 |
| `novel_flow_arc` | 剧情档案：章节清单、发布/审阅状态 |
| `novel_flow_write` | 唤起写作（后台） |
| `novel_flow_review` | 唤起独立审稿代理（后台，只审不改） |
| `novel_flow_publish` | 手动发布（同步，回显结果） |
| `novel_flow_heartbeat` | 手动巡检 + 自愈（同步） |

## HTTP API（面板用）

```
GET  /xiaoshuo/api/status     快照 + 定时任务
GET  /xiaoshuo/api/brief      续写上下文
GET  /xiaoshuo/api/chapter?index=N
GET  /xiaoshuo/api/report     最新审稿报告
POST /xiaoshuo/api/trigger    {action: write|review|publish|heartbeat}
```

## 配置

`DSH_XIAOSHUO_ROOT` 环境变量，默认 `/home/xiaoxin/xiaoshuo`。

## 开发

```bash
node test/test-flow.mjs      # 25 项本地测试，不启动 DSH、不占端口
```

## 承自 dsh-novel 的三条硬经验

1. **不 import 任何 `@deepseek-ai/*` 宿主包** —— link 安装时 Node 从物理路径往上找会 `ERR_MODULE_NOT_FOUND`。`ctx.tools.register` 直接收普通对象。
2. `parameters` / `output.schema` 必须是**原始 JSON Schema**，`required` 是数组而非 `required: true`。
3. 改完先跑本地测试，**不要为了验证去启动 DSH 占端口**。
