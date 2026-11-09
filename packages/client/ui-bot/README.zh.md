---
description: "读取 bot 会话投影、显示在输入框上方的 Bot 状态条"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-bot

[English](README.md) | 中文

## 概述

在输入框上方增加一个紧凑面板：当前对话绑定的 Bot、工单数量、待处理数量，以及最多五行工单（需要人处理的排前面）。浏览器半部注册一个 `conversation.input.dock` 条目并读取 `useProjection('bot')`；没有 Bot 的对话不渲染任何内容。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

在同一个 profile 中与 `@deepseek-ai/dsh-bot` 一起挂载。配套的 `@deepseek-ai/dsh-bot-bundle` 已插入两行，安装该 bundle 是受支持的路径。

开启对话，调用 `bot_create`，再调用 `bot_open_ticket`。只要 `bot` 投影里有 Bot，状态条就会出现；工单进入 `waiting`、`ready`、`blocked` 或 `failed` 时，“待处理”数量随之上升。

<a id="understand-the-implementation"></a>
## 理解实现

- 注册：一个 `conversation.input.dock` 条目，id 为 `bot`，order 为 9。
- 数据：`useProjection('bot')`，即 `@deepseek-ai/dsh-bot` 注册的客户端视图。组件不调用 Host，也不持有状态。
- 文案：`bot` locale 命名空间，覆盖八种语言，作为插件 effect 注册。
- 渲染：一行汇总（Bot 名称、工单数、待处理数）和最多五行工单。行按阶段排序——blocked、failed、ready、waiting、working、queued——再按标题，阶段原样来自投影。报告后无需刷新即可更新。

<a id="model-experience"></a>
## 模型体验

无。本包只为人渲染 bot 投影，不注册任何工具、提示词、消息、schema、流或工具结果。Bot 工具及其模型可见文本属于 [`dsh-bot`](../../experimental/bot/README.zh.md)。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 状态条只做汇总；还没有工单列表、详情视图或跳转到执行会话的入口。
- 它只出现在自身会话记录了 bot 工具的对话中，因为投影是会话级的。
- 文案是固定的三个标签；不逐条显示阶段名称。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

状态条是 `bot` 投影的第一个消费者。名册与注意力服务落地后，应由完整面板取代它。
</details>
