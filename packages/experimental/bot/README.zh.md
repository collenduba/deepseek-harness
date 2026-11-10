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
| `bot_create` | 把当前会话绑定为 Bot 的路由会话，并保存名字、职责、工作区，以及可选的 preset、工具白名单、被禁止的 shell 命令模式与硬性底线动作。 |
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

服务打开一个 `bot` 域，版本 14，包含五张表。版本 1 到版本 13 的存储原样加载。

| 表 | 键 | 保存 |
|---|---|---|
| `bots` | `BotId` | 名字、职责、工作区、路由会话、可选的执行 preset、工具白名单、被禁止的 shell 命令模式与硬性底线动作、状态、时间戳 |
| `tickets` | `TicketId` | 标题、指令、可选工作区、阻塞工单、验收标准、阶段、可选审阅结论、阶段时间线、路由会话、执行会话、摘要、时间戳 |
| `memories` | `BotMemoryId` | Bot、文本、创建时间，以及写下它的工单（若有） |
| `approvals` | `BotApprovalId` | Bot、工单、动作、确切载荷、SHA-256 摘要、状态、决定备注 |
| `notices` | `BotNoticeId` | Bot、工单、对话、正文、摘要、创建与投递时间 |

工单从 `queued` 进入 `working`，再到 `waiting` 或 `ready`，也可能进入 `blocked` 和 `failed`。一个 Bot 同时最多运行 `maxWorkersPerBot` 个执行者：更多工单留在 `queued` 且没有执行会话，`ready`、`failed` 或 `blocked` 的报告会启动最旧的排队工单。超过 `maxHandoffDepth` 的交接在创建工单前即被拒绝；`waiting` 保留槽位。工单可以指定 `blockedBy`：在所有阻塞工单报告 `ready` 前保持 `queued`，阻塞工单报告 `failed` 时其依赖工单转为 `blocked`；`waiting` 的阻塞工单让依赖继续排队；之后阻塞工单 `ready` 时，其 blocked 依赖会回到队列。验收标准会写进执行者指令。执行者还有墙钟预算（`workerTimeoutMinutes`，默认 30，`0` 关闭）：计时从启动开始，等待答复的时间也计入，而运行时投递的答复会把 `waiting` 工单移回 `working` 并重新开始计时，`blocked` 工单保持 blocked；到期时取消执行者、把工单标记为 blocked、通知路由会话，并启动下一个排队工单。启动时运行时会把手头已无执行者的工单标记为 blocked、为仍在运行的执行者重新装上预算，因此重启不会让工单永远停在 `working`；排队工单在组合就绪后启动。启动失败会保留工单并标记为 `failed`，附上错误信息，面板可以看到发生了什么，而不是丢掉请求。

`bot_open_ticket` 通过 `ctx.agents.create` 创建一个普通根会话作为执行者：它以 Bot 的工作区（若工单自带工作区则用它）为工作目录，挂载到该工作区，标题为 `<bot>: <ticket>`，并收到一条指令消息。它会挂载 Bot 指定的 preset，未指定时挂载注册表的默认 preset；两者都没有时执行者没有工具，因为根组合本身不携带工具。执行者不是子智能体；它比创建者活得久，并出现在侧栏。当它调用 `bot_report` 时，服务校验调用者是工单的执行会话，写入阶段和摘要，并在路由会话在线时发送一条通知。执行者的指令还会带上 Bot 的笔记（最新在前），位于“Known context for this bot”之下。Bot 指定工具白名单时，执行者只看到这些工具可调用，`tools/pre-execute` 门禁会拒绝其他工具；`bot_report`、`bot_remember`、`bot_request_approval` 与 `bot_handoff` 始终可用。需要决定的执行者调用 `bot_request_approval`，服务保存确切载荷及其 SHA-256 摘要并通知对话；`bot_decide_approval` 把决定记录到该载荷上，并把结果发回执行会话。默认这是建议性协议；开启 `enforceApprovals` 后，`tools/pre-execute` 会拒绝工单执行者中未被批准覆盖的受保护工具：只有针对该工单、载荷与确切 shell 命令相同的已批准请求才能放行，拒绝理由会提示先请求批准再重试。Bot 的 `hardFloor` 动作在请求时即被拒绝，之后也不能批准：必须由人执行。Bot 还可以列出 `blockedCommands`（大小写不敏感的正则）；`tools/pre-execute` 门禁会拒绝任何匹配的受保护 shell 命令，无论审批状态如何。执行者也可以调用 `bot_handoff`：在另一个活跃 Bot 上开工单，记录 `parentTicket` 与 `parentBotName`，并告知新执行者来源工单。

