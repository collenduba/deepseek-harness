---
description: "轮询 GitHub issue，并为新 issue 打开 Bot 工单"
kind: "package-reference"
---

# @deepseek-ai/dsh-bot-source-github

[English](README.md) | 中文

## 概述

通过 `gh` CLI 观察一个 GitHub 仓库，为每个新的开放 issue 打开一条 Bot 工单；当 `target` 为 `pull-requests` 时，为每个新的拉取请求修订打开工单。指定 Bot 的执行会话收到 issue 标题、URL 与正文作为指令，并在 Bot 的对话中回报。轮询就是全部模型：Host 停止时什么都不运行，也不会写回 GitHub。

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
    query: ''
    pollSeconds: 60
    mode: observe
    target: issues
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `bot` | 必填 | 接收工单的 Bot 名称。 |
| `repository` | 必填 | `owner/name` 形式的仓库。 |
| `query` | 空 | `gh` 搜索查询；空表示列出所有开放 issue 或拉取请求。 |
| `pollSeconds` | `60` | 轮询间隔秒数，至少 15。 |
| `ghCommand` | `gh` | 可执行文件名或绝对路径。 |
| `timeoutMs` | `30000` | 单次 `gh` 调用时限。 |
| `backlog` | `ignore` | `ignore` 在启动时把已有 issue 标记为已处理；`open` 在首次轮询时为所有开放 issue 开工单。 |
| `mode` | `observe` | `observe` 为每个新 issue 记录候选且不开工单；`auto` 开工单。 |
| `target` | `issues` | `issues` 观察开放 issue；`pull-requests` 观察开放拉取请求的修订。 |
| `includeDrafts` | `false` | 是否也审阅草稿拉取请求。 |
| `worktrees` | `false` | 为每个拉取请求修订创建独立 git worktree 并交给工单。 |
| `worktreeRoot` | 空 | 审阅 worktree 的父目录；空表示 Bot 工作区旁边的 `.dsh-worktrees`。 |
| `gate` | `off` | `label`：根据工单结论与检查为已审阅的拉取请求打标签。 |
| `gateLabel` | `merge-ready` | 审阅通过且检查全绿时添加的标签。 |
| `gateFailLabel` | `needs-work` | 审阅发现阻塞项时添加的标签。 |
| `merge` | `false` | 允许 `bot_merge` 在有人批准该确切 head 后以 squash 方式合并。 |
| `requireChecks` | `true` | 要求至少一个已报告检查；`false` 时没有检查的拉取请求视为全绿。 |
| `writeBack` | `false` | 工单结束后在对应 issue 上评论一次结果。 |
| `allowedAuthors` | `[]` | 允许发起工作的登录名；空表示所有人。其他人只会记录为 `filtered`，不会开工单。 |
| `autostart` | `true` | 挂载时启动轮询。设为 `false` 时只注册工具，由嵌入方自行调用导出的 `runSource`。 |
| `maxSeen` | `200` | 每个仓库记住的已处理 issue 编号数。 |

### 审阅候选

| 工具 | 用途 |
|---|---|
| `bot_candidates` | 按最新 issue 优先列出本仓库候选，可按状态过滤。 |
| `bot_accept_candidate` | 把一个 `would-open` 候选项提升为配置 Bot 上的工单。 |
| `bot_merge` | 在 `merge` 开启且有人批准确切 head 后合并已过门禁的拉取请求。 |

```text
bot_candidates({ state: 'would-open', limit: 10 })
bot_accept_candidate({ number: 42 })
```

只有 `would-open` 可以被提升；`filtered` 在名单改变前保持关闭，`opened` 已经有工单。

Host 上的 `gh` CLI 必须已认证。本来源继承清理过的进程环境，因此 `*TOKEN*`、`*KEY*`、`*SECRET*` 与 `*PASSWORD*` 变量不会到达它；`gh` 读取自己的凭据存储。

<a id="understand-the-implementation"></a>
## 理解实现

