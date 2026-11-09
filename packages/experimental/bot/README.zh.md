---
description: "打开工单并运行执行会话的持久 Bot"
kind: "package-reference"
---

# @deepseek-ai/dsh-bot

[English](README.md) | 中文

## 概述

`dsh-bot` 为 Host 组合加入持久 Bot。Bot 是一条存储域记录，绑定到创建它的会话，而不是会话本身。四个模型工具驱动它：`bot_create` 绑定对话，`bot_open_ticket` 打开一个工作单元，独立的执行会话运行指令，`bot_report` 记录结果并把结果送回 Bot 的路由会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

在同时提供 `storageDomain`、`tools`、`agents`、`agentDefaultModel`、`sessionTitle` 和 `workspaceRegistry` 的组合中挂载：

```yaml
- name: '@deepseek-ai/dsh-bot'
```

随后一个对话可以驱动一个 Bot：

| 工具 | 用途 |
|---|---|
| `bot_create` | 把当前会话绑定为 Bot 的路由会话，并保存名字、职责和工作区。 |
| `bot_list` | 列出部署中的每个 Bot 及其未结束工单数。 |
| `bot_open_ticket` | 给 Bot 一条具体指令，由执行会话运行。 |
| `bot_report` | 仅由工单的执行会话调用：记录 `ready`、`waiting`、`blocked` 或 `failed` 和一行摘要。 |
| `bot_remember` | 为 Bot 保存一条持久笔记；之后每个执行者都会读取它。 |
| `bot_request_approval` | 仅执行者：请求 Bot 的对话批准一个动作，决定绑定到确切载荷。 |
| `bot_decide_approval` | 仅路由会话：批准或拒绝待处理请求；执行者会收到结果。 |
| `bot_handoff` | 仅执行者：把一份工作交给另一个活跃 Bot，并链接到来源工单。 |
| `bot_archive` | 删除 Bot、其工单与笔记；执行会话与其目录保留。 |

<a id="understand-the-implementation"></a>
## 理解实现

服务打开一个 `bot` 域，版本 5，包含五张表。版本 1 到版本 4 的存储原样加载。

| 表 | 键 | 保存 |
|---|---|---|
| `bots` | `BotId` | 名字、职责、工作区、路由会话、可选的执行 preset、状态、时间戳 |
| `tickets` | `TicketId` | 标题、指令、阶段、路由会话、执行会话、摘要、时间戳 |
| `memories` | `BotMemoryId` | Bot、文本、创建时间，以及写下它的工单（若有） |
| `approvals` | `BotApprovalId` | Bot、工单、动作、确切载荷、SHA-256 摘要、状态、决定备注 |
| `notices` | `BotNoticeId` | Bot、工单、对话、正文、摘要、创建与投递时间 |

工单从 `queued` 进入 `working`，再到 `waiting` 或 `ready`，也可能进入 `blocked` 和 `failed`。启动失败会保留工单并标记为 `failed`，附上错误信息，面板可以看到发生了什么，而不是丢掉请求。

`bot_open_ticket` 通过 `ctx.agents.create` 创建一个普通根会话作为执行者：它以 Bot 的工作区为工作目录，挂载到该工作区，标题为 `<bot>: <ticket>`，并收到一条指令消息。执行者不是子智能体；它比创建者活得久，并出现在侧栏。当它调用 `bot_report` 时，服务校验调用者是工单的执行会话，写入阶段和摘要，并在路由会话在线时发送一条通知。执行者的指令还会带上 Bot 的笔记（最新在前），位于“Known context for this bot”之下。需要决定的执行者调用 `bot_request_approval`，服务保存确切载荷及其 SHA-256 摘要并通知对话；`bot_decide_approval` 把决定记录到该载荷上，并把结果发回执行会话。默认这是建议性协议；开启 `enforceApprovals` 后，`tools/pre-execute` 会拒绝工单执行者中未被批准覆盖的受保护工具：只有针对该工单、载荷与确切 shell 命令相同的已批准请求才能放行，拒绝理由会提示先请求批准再重试。执行者也可以调用 `bot_handoff`：在另一个活跃 Bot 上开工单，记录 `parentTicket` 与 `parentBotName`，并告知新执行者来源工单。

<a id="model-experience"></a>
## 模型体验

### Bot 工具

#### 模型看到什么

四个工具一起注册在 `ctx.tools` 上：`bot_create` 接收 `name`、`job`、`workspace` 和可选的 `preset`；`bot_list` 没有参数；`bot_open_ticket` 接收 `title` 和 `instruction`；`bot_report` 接收 `ticket_id`、来自 `waiting`、`ready`、`blocked` 和 `failed` 的 `stage`，以及一行 `summary`。每个结果都是模型无需解析散文就能读取的小型 JSON 对象。

#### Token 影响

每个挂载该插件的 Agent 承担四个 schema，加上每次调用一行短结果。执行指令是每个工单一条用户消息，保留在该执行者的历史中。

#### KV Cache 影响

schema 在挂载期间保持静态。工单结果追加到其对话而不重写提示词前缀；执行指令开启新会话并建立自己的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 笔记是无上限的纯文本：指令会随笔记增长，目前没有遗忘策略。
- 门禁只覆盖受保护工具的 `command` 参数。其他有后果的工具仍靠协议约束，除非加入 `guardedTools` 并提供可比对的载荷；同一批准可重复用于相同命令。
- 只有执行会话在线时决定才会送达；否则记录已决定，执行者在下一轮才会知道。
- 安静时段使用 Host 本地时钟；没有按用户划分的时区，Host 停止时不投递任何内容。
- 摘要是每个对话每个间隔一条消息；目前没有严重程度排序或按 Bot 的上限。
- 交接目标按名称在活跃 Bot 中解析，名称必须唯一；暂停或重名的目标会被拒绝。
- 交接只阻止同一 Bot，因此 A → B → A 链是可能的，目前没有深度上限。
- 事件来源、观察与自动模式、审批记录、记忆和能力授权尚未实现。
- 每个工单一个执行者，没有并发上限或槽位核算。
- 只有路由会话在线时报告才会到达；否则工单保留阶段和摘要。
- 命名的 `preset` 必须存在于组合中；缺少 agent-preset 注册表时启动会明确报错。
- 生成的工具目录用桩存储域挂载本包，因此目录记录 schema，但不记录工具写入的记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

首个切片有意把服务和工具放在同一个包里。当第二个使用者出现时，再拆分执行者包。
</details>
