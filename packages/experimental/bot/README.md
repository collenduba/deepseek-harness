---
description: "Durable bots that open tickets and run worker Sessions"
kind: "package-reference"
---

# @deepseek-ai/dsh-bot

English | [中文](README.zh.md)

## Summary

`dsh-bot` adds durable bots to a Host composition. A bot is a storage-domain record bound to the Session that created it, not a Session itself. Four model tools drive it: `bot_create` binds the conversation, `bot_open_ticket` opens a unit of work, a separate worker Session executes the instruction, and `bot_report` records the outcome and steers it back to the bot's router Session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the plugin where `storageDomain`, `tools`, `agents`, `agentDefaultModel`, `sessionTitle`, and `workspaceRegistry` are available:

```yaml
- name: '@deepseek-ai/dsh-bot'
```

A conversation then drives one bot:

| Tool | Use |
|---|---|
| `bot_create` | Bind the current Session as the bot's router and store its name, job, and workspace. |
| `bot_list` | List every bot in the deployment with its open ticket count. |
| `bot_open_ticket` | Give the bot one concrete instruction; a worker Session runs it. |
| `bot_report` | Called only by the ticket's worker: record `ready`, `waiting`, `blocked`, or `failed` and one summary line. |
| `bot_remember` | Keep one durable note for the bot; every later worker reads it. |
| `bot_request_approval` | Worker-only: ask the bot's conversation to approve one action, bound to the exact payload. |
| `bot_decide_approval` | Router-only: approve or deny a pending request; the worker is told the outcome. |
| `bot_handoff` | Worker-only: hand one unit of work to another active bot, linked to the source ticket. |
| `bot_archive` | Remove a bot, its tickets, and its notes; worker Sessions and their directories stay. |

<a id="understand-the-implementation"></a>
## Understand the implementation

The service opens one `bot` domain, version 5, with five tables. Versions 1 through 4 load unchanged.

| Table | Key | Holds |
|---|---|---|
| `bots` | `BotId` | name, job, workspace, router Session, optional worker preset, status, timestamps |
| `tickets` | `TicketId` | title, instruction, stage, router Session, worker Session, summary, timestamps |
| `memories` | `BotMemoryId` | bot, text, creation time, and the ticket whose worker wrote it |
| `approvals` | `BotApprovalId` | bot, ticket, action, exact payload, SHA-256 digest, status, decision note |
| `notices` | `BotNoticeId` | bot, ticket, conversation, text, summary, creation and delivery times |

A ticket moves `queued` → `working` → `waiting` or `ready`, or to `blocked` and `failed`. A launch failure keeps the ticket and marks it `failed` with the error message, so the panel can show what happened instead of losing the request.

`bot_open_ticket` creates the worker through `ctx.agents.create` as an ordinary root Session: it receives the bot's workspace as its working directory, is attached to that workspace, is titled `<bot>: <ticket>`, and receives one instruction message. The worker is not a subagent; it survives its creator and appears in the sidebar. When it calls `bot_report`, the service validates that the caller is the ticket's worker Session, writes the stage and summary, and sends one notice to the router Session when that Session is live. A worker's instruction also carries the bot's notes, newest first, under "Known context for this bot". A worker that needs a decision calls `bot_request_approval`, which stores the exact payload with its SHA-256 digest and notifies the conversation; `bot_decide_approval` records the decision against that payload and sends the outcome back to the worker Session. This is an advisory gate: the worker is asked to wait, and nothing in the tool pipeline prevents it from acting first. A worker can also call `bot_handoff`, which opens a ticket on another active bot, records `parentTicket` and `parentBotName` on it, and tells the new worker which ticket handed the work off.

<a id="model-experience"></a>
## Model Experience

### Bot tools

#### What the model sees

The four tools are declared together on `ctx.tools`: `bot_create` takes `name`, `job`, `workspace`, and an optional `preset`; `bot_list` takes no parameters; `bot_open_ticket` takes `title` and `instruction`; `bot_report` takes `ticket_id`, a `stage` from `waiting`, `ready`, `blocked`, and `failed`, and a one-line `summary`. Each result is a small JSON object the model can read without parsing prose.

#### Token effect

Four schemas per Agent that mounts the plugin, plus one short result line per call. Worker instructions are one user message per ticket and stay in that worker's history.

#### KV Cache effect

The schemas are static for the mount lifetime. A ticket result appends to its conversation without rewriting the prompt prefix; a worker instruction starts a new Session and establishes its own prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Notes are unbounded plain text: the instruction grows with every note, and there is no forgetting policy yet.
- Approvals are advisory, not enforced: a worker that ignores the protocol can act without one. Enforcement belongs to a tool gate in a later phase.
- A decision reaches the worker only while its Session is live; otherwise the record is decided and the worker finds out on its next turn.
- Quiet hours follow the Host's local clock; there is no per-user time zone, and nothing is delivered while the Host is stopped.
- A digest is one message per conversation per interval; there is no severity ranking or per-bot cap yet.
- A handoff target is resolved by name among active bots and must be unique; a target that is paused or duplicated is refused.
- Handoffs block only the same-bot case, so A → B → A chains are possible and no depth limit exists yet.
- Event sources, observe and auto modes, approval records, memory, and capability grants are not implemented.
- One worker runs per ticket with no concurrency limit or slot accounting.
- A report reaches the router only while that Session is live; otherwise the ticket keeps the stage and summary.
- A named `preset` must exist in the composition; a missing agent-preset registry fails the launch with an explicit error.
- The generated tool catalog mounts this package with a stub storage domain, so the catalog documents the schemas but not the records the tools write.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The first slice intentionally keeps the service and its tools in one package. Split a worker or executor package when a second consumer needs it.
</details>
