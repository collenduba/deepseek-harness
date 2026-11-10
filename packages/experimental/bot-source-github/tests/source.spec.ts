/**
 * The poll loop over injected effects: seeding, observe, auto, admission, and
 * write-back, without a `gh` process.
 */

import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import type { GithubIssue, GithubPullRequest } from '../src/github.ts'
import { acceptCandidate, candidatesFor, runSource } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { sourceDomainSpec } from '../src/spec.ts'
import type { CandidateId } from '../src/spec.ts'

const ROUTER = brandString<SessionId>('router-1')

const issue = (number: number, author = 'alice'): GithubIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  updatedAt: '2026-11-09T00:00:00Z',
  author: { login: author },
})

const config = (over: Partial<Config> = {}): Config => ({
  bot: 'reviewer',
  repository: 'o/r',
  query: 'is:issue is:open',
  pollSeconds: 60,
  ghCommand: 'gh',
  timeoutMs: 30_000,
  backlog: 'ignore',
  mode: 'observe',
  writeBack: false,
  allowedAuthors: [],
  autostart: true,
  target: 'issues',
  includeDrafts: false,
  worktrees: false,
  worktreeRoot: '',
  gate: 'off',
  gateLabel: 'merge-ready',
  gateFailLabel: 'needs-work',
  maxSeen: 200,
  ...over,
})

/** Boot real storage plus a fake bot registry, then return the loop's inputs. */
async function bench(options: {
  issues: GithubIssue[]
  mode: Config['mode']
  writeBack?: boolean
  allowedAuthors?: string[]
  ticketStage?: string
}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.provide('storageDomain' as string, facility)

  const opened: string[] = []
  const tickets: {
    id: string
    title: string
    instruction: string
    stage: string
    summary?: string
  }[] = []
  const bot = {
    id: 'bot-1',
    name: 'reviewer',
    job: 'Review',
    workspace: '/tmp/w',
    routerSession: ROUTER,
    status: 'active',
    createdAt: '2026-11-09T00:00:00Z',
    updatedAt: '2026-11-09T00:00:00Z',
  }
  ctx.provide('bots' as string, {
    list: () => [bot],
    openTicket: async (input: { title: string; instruction: string }) => {
      opened.push(input.title)
      const ticket = { id: `ticket-${opened.length}`, title: input.title, instruction: input.instruction, stage: 'working' }
      tickets.push(ticket)
      return ticket
    },
    ticketsOf: () => tickets.map(ticket => ({
      ...ticket,
      stage: options.ticketStage ?? ticket.stage,
      summary: options.ticketStage === undefined ? undefined : 'Done.',
    })),
  })

  const comments: { number: number; body: string }[] = []
  const controller = new AbortController()
  let calls = 0
  const deps = {
    list: (): Promise<GithubIssue[]> => {
      calls += 1
      if (calls === 1) return Promise.resolve([])
      controller.abort()
      return Promise.resolve(options.issues)
    },
    comment: (number: number, body: string): Promise<void> => {
      comments.push({ number, body })
      return Promise.resolve()
    },
    now: () => new Date('2026-11-09T01:00:00Z'),
  }

  const domain = await facility.open(sourceDomainSpec)
  onTestFinished(async () => { await domain.close() })
  const state = {
    cursors: domain.table('cursors'),
    candidates: domain.table('candidates'),
  }
  const run = runSource(
    ctx,
    config({ mode: options.mode, writeBack: options.writeBack ?? false, allowedAuthors: options.allowedAuthors ?? [] }),
    controller.signal,
    deps,
    state,
  )
  await run
  const candidates = [...state.candidates.entries()].map(([, candidate]) => candidate)
  return { opened, comments, candidates, calls, ctx, state }
}

