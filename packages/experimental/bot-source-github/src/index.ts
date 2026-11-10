/**
 * GitHub issue source for bots: poll open issues and open one ticket per new
 * issue on the configured bot. Polling is the whole model — no webhooks, no
 * write-back to GitHub, and nothing runs while the Host is stopped.
 * @module @deepseek-ai/dsh-bot-source-github
 */

import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.bots` Service declaration from the bot package.
import type { BotId, TicketStage } from '@deepseek-ai/dsh-bot'
import z from '@deepseek-ai/schemastery'
import {
  admitted, candidateOf, commentIssue, freshIssues, freshPullRequests, listIssues, listPullRequests,
  labelPullRequest, prepareReviewWorktree, pullRequestCandidateOf, pullRequestInstruction,
  pullRequestChecksPass, removeLabel, removeReviewWorktree, reportComment, ticketInstruction,
} from './github.ts'
import type { GithubIssue, GithubPullRequest } from './github.ts'
import type { PollOptions } from './github.ts'
import { sourceDomainSpec } from './spec.ts'
import type { CandidateId, SourceCandidate, SourceCursor, SourceKey } from './spec.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'

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
  /** Deadline for one `gh` or `git` invocation. */
  timeoutMs: number
  /** What the first poll does with issues that already exist. */
  backlog: 'ignore' | 'open'
  /** Whether a new issue opens a ticket or only records a candidate. */
  mode: 'observe' | 'auto'
  /** Whether a finished ticket comments its result on the issue. */
  writeBack: boolean
  /** Logins allowed to open work; empty admits everyone. */
  allowedAuthors: string[]
  /** Start the poll loop on mount; disable to drive `runSource` yourself. */
  autostart: boolean
  /** Create an isolated git worktree per pull-request revision. */
  worktrees: boolean
  /** Parent directory for review worktrees; empty uses a sibling `.dsh-worktrees` of the bot workspace. */
  worktreeRoot: string
  /** Merge-gate action: off, or label the pull request. */
  gate: 'off' | 'label'
  /** Label added when the review passed and checks are green. */
  gateLabel: string
  /** Label added when the review found a blocker. */
  gateFailLabel: string
  /** What to watch: open issues, or open pull-request revisions. */
  target: 'issues' | 'pull-requests'
  /** Review draft pull requests too. */
  includeDrafts: boolean
  /** How many handled issue numbers one repository remembers. */
  maxSeen: number
}

export const Config: z<Config> = z.object({
  bot: z.string().required().description('Name of the bot that receives the tickets.'),
  repository: z.string().pattern(/^[\w.-]+\/[\w.-]+$/).required().description('Repository to watch, in owner/name form.'),
  query: z.string().default('').description('gh search query; empty lists every open issue or pull request.'),
  pollSeconds: z.natural().min(15).default(60).description('Seconds between polls.'),
  ghCommand: z.string().default('gh').description('gh executable name or absolute path.'),
  timeoutMs: z.natural().min(1_000).default(30_000).description('Deadline for one gh or git invocation.'),
  backlog: z.union([z.const('ignore'), z.const('open')]).default('ignore')
    .description('ignore marks existing issues as handled; open tickets every open issue on the first poll.'),
  mode: z.union([z.const('observe'), z.const('auto')]).default('observe')
    .description('observe records what it would do without opening tickets; auto opens them.'),
  writeBack: z.boolean().default(false)
    .description('Comment each finished ticket result on its issue.'),
  allowedAuthors: z.array(z.string()).default([])
    .description('Logins allowed to open work through this source; empty admits everyone.'),
  autostart: z.boolean().default(true)
    .description('Start the poll loop on mount; disable to drive runSource yourself.'),
  worktrees: z.boolean().default(false)
    .description('Create an isolated git worktree per pull-request revision and pass it to the ticket.'),
  worktreeRoot: z.string().default('')
    .description('Parent directory for review worktrees; empty uses a sibling .dsh-worktrees of the bot workspace.'),
  target: z.union([z.const('issues'), z.const('pull-requests')]).default('issues')
    .description('Watch open issues or open pull-request revisions.'),
  gate: z.union([z.const('off'), z.const('label')]).default('off')
    .description('Label a reviewed pull request with gateLabel when its verdict passed and checks are green, or gateFailLabel when it failed.'),
  gateLabel: z.string().default('merge-ready')
    .description('Label added when the review passed and checks are green.'),
  gateFailLabel: z.string().default('needs-work')
    .description('Label added when the review found a blocker.'),
  includeDrafts: z.boolean().default(false)
    .description('Review draft pull requests too.'),
  maxSeen: z.natural().min(1).max(2_000).default(200).description('How many handled issue numbers one repository remembers.'),
})

/** Plugin name. */
export const name = 'bot-source-github'

/** Services the source reads. */
export const inject = ['bots', 'storageDomain', 'tools']

/**
 * Open the source domain, start the polling loop, and register the review
 * tools as effects of this plugin's fiber.
 * @param ctx - context providing the bot registry, storage, and tools.
 * @param config - one repository watch.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.worktreeRoot !== '' && !isAbsolute(config.worktreeRoot)) {
    throw new Error(`worktreeRoot must be an absolute path: ${config.worktreeRoot}`)
  }
  if (config.worktrees && config.target !== 'pull-requests') {
    throw new Error('worktrees require target: pull-requests')
  }
  const domain = await ctx.storageDomain.open(sourceDomainSpec)
  ctx.effect(() => () => domain.close(), 'bot-source-github.domainClose')
  const state: SourceState = {
    cursors: domain.table('cursors'),
    candidates: domain.table('candidates'),
  }
  if (!config.autostart) {
    registerTools(ctx, config, state)
    return
  }
  ctx.effect(() => {
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes
    // the loop becomes one warning instead of a crash.
    const running = runSource(ctx, config, controller.signal, realDeps(config), state).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        ctx.logger.warn(`bot-source-github: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return async () => {
      controller.abort()
      await running
    }
  }, 'bot-source-github.loop')
  registerTools(ctx, config, state)
}

