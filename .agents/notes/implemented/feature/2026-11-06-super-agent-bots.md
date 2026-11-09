# Agent Note: Super-agent bots on DeepSeek Harness

Status: implemented

English | [中文](2026-11-06-super-agent-bots.zh.md)

## Problem

The harness runs one root Agent per conversation. A person opens a Session, prompts, reviews the result, and the work stops when the conversation does. There is no durable identity that owns routines, no authorized unit of unattended work, no attention budget, and no per-bot policy.

Comparable products converged on that layer — named teammates, routines, approvals, and attention states — and DeepSeek's own [Super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) shows the shape on this harness. The work below brings that shape to the repository as ordinary plugins.

## Decision

### Records

A bot is a durable record, not a Session. One `bot` storage domain holds five tables:

| Table | Holds |
|---|---|
| `bots` | name, job, workspace, router Session, optional worker preset, tool allowlist, and hard-floor actions, status |
| `tickets` | title, instruction, stage, router Session, worker Session, summary, parent ticket and bot for handoffs |
| `memories` | per-bot notes, with the ticket whose worker wrote each one |
| `approvals` | action, exact payload, SHA-256 digest, status, decision note |
| `notices` | router notices with their delivery time |

The domain moved through versions 1–10 as tables and optional fields were added; every version loads the ones before it.

### Sessions

The Session that calls `bot_create` becomes the bot's router. Each ticket gets its own root Session through `ctx.agents.create`: the bot's workspace, an optional agent preset, a title of `<bot>: <ticket>`, and one instruction message. The worker is not a subagent, so it survives its creator and appears in the sidebar. A worker that calls `bot_report` is validated against the ticket's recorded worker Session; the report updates the ticket and reaches the router as a structured notice. A bot runs at most `maxWorkersPerBot` workers at once (default 2): further tickets wait in `queued`, and a terminal report starts the oldest. A handoff chain is refused past `maxHandoffDepth` (default 3).

### Tools

| Tool | Caller | Effect |
|---|---|---|
| `bot_create` | any Session | Binds the conversation as a bot's router, with an optional preset, tool allowlist, and hard-floor actions. |
| `bot_list` | any | Bots and open ticket counts. |
| `bot_open_ticket` | router | Opens a ticket and launches its worker. |
| `bot_report` | worker | Records `waiting`, `ready`, `blocked`, or `failed` with a summary. |
| `bot_remember` | router or worker | Writes one durable note that later workers read. |
| `bot_handoff` | worker | Opens a ticket on another active bot and records the source. |
| `bot_request_approval` | worker | Stores the exact payload with its digest and notifies the router. |
| `bot_decide_approval` | router | Decides a pending request once and wakes the worker. |
| `bot_archive` | any | Removes a bot with its tickets, notes, approvals, and notices. |

### Authorization and approvals

Approvals bind a decision to one payload and its digest. The protocol is advisory by default; with `enforceApprovals` on, a `tools/pre-execute` hook denies guarded shell tools in ticket workers unless an approved request for that ticket carries the exact command. The gate covers the `command` argument of the guarded tools only. A bot may also name a tool allowlist, which the same gate enforces for its tickets while always keeping the reporting tools; a hard floor of actions that are refused at request time and cannot be approved later; and blocked shell command patterns, which deny a matching guarded shell command whatever its approval state.

### Attention and memory

`notices` make router messages durable and carry a severity: blockers interrupt, results are digest-class. Quiet hours hold everything; with `holdResults` on, result notices also wait outside quiet hours until the digest timer sends one message per conversation and marks each notice delivered, so a restart never repeats one. Memory notes are prepended to each new worker instruction under "Known context for this bot".

### Sources

`@deepseek-ai/dsh-bot-source-github` polls one repository through `gh`. With `target: pull-requests` it watches each pull-request head revision instead of issues: one candidate per `number@head`, drafts skipped, and one review ticket per revision. Every new issue records a candidate; `observe` only logs and `auto` opens a ticket. An author allowlist filters candidates, write-back comments each finished result once, and `bot_candidates` / `bot_accept_candidate` review and promote candidates. The poll loop takes its list and comment effects as arguments, so tests drive observe, auto, admission, and write-back against real storage without a `gh` process; `autostart: false` mounts the tools without polling.

### Panel

The `bot` Session projection folds the logged tool calls, results, and notices into `{ bot, tickets }`. `@deepseek-ai/dsh-client-ui-bot` renders it in a composer dock strip: bot name, ticket count, needs-you count, and up to five ticket rows ordered by stage. A row with a worker Session opens it through `ctx.uiWorkspace`.

### Packages and presets

| Package | Role |
|---|---|
| `dsh-bot` | Records, tools, worker launch, approvals, attention, memory, handoffs |
| `dsh-bot-source-github` | Issue polling, candidates, admission, write-back |
| `dsh-client-ui-bot` | Composer strip over the projection |
| `dsh-bot-bundle` | `bot-router`, `bot-worker`, and `bot-reviewer` presets, panel row, disabled source row |

## Alternatives considered

**Extend the automation-task proposal instead of a new layer.** A task could grow tickets, workers, and approvals. It lost because a task record is a user-authored rule about when to look, while a bot is an identity with grants and memory that outlives any rule.

**One Session per bot, no router and worker split.** Fewer moving parts, and the conversation already holds context. It lost because unattended work over a long conversation reads an expired cache each turn, a blocked step delays every incoming candidate, and one compromised input would run with the conversation's full history and permissions.

**Use subagents as workers.** They already have durable sessions and names. It lost for ticket work: a subagent tree belongs to one parent and is bounded by `maxActiveSubagents`, whereas a ticket must survive its creator, be reopenable, and appear in the sidebar as its own root Session.

**One DSH profile per bot.** Total isolation without new code. It lost because bots must share the person's workspace, credentials, and panel, and every handoff would cross a process boundary.

**A separate advisor model for every approval.** Stronger than a prompt, but it lost to a deterministic payload comparison first; the advisory protocol plus the shell gate covers the risk that exists today, and an independent reviewer remains deferred.

**A panel that only counts.** Simpler and quieter. It lost because a person could not see what the bot was doing; the strip now lists up to five rows.

## Deferred

- Approval tiers by reversibility and data sensitivity beyond the binary hard floor.
- Per-user quiet hours and a digest schedule beyond one interval.
- A roster page across bots, and a detail page per ticket.
- A Loader-booted fixture; the composition test mounts the real service graph without the Loader.
- Source polling continues only while the Host runs, and only issues are watched.

## Consequences

- Bots are auditable: every ticket names its mandate's origin, its worker, and its outcome; every approval names the digest it decided.
- Unattended work is bounded: quiet hours, an author allowlist, observe-before-auto, and a shell gate that refuses unapproved commands.
- The storage domain carries ten format versions. Each addition is compatible, but the schema and its migration surface grow with every feature.
- Approvals are only enforced for guarded shell tools; other consequential actions still depend on the worker following the protocol.
- Tool allowlists deny at call time, so the model still sees denied tools in its catalog and learns the restriction from the denial.
- Source behaviour is polling only and stops with the Host, so a bot is not a hosted service.
- The panel shows work and can open a worker Session, but it has no detail page and no cross-bot roster.
- Queued tickets have no worker Session until a slot frees; a person's message does not get an extra slot.