/** Boot real storage plus fake bots, and drive the pull-request loop. */
async function benchPullRequests(
  script: GithubPullRequest[][],
  options: {
    worktrees?: boolean
    stages?: Record<string, string>
    failNumber?: number
    verdicts?: Record<string, 'pass' | 'fail'>
    checks?: boolean
  } = {},
) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.provide('storageDomain' as string, facility)

  const opened: string[] = []
  const tickets: { title: string; instruction: string; workspace?: string }[] = []
  const prepared: string[] = []
  const removed: string[] = []
  const labels: { number: number; label: string }[] = []
  const removedLabels: { number: number; label: string }[] = []
  const bot = {
    id: 'bot-1', name: 'reviewer', job: 'Review', workspace: '/tmp/w', routerSession: ROUTER,
    status: 'active', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z',
  }
  ctx.provide('bots' as string, {
    list: () => [bot],
    openTicket: (input: { title: string; instruction: string; workspace?: string }) => {
      opened.push(input.title)
      tickets.push({
        title: input.title,
        instruction: input.instruction,
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      })
      return Promise.resolve({ id: `ticket-${opened.length}`, title: input.title, instruction: input.instruction, stage: 'working' })
    },
    ticketsOf: () => Object.entries(options.stages ?? {}).map(([id, stage]) => ({
      id, stage, ...(options.verdicts?.[id] === undefined ? {} : { verdict: options.verdicts[id] }),
    })),
  })

  const controller = new AbortController()
  let call = 0
  const deps = {
    list: () => Promise.resolve([]),
    listPullRequests: (): Promise<GithubPullRequest[]> => {
      call += 1
      const items = script[call - 1] ?? []
      if (call >= script.length) controller.abort()
      return Promise.resolve(items)
    },
    comment: () => Promise.resolve(),
    prepareWorktree: (input: { root: string; pullRequest: GithubPullRequest }) => {
      if (options.failNumber === input.pullRequest.number) return Promise.reject(new Error('fetch failed'))
      const path = join(input.root, `review-${input.pullRequest.number}-${input.pullRequest.headRefOid.slice(0, 8)}`)
      prepared.push(path)
      return Promise.resolve(path)
    },
    removeWorktree: (input: { path: string }) => {
      removed.push(input.path)
      return Promise.resolve()
    },
    addLabel: (input: { number: number; label: string }) => {
      labels.push({ number: input.number, label: input.label })
      return Promise.resolve()
    },
    removeLabel: (input: { number: number; label: string }) => {
      removedLabels.push({ number: input.number, label: input.label })
      return Promise.resolve()
    },
    checksPass: () => Promise.resolve(options.checks ?? true),
    now: () => new Date('2026-11-09T01:00:00Z'),
  }

  const domain = await facility.open(sourceDomainSpec)
  onTestFinished(async () => { await domain.close() })
  const state = { cursors: domain.table('cursors'), candidates: domain.table('candidates') }
  await runSource(
    ctx,
    config({
      target: 'pull-requests', mode: 'auto', pollSeconds: 0,
      worktrees: options.worktrees ?? false, worktreeRoot: '/tmp/worktrees',
      gate: options.verdicts === undefined ? 'off' : 'label',
    }),
    controller.signal,
    deps,
    state,
  )
  return {
    opened, tickets, prepared, removed, labels, removedLabels,
    candidates: [...state.candidates.entries()].map(([, candidate]) => candidate),
  }
}