<a id="model-experience"></a>
## 模型体验

### Bot 工具

#### 模型看到什么

这些工具一起注册在 `ctx.tools` 上：`bot_create` 接收 `name`、`job`、`workspace` 和可选的 `preset`；`bot_list` 没有参数；`bot_open_ticket` 接收 `title`、`instruction` 与可选的 `workspace`；`bot_report` 接收 `ticket_id`、来自 `waiting`、`ready`、`blocked` 和 `failed` 的 `stage`、一行 `summary` 与可选的 `verdict`；`bot_ticket` 接收 `ticket_id` 并返回时间线。每个结果都是模型无需解析散文就能读取的小型 JSON 对象。

#### Token 影响

每个挂载该插件的 Agent 承担四个 schema，加上每次调用一行短结果。执行指令是每个工单一条用户消息，保留在该执行者的历史中。

#### KV Cache 影响

schema 在挂载期间保持静态。工单结果追加到其对话而不重写提示词前缀；执行指令开启新会话并建立自己的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 笔记是无上限的纯文本：指令会随笔记增长，目前没有遗忘策略。
- 白名单之外的工具在被调用时拒绝，但模型仍然会在工具目录里看到它，只能从拒绝理由得知限制。
- 硬性底线按动作字符串精确匹配；请求之后修改底线会让该请求停留在待处理且无法批准，直到操作者拒绝。
- 被禁止的命令模式匹配模型写在受保护 shell 工具上的命令文本；混淆或换一种写法可以绕过，因此这些模式是护栏，不是沙箱。
- 门禁只覆盖受保护工具的 `command` 参数。其他有后果的工具仍靠协议约束，除非加入 `guardedTools` 并提供可比对的载荷；同一批准可重复用于相同命令。
- 只有执行会话在线时决定才会送达；否则记录已决定，执行者在下一轮才会知道。
- 安静时段使用 Host 本地时钟；没有按用户划分的时区，Host 停止时不投递任何内容。
- 摘要是每个对话每个间隔一条消息；目前没有按用户的排程或按 Bot 的上限。
- 交接目标按名称在活跃 Bot 中解析，名称必须唯一；暂停或重名的目标会被拒绝。
- 交接链在 `maxHandoffDepth` 停止，但后续一跳仍可能指向链中已用过的 Bot。
- 因预算或重启而停止的执行者会留下会话日志，但不会自动续跑其回合；工单会记录这次中断；答复只会恢复 `waiting` 工单，blocked 的工单需要新开一条。
- 启动对账会为仍在运行的执行者重新装上完整预算，因此重启会把它的截止时间在配置分钟数之外延长。
- 每个工单一个执行者，没有并发上限或槽位核算。
- 只有路由会话在线时报告才会到达；否则工单保留阶段和摘要。
- 命名的 `preset` 必须存在于组合中；缺少 agent-preset 注册表时启动会明确报错。未指定 preset 时执行者挂载注册表当前的默认 preset，因此部署默认 preset 必须包含其工作所需的工具。
- 生成的工具目录用桩存储域挂载本包，因此目录记录 schema，但不记录工具写入的记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

首个切片有意把服务和工具放在同一个包里。当第二个使用者出现时，再拆分执行者包。
</details>
