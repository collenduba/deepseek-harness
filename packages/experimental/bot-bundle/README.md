---
description: "Compose durable bots with router and worker agent presets"
kind: "package-bundle"
---

# @deepseek-ai/dsh-bot-bundle

English | [中文](README.zh.md)

## Summary

Composes `@deepseek-ai/dsh-bot` with two agent presets and the bot status strip. `bot-router` is the conversation that owns bots; `bot-worker` is the unattended composition a ticket runs in; `@deepseek-ai/dsh-client-ui-bot` shows the bound bot and its ticket counts above the composer.

## Table of Contents

- [Use this package](#use-this-package)
- [Presets](#presets)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Install the bundle into a profile through the Plugins page or the CLI:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-bot-bundle
```

Start a conversation with the **Bot router** preset, call `bot_create`, then pass `preset: "bot-worker"` to `bot_open_ticket`'s bot, so each ticket's Session mounts the worker composition. Tokens, storage, and worker behavior belong to `dsh-bot`.

<a id="presets"></a>
## Presets

| Preset | Use | Tools |
|---|---|---|
| `bot-router` | The conversation that owns bots and receives their reports. | Persona and time context; every globally registered tool remains visible. |
| `bot-worker` | The unattended Session one ticket runs in. | File read/write, search, shell, background jobs, todo, and skills. No tool that asks a person, presents UI, changes the profile, schedules work, or reaches the web. |

The worker preset is deliberately narrow: a worker that holds `ask_user_question` or `present` can block a turn on input that will never arrive.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [bot package](../bot/README.md), which owns the tool schemas and the worker instruction. This bundle adds a persona line to each preset it declares and selects the tools those presets mount.

#### KV Cache effect

The bundle adds no request content of its own. Selecting `bot-worker` for a Session establishes a different tool list, which invalidates that Session's cached request prefix once at its first request; the tool list stays fixed afterwards.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Presets are selectable, not enforced: `bot_create` binds whichever Session it runs in, so the router preset is a convention rather than a gate.
- There is no no-wait guard yet; a router can still run a blocking shell command.
- The worker preset omits web, subagent, schedule, and presentation tools by design; add them in a derived preset when a deployment needs them.
- The status strip is a summary only; it does not list tickets or open a worker Session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle stays a patch-only package. Runtime behavior belongs to `dsh-bot`, which owns the domain, the tools, and worker launch.
</details>
