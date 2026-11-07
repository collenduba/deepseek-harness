---
description: "用路由与执行 preset 组合持久 Bot"
kind: "package-bundle"
---

# @deepseek-ai/dsh-bot-bundle

[English](README.md) | 中文

## 概述

把 `@deepseek-ai/dsh-bot`、两个 agent preset 与 Bot 状态条组合在一起。`bot-router` 是持有 Bot 的对话；`bot-worker` 是工单运行时的无人值守组合；`@deepseek-ai/dsh-client-ui-bot` 在输入框上方显示绑定的 Bot 与工单数量。

## 目录

- [使用本包](#use-this-package)
- [Preset](#presets)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

通过 Plugins 页面或 CLI 把 bundle 安装到 profile：

```sh
dsh plugin --profile web add @deepseek-ai/dsh-bot-bundle
```

用 **Bot router** preset 开启对话，调用 `bot_create`，再让 `bot_open_ticket` 所属的 Bot 使用 `preset: "bot-worker"`，这样每个工单的会话都会挂载执行组合。token、存储与执行行为属于 `dsh-bot`。

<a id="presets"></a>
## Preset

| Preset | 用途 | 工具 |
|---|---|---|
| `bot-router` | 持有 Bot 并接收其报告的对话。 | 人格与时间上下文；全局注册的工具仍然可见。 |
| `bot-worker` | 单个工单运行的无人值守会话。 | 文件读写、搜索、shell、后台作业、待办与技能。没有询问人、展示界面、修改配置、调度工作或访问 Web 的工具。 |

执行 preset 刻意收窄：持有 `ask_user_question` 或 `present` 的执行者会把轮次阻塞在永远不会到来的输入上。

<a id="model-experience"></a>
## 模型体验

间接地，通过 [bot 包](../bot/README.zh.md)：它拥有工具 schema 与执行指令。本 bundle 为它声明的每个 preset 增加一行人格，并选择这些 preset 挂载的工具。

#### KV Cache 影响

bundle 自身不增加请求内容。为会话选择 `bot-worker` 会建立不同的工具列表，在该会话首次请求时使其缓存前缀失效一次；此后工具列表保持不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- preset 可选但不强制：`bot_create` 绑定它运行所在的会话，因此路由 preset 是约定而不是门禁。
- 还没有禁止等待的守卫；路由仍可能运行阻塞的 shell 命令。
- 执行 preset 按设计省略 Web、子智能体、调度和展示工具；部署需要时在派生 preset 中加回。
- 状态条只做汇总；它不列出工单，也不打开执行会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

bundle 保持为仅补丁的包。运行时行为属于 `dsh-bot`，它拥有域、工具与执行者启动。
</details>
