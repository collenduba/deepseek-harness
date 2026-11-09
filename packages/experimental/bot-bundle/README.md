---
description: "Compose durable bots with router, worker, and reviewer agent presets"
kind: "package-bundle"
---

# @deepseek-ai/dsh-bot-bundle

English | [中文](README.zh.md)

## Summary

Composes `@deepseek-ai/dsh-bot` with three agent presets, the bot status strip, and the GitHub source (disabled until configured). `bot-router` is the conversation that owns bots; `bot-worker` is the unattended composition a ticket runs in; `bot-reviewer` is the unattended composition a pull-request review runs in; `@deepseek-ai/dsh-client-ui-bot` shows the bound bot and its ticket counts above the composer.

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

Start a conversation with the **Bot router** preset, call `bot_create`, then pass `preset: "bot-worker"` to `bot_open_ticket`'s bot, so each ticket's Session mounts the worker composition. Tokens, storage, and worker behavior belong to `dsh-bot`. For pull-request review, create the bot with `preset: "bot-reviewer"` instead: its file tool is read-only, and it also mounts search, shell, working directory, and todo, so a review can inspect a worktree and run checks. Shell can still write, so bind the bot's tool allowlist and the deployment's sandbox policy to the review job.

<a id="presets"></a>
## Presets

| Preset | Use | Tools |
|---|---|---|
| `bot-router` | The conversation that owns bots and receives their reports. | Persona and time context; every globally registered tool remains visible. |
| `bot-worker` | The unattended Session one ticket runs in. | File read/write, search, shell, background jobs, todo, and skills. No tool that asks a person, presents UI, changes the profile, schedules work, or reaches the web. |
| `bot-reviewer` | The unattended Session a pull-request review runs in. | Read-only file tool, search, shell, working directory, and todo. The file tool cannot write, but shell can: write prevention belongs to the bot's tool allowlist and the deployment's sandbox policy. |

The worker preset is deliberately narrow: a worker that holds `ask_user_question` or `present` can block a turn on input that will never arrive.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the [bot package](../bot/README.md), which owns the tool schemas and the worker instruction. This bundle adds a persona line to each preset it declares and selects the tools those presets mount.

#### KV Cache effect

The bundle adds no request content of its own. Selecting `bot-worker` or `bot-reviewer` for a Session establishes a different tool list, which invalidates that Session's cached request prefix once at its first request; the tool list stays fixed afterwards.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Presets are selectable, not enforced: `bot_create` binds whichever Session it runs in, so the router preset is a convention rather than a gate.
- There is no no-wait guard yet; a router can still run a blocking shell command.
- The worker preset omits web, subagent, schedule, and presentation tools by design; add them in a derived preset when a deployment needs them.
- The reviewer preset omits the skill tools on purpose to keep its tool list small, so it cannot load repository review skills; its shell is not read-only, and write prevention belongs to the bot's tool allowlist and the deployment's sandbox policy.
- The GitHub source is inserted disabled: it needs a `bot` and `repository` before it can run, and its `target` selects issues or pull-request revisions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bundle stays a patch-only package. Runtime behavior belongs to `dsh-bot`, which owns the domain, the tools, and worker launch. The preset test parses the patch and asserts rows and configs; whether a plugin accepts those configs is still proven only by loading the composition through the Loader.
</details>