/** Open tables the loop and the tools share. */
export interface SourceState {
  /** Per-repository handled issue numbers. */
  readonly cursors: KvTable<SourceKey, SourceCursor>
  /** Candidates the source considered. */
  readonly candidates: KvTable<CandidateId, SourceCandidate>
}

/**
 * Candidates for one repository, newest issue first.
 * @param state - the source tables.
 * @param repository - `owner/name` filter.
 * @param wanted - optional state filter.
 * @param limit - maximum rows.
 * @returns the matching candidates.
 */
export function candidatesFor(
  state: SourceState,
  repository: string,
  wanted?: SourceCandidate['state'],
  limit = 20,
): SourceCandidate[] {
  return [...state.candidates.entries()]
    .map(([, candidate]) => candidate)
    .filter(candidate => candidate.repository === repository && (wanted === undefined || candidate.state === wanted))
    .sort((left, right) => right.number - left.number)
    .slice(0, limit)
}

/**
 * Promote one `would-open` candidate into a ticket on the configured bot.
 * @param ctx - context providing the bot registry.
 * @param config - one repository watch.
 * @param state - the source tables.
 * @param number - issue number of the candidate.
 * @returns the new ticket id and issue number.
 */
export async function acceptCandidate(
  ctx: Context,
  config: Config,
  state: SourceState,
  number: number,
): Promise<{ ticketId: string; number: number }> {
  const id = brandString<CandidateId>(`candidate-${config.repository}-${number}`)
  const candidate = state.candidates.get(id)
  if (candidate === undefined) throw new Error(`unknown candidate #${number}`)
  if (candidate.state !== 'would-open') throw new Error(`candidate #${number} is ${candidate.state}`)
  const bots = ctx.bots.list().filter(bot => bot.name === config.bot && bot.status === 'active')
  const [bot] = bots
  if (bot === undefined) throw new Error(`no active bot named '${config.bot}'`)
  if (bots.length > 1) throw new Error(`more than one active bot is named '${config.bot}'`)
  const ticket = await ctx.bots.openTicket({
    routerSession: bot.routerSession,
    title: `#${candidate.number} ${candidate.title}`,
    instruction: ticketInstruction(config.repository, candidate),
  })
  await state.candidates.put(id, { ...candidate, state: 'opened', ticketId: ticket.id })
  return { ticketId: ticket.id, number: candidate.number }
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
  deps: SourceDeps,
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
      await deps.comment(candidate.number, reportComment(bot.name, ticket), signal)
      await candidates.put(candidate.id, { ...candidate, commentedAt: deps.now().toISOString() })
    } catch (error: unknown) {
      if (signal.aborted) return
      ctx.logger.warn(`bot-source-github: comment for #${candidate.number} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** The two external effects one poll needs, so a test can run the loop without `gh`. */
export interface SourceDeps {
  /** List the open issues the query selects. */
  list(signal: AbortSignal): Promise<GithubIssue[]>
  /** List the open pull requests the query selects; required for the pull-request target. */
  listPullRequests?(signal: AbortSignal): Promise<GithubPullRequest[]>
  /** Fetch one revision into an isolated worktree and return its path. */
  prepareWorktree?(input: {
    readonly repository: string
    readonly repoPath: string
    readonly root: string
    readonly pullRequest: GithubPullRequest
    readonly signal: AbortSignal
  }): Promise<string>
  /** Add one label to a pull request. */
  addLabel?(input: { readonly number: number; readonly label: string; readonly signal: AbortSignal }): Promise<void>
  /** Whether every reported check on a pull request passed. */
  checksPass?(input: { readonly number: number; readonly signal: AbortSignal }): Promise<boolean>
  /** Remove one label from a pull request; a missing label is not an error. */
  removeLabel?(input: { readonly number: number; readonly label: string; readonly signal: AbortSignal }): Promise<void>
  /** Remove one review worktree. */
  removeWorktree?(input: {
    readonly repository: string
    readonly repoPath: string
    readonly path: string
    readonly ref: string
    readonly signal: AbortSignal
  }): Promise<void>
  /** Comment one result on an issue. */
  comment(issueNumber: number, body: string, signal: AbortSignal): Promise<void>
  /** Current time, fixed by a test. */
  now(): Date
}

/** Build the real dependencies from one deployment config. */
function realDeps(config: Config): SourceDeps {
  const options = pollOptions(config)
  return {
    list: signal => listIssues(options, signal),
    listPullRequests: signal => listPullRequests(options, config.includeDrafts, signal),
    prepareWorktree: input => prepareReviewWorktree(options, input),
    addLabel: input => labelPullRequest(options, input.number, input.label, input.signal),
    checksPass: input => pullRequestChecksPass(options, input.number, input.signal),
    removeLabel: input => removeLabel(options, input.number, input.label, input.signal),
    removeWorktree: input => removeReviewWorktree(options, input),
    comment: (issueNumber, body, signal) => commentIssue(options, issueNumber, body, signal),
    now: () => new Date(),
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
/**
 * Run the poll loop until the signal aborts.
 * @param ctx - context providing the bot registry.
 * @param config - one repository watch.
 * @param signal - cancellation.
 * @param deps - the list and comment effects, injectable for tests.
 * @param state - the source tables, opened by the caller.
 */
export async function runSource(
  ctx: Context,
  config: Config,
  signal: AbortSignal,
  deps: SourceDeps,
  state: SourceState,
): Promise<void> {
  const { cursors, candidates } = state
  const key = config.repository as SourceKey
  const pullLister = deps.listPullRequests?.bind(deps)
  if (config.target === 'pull-requests' && pullLister === undefined) {
    throw new Error('the pull-request target needs a pull-request lister')
  }
  if (cursors.get(key) === undefined) {
    const seed = config.backlog === 'open'
      ? []
      : pullLister === undefined
        ? (await deps.list(signal)).map(issue => String(issue.number))
        : (await pullLister(signal)).map(pullRequest => `${pullRequest.number}@${pullRequest.headRefOid}`)
    await cursors.put(key, { seen: seed.slice(0, config.maxSeen) })
  }
  const sweepBot = ctx.bots.list().find(candidate => candidate.name === config.bot)
  const sweepRemove = deps.removeWorktree?.bind(deps)
  if (sweepBot !== undefined && sweepRemove !== undefined) {
    await cleanWorktrees(ctx, config, deps, candidates, sweepBot, sweepRemove, signal)
  }
  while (!isAborted(signal)) {
    try {
      if (pullLister !== undefined) {
        const pullRequests = await pullLister(signal)
        const current = cursors.get(key) ?? { seen: [] }
        const fresh = freshPullRequests(current.seen, pullRequests)
        const bot = config.mode === 'auto'
          ? ctx.bots.list().find(candidate => candidate.name === config.bot)
          : undefined
        if (config.mode === 'auto' && bot === undefined) throw new Error(`no bot named '${config.bot}'`)
        const prepare = config.worktrees ? deps.prepareWorktree?.bind(deps) : undefined
        const remove = deps.removeWorktree?.bind(deps)
        if (fresh.length > 0) {
          const failed = new Set<number>()
          for (const pullRequest of fresh) {
            try {
              const candidate = pullRequestCandidateOf(config.repository, pullRequest, deps.now().toISOString())
              if (!admitted(pullRequest.author.login, config.allowedAuthors)) {
                await candidates.put(candidate.id, { ...candidate, state: 'filtered' })
                ctx.logger.info(`bot-source-github: PR #${pullRequest.number} is from an author outside the allowlist`)
                continue
              }
              await candidates.put(candidate.id, candidate)
              if (bot === undefined) {
                ctx.logger.info(`bot-source-github: observe only, would review PR #${pullRequest.number} at ${pullRequest.headRefOid}`)
                continue
              }
              let workspace: string | undefined
              if (prepare !== undefined) {
                const root = config.worktreeRoot !== ''
                  ? config.worktreeRoot
                  : join(bot.workspace, '..', '.dsh-worktrees')
                workspace = await prepare({ repository: config.repository, repoPath: bot.workspace, root, pullRequest, signal })
              }
              const ticket = await ctx.bots.openTicket({
                routerSession: bot.routerSession,
                title: `Review #${pullRequest.number} ${pullRequest.title}`,
                instruction: pullRequestInstruction(config.repository, pullRequest, workspace),
                ...(workspace === undefined ? {} : { workspace }),
              })
              await candidates.put(candidate.id, {
                ...candidate,
                state: 'opened',
                ticketId: ticket.id,
                ...(workspace === undefined ? {} : { worktree: workspace }),
              })
            } catch (error: unknown) {
              failed.add(pullRequest.number)
              ctx.logger.warn(`bot-source-github: PR #${pullRequest.number} was not prepared: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const handled = fresh.filter(pullRequest => !failed.has(pullRequest.number))
            .map(pullRequest => `${pullRequest.number}@${pullRequest.headRefOid}`).reverse()
          await cursors.put(key, { seen: [...handled, ...current.seen].slice(0, config.maxSeen) })
        }
        if (bot !== undefined && remove !== undefined) {
          await cleanWorktrees(ctx, config, deps, candidates, bot, remove, signal)
        }
        if (config.gate === 'label' && bot !== undefined) {
          await applyGate(ctx, config, deps, candidates, bot, signal)
        }
      }
      if (pullLister === undefined) {
        const issues = await deps.list(signal)
        const current = cursors.get(key) ?? { seen: [] }
        const fresh = freshIssues(current.seen, issues)
        if (fresh.length > 0) {
          const bot = config.mode === 'auto'
            ? ctx.bots.list().find(candidate => candidate.name === config.bot)
            : undefined
          if (config.mode === 'auto' && bot === undefined) throw new Error(`no bot named '${config.bot}'`)
          for (const issue of fresh) {
            const candidate = candidateOf(config.repository, issue, deps.now().toISOString())
            if (!admitted(issue.author.login, config.allowedAuthors)) {
              await candidates.put(candidate.id, { ...candidate, state: 'filtered' })
              ctx.logger.info(`bot-source-github: #${issue.number} is from an author outside the allowlist`)
              continue
            }
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
        await publishReports(ctx, config, candidates, signal, deps)
      }
    } catch (error: unknown) {
      if (isAborted(signal)) break
      ctx.logger.warn(`bot-source-github: poll failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await delay(config.pollSeconds * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Remove worktrees whose review ticket reached a terminal stage. */
async function cleanWorktrees(
  ctx: Context,
  config: Config,
  deps: SourceDeps,
  candidates: SourceState['candidates'],
  bot: { readonly id: BotId; readonly workspace: string },
  remove: NonNullable<SourceDeps['removeWorktree']>,
  signal: AbortSignal,
): Promise<void> {
  const stages = new Map<string, TicketStage>(ctx.bots.ticketsOf(bot.id).map(ticket => [String(ticket.id), ticket.stage]))
  for (const [, candidate] of [...candidates.entries()]) {
    if (candidate.worktree === undefined || candidate.cleanedAt !== undefined || candidate.ticketId === undefined) continue
    const stage = stages.get(candidate.ticketId)
    if (stage !== 'ready' && stage !== 'failed' && stage !== 'blocked') continue
    try {
      await remove({
        repository: config.repository,
        repoPath: bot.workspace,
        path: candidate.worktree,
        ref: `refs/dsh-review/${candidate.number}-${(candidate.headSha ?? '').slice(0, 8)}`,
        signal,
      })
      await candidates.put(candidate.id, { ...candidate, cleanedAt: deps.now().toISOString() })
    } catch (error: unknown) {
      ctx.logger.warn(`bot-source-github: worktree cleanup for PR #${candidate.number} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Reconcile one pull request's gate labels with its verdict and checks. */
async function applyGate(
  ctx: Context,
  config: Config,
  deps: SourceDeps,
  candidates: SourceState['candidates'],
  bot: { readonly id: BotId },
  signal: AbortSignal,
): Promise<void> {
  const label = deps.addLabel?.bind(deps)
  const unlabel = deps.removeLabel?.bind(deps)
  const checks = deps.checksPass?.bind(deps)
  if (label === undefined || unlabel === undefined || checks === undefined) return
  const tickets = new Map(ctx.bots.ticketsOf(bot.id).map(ticket => [String(ticket.id), ticket]))
  const checked = new Map<number, boolean>()
  for (const [, candidate] of [...candidates.entries()]) {
    if (candidate.state !== 'opened' || candidate.ticketId === undefined) continue
    const verdict = tickets.get(candidate.ticketId)?.verdict
    if (verdict === undefined) continue
    if (candidate.gate === (verdict === 'pass' ? 'ready' : 'needs-work')) continue
    try {
      if (verdict === 'fail') {
        if (candidate.gate === 'needs-work') continue
        await unlabel({ number: candidate.number, label: config.gateLabel, signal })
        await label({ number: candidate.number, label: config.gateFailLabel, signal })
        await candidates.put(candidate.id, { ...candidate, gate: 'needs-work' })
        continue
      }
      let passed = checked.get(candidate.number)
      if (passed === undefined) {
        passed = await checks({ number: candidate.number, signal })
        checked.set(candidate.number, passed)
      }
      if (!passed) {
        if (candidate.gate === 'pending') continue
        await unlabel({ number: candidate.number, label: config.gateLabel, signal })
        await candidates.put(candidate.id, { ...candidate, gate: 'pending' })
        continue
      }
      await unlabel({ number: candidate.number, label: config.gateFailLabel, signal })
      await label({ number: candidate.number, label: config.gateLabel, signal })
      await candidates.put(candidate.id, { ...candidate, gate: 'ready' })
    } catch (error: unknown) {
      ctx.logger.warn(`bot-source-github: gate for PR #${candidate.number} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Register the two review tools. */
function registerTools(ctx: Context, config: Config, state: SourceState): void {
  ctx.tools.register(defineTool({
    name: 'bot_candidates',
    description: 'List GitHub issue candidates this source considered, newest first, with their state: would-open, opened, or filtered.',
    parameters: {
      state: { type: 'string', enum: ['would-open', 'opened', 'filtered'], description: 'Optional state filter.' },
      limit: { type: 'number', description: 'Maximum rows, default 20.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'number', required: true },
                title: { type: 'string', required: true },
                state: { type: 'string', required: true },
                ticketId: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: () => Promise.resolve({
      candidates: candidatesFor(state, config.repository, undefined).map(candidate => ({
        number: candidate.number,
        title: candidate.title,
        state: candidate.state,
        ...(candidate.ticketId === undefined ? {} : { ticketId: candidate.ticketId }),
      })),
    }),
    presentCall: args => ({ card: 'generic', title: 'bot_candidates', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'bot_accept_candidate',
    description: 'Promote one would-open GitHub candidate into a ticket on this source\'s bot.',
    parameters: {
      number: { type: 'number', required: true, description: 'Issue number of the candidate.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticketId: { type: 'string', required: true },
          number: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async args => await acceptCandidate(ctx, config, state, args.number),
    presentCall: args => ({ card: 'generic', title: 'bot_accept_candidate', rawInput: args }),
  }))
}
