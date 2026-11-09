/**
 * GitHub issue source for bots: poll open issues and open one ticket per new
 * issue on the configured bot. Polling is the whole model — no webhooks, no
 * write-back to GitHub, and nothing runs while the Host is stopped.
 * @module @deepseek-ai/dsh-bot-source-github
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.bots` Service declaration from the bot package.
import type {} from '@deepseek-ai/dsh-bot'
import z from '@deepseek-ai/schemastery'
import { candidateOf, commentIssue, freshIssues, listIssues, reportComment, ticketInstruction } from './github.ts'
import type { PollOptions } from './github.ts'
import { sourceDomainSpec } from './spec.ts'
import type { CandidateId, SourceCandidate, SourceKey } from './spec.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

/** Deployment configuration for one repository watch. */
export interface Config {
  /** Name of the bot whose tickets this source opens. */
  bot: string
  /** Repository in `owner/name` form. */
  repository: string
  /** `gh` search query selecting the issues to watch. */
  query: string
  /** Seconds between polls. */
  pollSeconds: number
  /** `gh` executable name or absolute path. */
  ghCommand: string
  /** Deadline for one `gh` invocation. */
  timeoutMs: number
  /** What the first poll does with issues that already exist. */
  backlog: 'ignore' | 'open'
  /** Whether a new issue opens a ticket or only records a candidate. */
  mode: 'observe' | 'auto'
  /** Whether a finished ticket comments its result on the issue. */
  writeBack: boolean
  /** How many handled issue numbers one repository remembers. */
  maxSeen: number
}

export const Config: z<Config> = z.object({
  bot: z.string().required().description('Name of the bot that receives the tickets.'),
  repository: z.string().pattern(/^[\w.-]+\/[\w.-]+$/).required().description('Repository to watch, in owner/name form.'),
  query: z.string().default('is:issue is:open').description('gh search query selecting the issues to watch.'),
  pollSeconds: z.natural().min(15).default(60).description('Seconds between polls.'),
  ghCommand: z.string().default('gh').description('gh executable name or absolute path.'),
  timeoutMs: z.natural().min(1_000).default(30_000).description('Deadline for one gh invocation.'),
  backlog: z.union([z.const('ignore'), z.const('open')]).default('ignore')
    .description('ignore marks existing issues as handled; open tickets every open issue on the first poll.'),
  mode: z.union([z.const('observe'), z.const('auto')]).default('observe')
    .description('observe records what it would do without opening tickets; auto opens them.'),
  writeBack: z.boolean().default(false)
    .description('Comment each finished ticket result on its issue.'),
  maxSeen: z.natural().min(1).max(2_000).default(200).description('How many handled issue numbers one repository remembers.'),
})

/** Plugin name. */
export const name = 'bot-source-github'

/** Services the source reads. */
export const inject = ['bots', 'storageDomain']

/**
 * Start the polling loop as an effect of this plugin's fiber.
 * @param ctx - context providing the bot registry and storage.
 * @param config - one repository watch.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes
    // the loop becomes one warning instead of a crash.
    const running = watch(ctx, config, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        ctx.logger.warn(`bot-source-github: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return async () => {
      controller.abort()
      await running
    }
  }, 'bot-source-github.loop')
}

/** Read cancellation through a call so control-flow narrowing cannot pin the flag. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Comment each finished ticket result once, when write-back is on. */
async function publishReports(
  ctx: Context,
  config: Config,
  candidates: KvTable<CandidateId, SourceCandidate>,
  signal: AbortSignal,
): Promise<void> {
  if (!config.writeBack) return
  const bot = ctx.bots.list().find(candidate => candidate.name === config.bot)
  if (bot === undefined) return
  const tickets = new Map(ctx.bots.ticketsOf(bot.id).map(ticket => [String(ticket.id), ticket]))
  for (const [, candidate] of [...candidates.entries()]) {
    if (candidate.ticketId === undefined || candidate.commentedAt !== undefined) continue
    const ticket = tickets.get(candidate.ticketId)
    if (ticket === undefined) continue
    if (ticket.stage !== 'ready' && ticket.stage !== 'failed' && ticket.stage !== 'blocked') continue
    try {
      await commentIssue(pollOptions(config), candidate.number, reportComment(bot.name, ticket), signal)
      await candidates.put(candidate.id, { ...candidate, commentedAt: new Date().toISOString() })
    } catch (error: unknown) {
      if (signal.aborted) return
      ctx.logger.warn(`bot-source-github: comment for #${candidate.number} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Poll options derived from config. */
function pollOptions(config: Config): PollOptions {
  return {
    repository: config.repository,
    query: config.query,
    ghCommand: config.ghCommand,
    timeoutMs: config.timeoutMs,
  }
}

/**
 * Seed the cursor, then poll forever and open one ticket per new issue.
 * @param ctx - context providing the bot registry and storage.
 * @param config - one repository watch.
 * @param signal - effect cancellation.
 */
async function watch(ctx: Context, config: Config, signal: AbortSignal): Promise<void> {
  const domain = await ctx.storageDomain.open(sourceDomainSpec)
  try {
    const cursors = domain.table('cursors')
    const candidates = domain.table('candidates')
    const key = config.repository as SourceKey
    if (cursors.get(key) === undefined) {
      const existing = await listIssues(pollOptions(config), signal)
      const seed = config.backlog === 'open' ? [] : existing.map(issue => String(issue.number))
      await cursors.put(key, { seen: seed.slice(0, config.maxSeen) })
    }
    while (!isAborted(signal)) {
      try {
        const issues = await listIssues(pollOptions(config), signal)
        const current = cursors.get(key) ?? { seen: [] }
        const fresh = freshIssues(current.seen, issues)
        if (fresh.length > 0) {
          const bot = config.mode === 'auto'
            ? ctx.bots.list().find(candidate => candidate.name === config.bot)
            : undefined
          if (config.mode === 'auto' && bot === undefined) throw new Error(`no bot named '${config.bot}'`)
          for (const issue of fresh) {
            const candidate = candidateOf(config.repository, issue, new Date().toISOString())
            await candidates.put(candidate.id, candidate)
            if (bot === undefined) {
              ctx.logger.info(`bot-source-github: observe only, would open a ticket for #${issue.number}`)
              continue
            }
            const ticket = await ctx.bots.openTicket({
              routerSession: bot.routerSession,
              title: `#${issue.number} ${issue.title}`,
              instruction: ticketInstruction(config.repository, issue),
            })
            await candidates.put(candidate.id, { ...candidate, state: 'opened', ticketId: ticket.id })
          }
          const handled = fresh.map(issue => String(issue.number)).reverse()
          await cursors.put(key, { seen: [...handled, ...current.seen].slice(0, config.maxSeen) })
        }
        await publishReports(ctx, config, candidates, signal)
      } catch (error: unknown) {
        if (isAborted(signal)) break
        ctx.logger.warn(`bot-source-github: poll failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      await delay(config.pollSeconds * 1000, undefined, { signal }).catch(() => {})
    }
  } finally {
    await domain.close()
  }
}