- **游标与候选。** `bot_source_github` 域（版本 4）为每个仓库保存一条 `{ seen: string[] }` 记录，并为每个新 issue 保存一条确定性 id 的候选记录。首次轮询写入种子；之后每次轮询与之比较。版本 1 到版本 3 的存储原样加载。
- **投递。** 每个新 issue 先记录候选。`auto` 模式下打开一条标题为 `#<number> <title>` 的工单，把候选标为 `opened` 并附上工单 id，其余行为不变。`observe` 模式下只记录日志、候选保持 `would-open`。issue 按最旧优先处理，且整批记录完成后游标才前进，因此失败会在下次轮询重试整批。
- **可测试性。** 轮询循环的列表与评论效果以参数传入，测试因此可以在没有 `gh` 进程的情况下，用真实存储覆盖观察、自动、准入与写回。
- **拉取请求。** `target: pull-requests` 时，每个 `number@head` 组合是独立候选，因此新推送就是一次新审阅，旧修订不会被重开。默认跳过草稿，除非开启 `includeDrafts`。工单指令要求执行者为 head SHA 建立 worktree、对照 base 审阅、遵循仓库约定、运行成本低的检查、用一次 `gh pr comment` 发布摘要，并且绝不推送或合并。
- **独立 worktree。** 开启 `worktrees` 后，来源把 `pull/<n>/head` 抓取到 `refs/dsh-review/<n>-<sha>`，在 `worktreeRoot` 下建立 detached worktree，把路径作为工单工作区传入，指令也说明执行者已在其中。审阅工单进入 `ready`、`failed` 或 `blocked` 后，下一次轮询移除 worktree 与 `refs/dsh-review` 引用，并记录 `cleanedAt`。准备过程可安全重试：失败尝试留下的注册或引用会先被清理；单个修订失败不会阻塞其他修订。
- **合并门禁。** 开启 `gate: label` 后，来源读取审阅工单的 `verdict`：`fail` 添加 `gateFailLabel`，`pass` 只有在所有已报告的检查成功后添加 `gateLabel`。它会校正标签：失败的结论或未通过的检查会撤下相反的标签，旧的 commit status 也计入检查。它从不执行合并；请配合要求该标签的分支保护，合并仍由人完成。
- **强制合并。** 开启 `merge` 后，`bot_merge` 只在候选门禁为 `ready`、被审阅 head 是当前 head，且存在动作为 `merge`、载荷为 `owner/name#<n>@<sha>` 的已批准请求时合并。该批准就是人的底线；没有它工具会拒绝。
- **准入。** 作者不在 `allowedAuthors` 中的 issue 仍会记录候选，但标记为 `filtered`，两种模式下都不会开工单。比较为大小写不敏感的登录名。
- **写回。** 开启 `writeBack` 后，每次轮询检查本来源的候选：工单到达 `ready`、`failed` 或 `blocked` 且尚无评论回执时，在 issue 上发布一条评论并记录时间。失败的评论会记录日志并在下次轮询重试；已投递的不会重复。
- **失败。** `gh` 调用失败或缺少 Bot 时记录日志并在下一个间隔重试；循环不会让插件 fiber 退出，释放时会中止进行中的轮询并等待循环结束。
- **除游标外没有去重。** 见过一次的 issue 编号不会再开工单，即使内容变化。

<a id="model-experience"></a>
## 模型体验

### 候选工具

#### 模型看到什么

`bot_candidates` 接收可选的 `state` 与 `limit`，返回 `{ candidates: [{ number, title, state, ticketId? }] }`。`bot_accept_candidate` 接收 `number`，返回 `{ ticketId, number }`。`bot_merge` 接收 `number` 与 `head_sha`，在门禁未就绪或没有人批准确切 head 时拒绝，成功时返回 `{ merged, number }`。描述与 schema 在来源插件中声明。

#### Token 影响

每个挂载该插件的 Agent 承担三个 schema，每次调用一行短结果。

#### KV Cache 影响

schema 在挂载期间静态；结果追加到对话。

### 拉取请求指令

#### 模型看到什么

每个被审阅的修订一条用户消息：PR 编号、标题、URL、head SHA 与 base 分支、建立步骤或“运行时已把执行者放进独立检出”的说明、diff 命令、仓库约定提醒、要运行的检查，以及要求的发现格式与确切的 `gh pr comment` 命令。

#### Token 影响

每个修订一条指令，位于其执行会话；不包含 PR 标题与正文，执行者需要时自行通过 `gh` 读取。

#### KV Cache 影响

每次审阅开启新会话，因此指令建立该会话的前缀。

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
- 写回只评论一次，不会关闭 issue，也不会回复评审线程；它需要 `gh` 对该仓库的写权限。
- 准入只匹配作者登录名：组织成员、团队与 Bot 作者都需要显式列出。
- `autostart: false` 时不会轮询，直到嵌入方调用 `runSource`；工具仍然注册并读取同一份存储。
- 轮询发现工作时 Bot 必须已存在；缺少 Bot 会记录日志并重试。
- `requireChecks` 为 true 时，没有任何已报告检查的拉取请求永远不会进入 `merge-ready`；没有 CI 的仓库可以把它设为 `false`，或补上一个检查。空的汇总无法区分“仓库没有 CI”和“刚推送、检查尚未注册”，因此 `requireChecks: false` 时门禁可能在任何检查报告前就把新 head 标为绿色；有 CI 的仓库应保持 `true`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

这是第一个 Source。计划中的触发器层会增加准入规则、观察模式与共享策略；本包有意只实现它需要的轮询与工单投递。
</details>
