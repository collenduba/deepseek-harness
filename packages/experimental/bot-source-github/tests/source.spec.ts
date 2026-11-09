/**
 * The poll loop over injected effects: seeding, observe, auto, admission, and
 * write-back, without a `gh` process.
 */

import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import type { GithubIssue } from '../src/github.ts'
import { runSource } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { sourceDomainSpec } from '../src/spec.ts'

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

  const run = runSource(
    ctx,
    config({ mode: options.mode, writeBack: options.writeBack ?? false, allowedAuthors: options.allowedAuthors ?? [] }),
    controller.signal,
    deps,
  )
  await run
  const domain = await facility.open(sourceDomainSpec)
  onTestFinished(async () => { await domain.close() })
  const candidates = [...domain.table('candidates').entries()].map(([, candidate]) => candidate)
  return { opened, comments, candidates, calls }
}

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
})