const pullRequest = (number: number, sha: string): GithubPullRequest => ({
  number,
  title: `PR ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  updatedAt: '2026-11-09T00:00:00Z',
  author: { login: 'alice' },
  headRefOid: sha,
  baseRefName: 'main',
  isDraft: false,
})

describe('github source loop', () => {
  it('records a candidate per issue and opens nothing in observe mode', async () => {
    const { opened, candidates, comments } = await bench({ issues: [issue(1)], mode: 'observe' })
    expect(opened).toEqual([])
    expect(comments).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ number: 1, state: 'would-open' })
    expect(candidates[0]?.ticketId).toBeUndefined()
  })

  it('opens tickets in auto mode and comments each finished result once', async () => {
    const { opened, comments, candidates } = await bench({
      issues: [issue(1)],
      mode: 'auto',
      writeBack: true,
      ticketStage: 'ready',
    })
    expect(opened).toEqual(['#1 Issue 1'])
    expect(candidates[0]).toMatchObject({ number: 1, state: 'opened', ticketId: 'ticket-1' })
    expect(candidates[0]?.commentedAt).toBe('2026-11-09T01:00:00.000Z')
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain('finished ticket #1 Issue 1 with stage ready: Done.')
  })

  it('filters authors outside the allowlist and opens no ticket for them', async () => {
    const { opened, comments, candidates } = await bench({
      issues: [issue(1, 'alice'), issue(2, 'bob')],
      mode: 'auto',
      writeBack: true,
      allowedAuthors: ['alice'],
      ticketStage: 'ready',
    })
    expect(opened).toEqual(['#1 Issue 1'])
    expect(comments).toHaveLength(1)
    expect(comments[0]?.number).toBe(1)
    const filtered = candidates.find(candidate => candidate.number === 2)
    expect(filtered).toMatchObject({ state: 'filtered' })
    expect(filtered?.ticketId).toBeUndefined()
  })

  it('reviews each pull-request head once and again after a new push', async () => {
    const { opened, candidates } = await benchPullRequests([
      [],
      [pullRequest(1, 'sha-1')],
      [pullRequest(1, 'sha-1')],
      [pullRequest(1, 'sha-2')],
    ])
    expect(opened).toEqual(['Review #1 PR 1', 'Review #1 PR 1'])
    expect(candidates.map(candidate => candidate.headSha)).toEqual(['sha-1', 'sha-2'])
    expect(candidates.every(candidate => candidate.kind === 'pull-request')).toBe(true)
  })

  it('reviews a revision in its own worktree and removes it when the ticket ends', async () => {
    const { tickets, prepared, removed, candidates } = await benchPullRequests(
      [[], [pullRequest(2, 'sha-a')], []],
      { worktrees: true, stages: { 'ticket-1': 'ready' } },
    )
    expect(prepared).toEqual(['/tmp/worktrees/review-2-sha-a'])
    expect(tickets[0]?.workspace).toBe('/tmp/worktrees/review-2-sha-a')
    expect(tickets[0]?.instruction).toContain('isolated checkout')
    expect(tickets[0]?.instruction).not.toContain('git worktree add')
    expect(removed).toEqual(['/tmp/worktrees/review-2-sha-a'])
    expect(candidates[0]?.worktree).toBe('/tmp/worktrees/review-2-sha-a')
    expect(candidates[0]?.cleanedAt).toBeDefined()
  })

  it('labels a passing review only when its checks are green', async () => {
    const pass = await benchPullRequests(
      [[], [pullRequest(3, 'sha-c')], []],
      { verdicts: { 'ticket-1': 'pass' }, stages: { 'ticket-1': 'ready' }, checks: true },
    )
    expect(pass.labels).toEqual([{ number: 3, label: 'merge-ready' }])
    expect(pass.removedLabels).toEqual([{ number: 3, label: 'needs-work' }])

    const failing = await benchPullRequests(
      [[], [pullRequest(3, 'sha-c')], []],
      { verdicts: { 'ticket-1': 'pass' }, stages: { 'ticket-1': 'ready' }, checks: false },
    )
    expect(failing.labels).toEqual([])
    expect(failing.removedLabels).toEqual([{ number: 3, label: 'merge-ready' }])
  })

  it('labels a failed review even before checks finish', async () => {
    const { labels, removedLabels } = await benchPullRequests(
      [[], [pullRequest(4, 'sha-d')], []],
      { verdicts: { 'ticket-1': 'fail' }, stages: { 'ticket-1': 'ready' } },
    )
    expect(labels).toEqual([{ number: 4, label: 'needs-work' }])
    expect(removedLabels).toEqual([{ number: 4, label: 'merge-ready' }])
  })

  it('keeps reviewing other revisions when one worktree cannot be prepared', async () => {
    const { tickets, prepared, candidates } = await benchPullRequests(
      [[], [pullRequest(1, 'sha-1'), pullRequest(2, 'sha-2')], []],
      { worktrees: true, failNumber: 1 },
    )
    expect(tickets.map(ticket => ticket.title)).toEqual(['Review #2 PR 2'])
    expect(prepared).toEqual(['/tmp/worktrees/review-2-sha-2'])
    expect(candidates.find(candidate => candidate.number === 1)?.state).toBe('would-open')
    expect(candidates.find(candidate => candidate.number === 2)?.state).toBe('opened')
  })

  it('lists candidates and promotes a would-open one into a ticket', async () => {
    const { ctx, state, candidates } = await bench({ issues: [issue(1), issue(2, 'bob')], mode: 'observe', allowedAuthors: ['alice'] })
    expect(candidates).toHaveLength(2)
    expect(candidatesFor(state, 'o/r')).toHaveLength(2)
    expect(candidatesFor(state, 'o/r', 'would-open').map(candidate => candidate.number)).toEqual([1])
    expect(candidatesFor(state, 'o/r', 'filtered').map(candidate => candidate.number)).toEqual([2])

    const accepted = await acceptCandidate(ctx, config({ mode: 'observe' }), state, 1)
    expect(accepted.number).toBe(1)
    expect(accepted.ticketId).toBe('ticket-1')
    expect(state.candidates.get(brandString<CandidateId>('candidate-o/r-1'))).toMatchObject({ state: 'opened', ticketId: 'ticket-1' })

    await expect(acceptCandidate(ctx, config({ mode: 'observe' }), state, 1)).rejects.toThrow(/is opened/)
    await expect(acceptCandidate(ctx, config({ mode: 'observe' }), state, 2)).rejects.toThrow(/is filtered/)
    await expect(acceptCandidate(ctx, config({ mode: 'observe' }), state, 9)).rejects.toThrow(/unknown candidate/)
  })
})
