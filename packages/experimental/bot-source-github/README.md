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
    mode: observe
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
| `mode` | `observe` | `observe` records a candidate per new issue and opens nothing; `auto` opens the ticket. |
| `writeBack` | `false` | Comment each finished ticket result on its issue, once. |
| `allowedAuthors` | `[]` | Logins allowed to open work; empty admits everyone. Others are recorded `filtered` and never open a ticket. |
| `maxSeen` | `200` | Handled issue numbers remembered per repository. |

The `gh` CLI must be authenticated on the Host. The source inherits the scrubbed process environment, so `*TOKEN*`, `*KEY*`, `*SECRET*`, and `*PASSWORD*` variables never reach it; `gh` reads its own credential store.

<a id="understand-the-implementation"></a>
## Understand the implementation

- **Cursor and candidates.** A `bot-source-github` domain (version 3) stores one `{ seen: string[] }` record per repository and one candidate record per new issue with a deterministic id. The first poll writes the seed; every later poll compares against it. Versions 1 and 2 load unchanged.
- **Delivery.** Each fresh issue records a candidate. In `auto` mode the source opens one ticket titled `#<number> <title>`, marks the candidate `opened` with the ticket id, and reports as before. In `observe` mode it logs what it would have done and leaves the candidate `would-open`. Issues are handled oldest first, and the cursor advances only after the whole batch is recorded, so a failure retries the batch on the next poll.
- **Admission.** An issue whose author is not in `allowedAuthors` still records a candidate, marked `filtered`, and never opens a ticket in either mode. The check is a case-insensitive login comparison.
- **Write-back.** With `writeBack` on, every poll scans this source's candidates for tickets that reached `ready`, `failed`, or `blocked` and have no comment receipt yet, posts one comment on the issue, and records when it did. A failed comment is logged and retried on the next poll; a delivered one is never repeated.
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
- `observe` advances the cursor and keeps candidates only in the source's storage: there is no review tool or panel yet, and switching to `auto` later does not reopen issues observed earlier.
- Write-back comments once and does not close the issue or reply to review threads; it also needs `gh` write permission on the repository.
- Admission matches author logins only: organization membership, teams, and bot authors need to be listed explicitly.
- The bot must already exist when a poll finds work; a missing bot is logged and retried.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This is the first Source. The plan's trigger layer adds admission rules, observe mode, and a shared policy; this package deliberately implements only the polling and ticket delivery it needs.
</details>
