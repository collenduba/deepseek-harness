---
description: "Bot status strip above the composer, read from the bot session projection"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-bot

English | [中文](README.zh.md)

## Summary

Adds one line above the composer naming the bot bound to the current conversation, its ticket count, and how many tickets need a person. The browser half registers a `conversation.input.dock` entry and reads `useProjection('bot')`; a conversation with no bot renders nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the plugin with `@deepseek-ai/dsh-bot` in the same profile. The paired bundle `@deepseek-ai/dsh-bot-bundle` already inserts both rows, so installing that bundle is the supported path.

Start a conversation, call `bot_create`, then `bot_open_ticket`. The strip appears as soon as the `bot` projection holds a bot, and the "Need you" count rises when a ticket reaches `waiting`, `ready`, `blocked`, or `failed`.

<a id="understand-the-implementation"></a>
## Understand the implementation

- Registration: one `conversation.input.dock` entry with id `bot` and order 9.
- Data: `useProjection('bot')`, the client view `@deepseek-ai/dsh-bot` registers. The component never calls the Host and holds no state.
- Copy: the `bot` locale namespace in eight languages, registered as a plugin effect.
- Rendering: a bot name, the ticket count, and the count of tickets that wait for a person. Stages come from the projection, so the strip follows reports without a reload.

<a id="model-experience"></a>
## Model Experience

None, as this package renders the bot projection for a human and registers no tool, prompt, message, schema, stream, or model input. The bot tools and their model-visible text stay with [`dsh-bot`](../../experimental/bot/README.md).

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The strip summarizes tickets; there is no ticket list, detail view, or link to a worker Session yet.
- It only appears in a conversation whose own Session recorded the bot tools, because the projection is Session-scoped.
- Copy is a fixed three-label strip; stage names are not shown per ticket.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The strip is the first consumer of the `bot` projection. A full panel should replace it once the roster and attention services exist.
</details>
