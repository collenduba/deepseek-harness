---
description: "Poll GitHub issues and open bot tickets for new ones"
kind: "package-reference"
---

# @deepseek-ai/dsh-bot-source-github

English | [中文](README.zh.md)

## Summary

Watches one GitHub repository through the `gh` CLI and opens one bot ticket per new open issue. The configured bot's worker Session receives the issue title, URL, and body as its instruction, and reports back in the bot's conversation. Polling is the whole model: nothing runs while the Host is stopped, and there is no write-back to GitHub.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the plugin with a bot and a repository. The shipped `@deepseek-ai/dsh-bot-bundle` already inserts the row, disabled; enable it with your own config:

```yaml
- id: bot-source-github
  disabled: false
  config:
    bot: reviewer
    repository: owner/name
    query: 'is:issue is:open'
    pollSeconds: 60
```

| Field | Default | Meaning |
|---|---|---|
| `bot` | required | Name of the bot whose tickets this source opens. |
| `repository` | required | Repository in `owner/name` form. |
| `query` | `is:issue is:open` | `gh` search query selecting the issues to watch. |
| `pollSeconds` | `60` | Seconds between polls; at least 15. |
| `ghCommand` | `gh` | Executable name or absolute path. |
| `timeoutMs` | `30000` | Deadline for one `gh` invocation. |
| `backlog` | `ignore` | `ignore` marks existing issues handled at startup; `open` tickets every open issue on the first poll. |
| `maxSeen` | `200` | Handled issue numbers remembered per repository. |

The `gh` CLI must be authenticated on the Host. The source inherits the scrubbed process environment, so `*TOKEN*`, `*KEY*`, `*SECRET*`, and `*PASSWORD*` variables never reach it; `gh` reads its own credential store.

<a id="understand-the-implementation"></a>
## Understand the implementation

- **Cursor.** A `bot-source-github` domain (version 1) stores one `{ seen: string[] }` record per repository, newest number first, bounded by `maxSeen`. The first poll writes the seed; every later poll compares against it.
- **Delivery.** Each fresh issue opens one ticket titled `#<number> <title>` with a deterministic instruction. Issues are handled oldest first, and the cursor advances only after every ticket in the batch opened, so a failure retries the batch on the next poll.
- **Failures.** A failed `gh` call or a missing bot is logged and retried at the next interval; the loop never exits the plugin fiber, and disposal aborts the in-flight poll and waits for the loop.
- **No deduplication beyond the cursor.** An issue number seen once is never opened again, even if its content changes.

<a id="model-experience"></a>
## Model Experience

### Ticket instructions

#### What the model sees

One user message per new issue, built by `ticketInstruction` as `Work on <repository> issue #<number>: <title>`, a blank line, the issue URL, a blank line, and the issue body — or `(no description)` when the body is empty. The worker also receives the bot package's standard worker preamble, which names the ticket id and asks for `bot_report`.

#### Token effect

One instruction message per issue in that worker Session. The issue body is unbounded: a very large body becomes a very large instruction.

#### KV Cache effect

Each ticket starts a new Session, so the instruction establishes that Session's request prefix rather than replacing one. The source adds no request content to any other Session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Polling only: no webhooks, no comments, no pull requests, and no reactions.
- No write-back to GitHub — the worker reports in the bot's conversation, and nobody comments on the issue unless a later Source adds it.
- Issue edits do not re-open a ticket; only unseen numbers do.
- The cursor is per repository, so running two configs for one repository shares state only if they use the same bot and query.
- The bot must already exist when a poll finds work; a missing bot is logged and retried.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This is the first Source. The plan's trigger layer adds admission rules, observe mode, and a shared policy; this package deliberately implements only the polling and ticket delivery it needs.
</details>
