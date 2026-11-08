---
description: "轮询 GitHub issue，并为新 issue 打开 Bot 工单"
kind: "package-reference"
---

# @deepseek-ai/dsh-bot-source-github

[English](README.md) | 中文

## 概述

通过 `gh` CLI 观察一个 GitHub 仓库，为每个新的开放 issue 打开一条 Bot 工单。指定 Bot 的执行会话收到 issue 标题、URL 与正文作为指令，并在 Bot 的对话中回报。轮询就是全部模型：Host 停止时什么都不运行，也不会写回 GitHub。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

与一个 Bot 和一个仓库一起挂载。随产品发布的 `@deepseek-ai/dsh-bot-bundle` 已插入该行（默认禁用）；用自己的配置启用：

```yaml
- id: bot-source-github
  disabled: false
  config:
    bot: reviewer
    repository: owner/name
    query: 'is:issue is:open'
    pollSeconds: 60
    mode: observe
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `bot` | 必填 | 接收工单的 Bot 名称。 |
| `repository` | 必填 | `owner/name` 形式的仓库。 |
| `query` | `is:issue is:open` | 选择观察哪些 issue 的 `gh` 搜索查询。 |
| `pollSeconds` | `60` | 轮询间隔秒数，至少 15。 |
| `ghCommand` | `gh` | 可执行文件名或绝对路径。 |
| `timeoutMs` | `30000` | 单次 `gh` 调用时限。 |
| `backlog` | `ignore` | `ignore` 在启动时把已有 issue 标记为已处理；`open` 在首次轮询时为所有开放 issue 开工单。 |
| `mode` | `observe` | `observe` 为每个新 issue 记录候选且不开工单；`auto` 开工单。 |
| `maxSeen` | `200` | 每个仓库记住的已处理 issue 编号数。 |

Host 上的 `gh` CLI 必须已认证。本来源继承清理过的进程环境，因此 `*TOKEN*`、`*KEY*`、`*SECRET*` 与 `*PASSWORD*` 变量不会到达它；`gh` 读取自己的凭据存储。

<a id="understand-the-implementation"></a>
## 理解实现

- **游标与候选。** 一个 `bot-source-github` 域（版本 2）为每个仓库保存一条 `{ seen: string[] }` 记录，并为每个新 issue 保存一条确定性 id 的候选记录。首次轮询写入种子；之后每次轮询与之比较。版本 1 的存储原样加载。
- **投递。** 每个新 issue 先记录候选。`auto` 模式下打开一条标题为 `#<number> <title>` 的工单，把候选标为 `opened` 并附上工单 id，其余行为不变。`observe` 模式下只记录日志、候选保持 `would-open`。issue 按最旧优先处理，且整批记录完成后游标才前进，因此失败会在下次轮询重试整批。
- **失败。** `gh` 调用失败或缺少 Bot 时记录日志并在下一个间隔重试；循环不会让插件 fiber 退出，释放时会中止进行中的轮询并等待循环结束。
- **除游标外没有去重。** 见过一次的 issue 编号不会再开工单，即使内容变化。

<a id="model-experience"></a>
## 模型体验

### 工单指令

#### 模型看到什么

每个新 issue 一条用户消息，由 `ticketInstruction` 构造：`Work on <repository> issue #<number>: <title>`、空行、issue URL、空行，以及 issue 正文——正文为空时为 `(no description)`。执行者还会收到 bot 包的标准执行前言，其中给出工单 id 并要求调用 `bot_report`。

#### Token 影响

每个 issue 在该执行会话中一条指令消息。issue 正文没有上限：很大的正文会产生很大的指令。

#### KV Cache 影响

每条工单开启新会话，因此指令建立该会话的请求前缀，而不是替换既有前缀。本来源不向任何其他会话增加请求内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅轮询：没有 webhook、评论、拉取请求或表情回应。
- 不写回 GitHub——执行者在 Bot 的对话中回报，除非后续来源扩展，否则没有人评论到 issue。
- 编辑 issue 不会重新开工单；只有未见过的编号才会。
- 游标按仓库保存，因此同一仓库的两个配置只有在 Bot 与查询都相同时才共享状态。
- `observe` 会推进游标，候选只存在来源自己的存储里：目前没有审阅工具或面板，之后切到 `auto` 也不会重开先前观察到的 issue。
- 轮询发现工作时 Bot 必须已存在；缺少 Bot 会记录日志并重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

这是第一个 Source。计划中的触发器层会增加准入规则、观察模式与共享策略；本包有意只实现它需要的轮询与工单投递。
</details>
