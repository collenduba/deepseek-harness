import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import BotRegistry, {
  approvalRecordSchema, botProjection, botRecordSchema, isQuietAt, memoryRecordSchema, parseQuietHours,
  ticketRecordSchema, blockedCommand, botDomainSpec, capabilityAllows, isHardFloor, requireApproval, workerInstruction,
} from '../src/index.ts'
import type { BotApprovalId, BotId, BotMemoryId, BotProjectionState, TicketId } from '../src/index.ts'

const ROUTER = brandString<SessionId>('router-1')
const WORKER = brandString<SessionId>('worker-1')

/** Boot a context with real storage, the bot registry, and fake peer services. */
async function harness(config: {
  quietHours?: string
  digestMinutes?: number
  holdResults?: boolean
  maxWorkersPerBot?: number
  maxHandoffDepth?: number
  workerTimeoutMinutes?: number
  seed?: (facility: DomainFacility) => Promise<void>
} = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain' as string, facility)
  const followups: string[] = []
  const pushNotice = (message: {
    content: { type: string; text: string }[]
    source?: { form?: string }
  }): void => {
    if (message.source?.form !== 'notice') return
    followups.push(message.content[0]?.text ?? '')
  }
  ctx.provide('tools' as string, { register: () => () => {} })
  interface FakeAgent {
    status: 'idle' | 'running'
    readonly session: { id: SessionId }
    readonly cancel: ReturnType<typeof vi.fn>
    readonly followup: (message: { content: { type: string; text: string }[] }) => void
  }
  const workers = new Map<string, FakeAgent>()
  ctx.provide('agents' as string, {
    create: async (options: { sessionId?: SessionId } = {}) => {
      const id = options.sessionId ?? WORKER
      const agent: FakeAgent = {
        status: 'running',
        session: { id },
        cancel: vi.fn(() => { agent.status = 'idle' }),
        followup: pushNotice,
      }
      workers.set(id, agent)
      return { agent, dispose: async () => {} }
    },
    get: (id: SessionId) => workers.get(id) ?? (id === ROUTER
      ? {
        status: 'inactive',
        session: { id },
        cancel: () => {},
        followup: (message: { content: { type: string; text: string }[] }) => {
          followups.push(message.content[0]?.text ?? '')
        },
      }
      : undefined),
  })
  ctx.provide('agentDefaultModel' as string, { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('sessionTitle' as string, { rename: () => {} })
  ctx.provide('sessionProjections' as string, { register: async () => ({}) })
  ctx.provide('workspaceRegistry' as string, {
    create: async (path: string) => ({
      path,
      attachSession: async () => {},
      detachSession: async () => {},
    }),
  })
  if (config.seed !== undefined) await config.seed(facility)
  await ctx.plugin(BotRegistry, {
    quietHours: config.quietHours ?? '',
    digestMinutes: config.digestMinutes ?? 5,
    enforceApprovals: false,
    guardedTools: ['bash', 'pwsh'],
    holdResults: config.holdResults ?? false,
    maxWorkersPerBot: config.maxWorkersPerBot ?? 2,
    maxHandoffDepth: config.maxHandoffDepth ?? 3,
    workerTimeoutMinutes: config.workerTimeoutMinutes ?? 30,
  })
  return { ctx, followups, workers }
}

describe('bot records', () => {
  it('creates a bot bound to the calling Session and finds it again', async () => {
    const { ctx } = await harness()
    const bot = await ctx.bots.create({
      name: 'reviewer',
      job: 'Review pull requests',
      workspace: '/tmp/work',
      routerSession: ROUTER,
    })
    expect(ctx.bots.findByRouter(ROUTER)?.id).toBe(bot.id)
    expect(ctx.bots.list().map(entry => entry.name)).toEqual(['reviewer'])
  })

  it('stores and validates blocked shell command patterns', async () => {
    const { ctx } = await harness()
    const bot = await ctx.bots.create({
      name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      blockedCommands: ['\\bgit\\s+push\\b', 'gh pr merge'],
    })
    expect(bot.blockedCommands).toEqual(['\\bgit\\s+push\\b', 'gh pr merge'])
    await expect(ctx.bots.create({
      name: 'broken', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      blockedCommands: ['('],
    })).rejects.toThrow(/not a valid regular expression/)
  })

  it('stores an optional worker tool allowlist', async () => {
    const { ctx } = await harness()
    const bot = await ctx.bots.create({
      name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
      tools: ['read', 'grep', 'bash'],
      hardFloor: ['transfer-funds'],
    })
    expect(bot.tools).toEqual(['read', 'grep', 'bash'])
    expect(bot.hardFloor).toEqual(['transfer-funds'])
    expect(ctx.bots.list()[0]?.tools).toEqual(['read', 'grep', 'bash'])
  })

  it('rejects a duplicate name in the same Session and a relative workspace', async () => {
    const { ctx } = await harness()
    const input = {
      name: 'reviewer',
      job: 'Review pull requests',
      workspace: '/tmp/work',
      routerSession: ROUTER,
    }
    await ctx.bots.create(input)
    await expect(ctx.bots.create(input)).rejects.toThrow(/already owns/)
    await expect(ctx.bots.create({ ...input, name: 'other', workspace: 'relative' }))
      .rejects.toThrow(/absolute/)
  })
})

describe('tickets', () => {
  it('opens a ticket, launches a worker, and reports back to the router', async () => {
    const { ctx, followups } = await harness()
    await ctx.bots.create({
      name: 'reviewer',
      job: 'Review pull requests',
      workspace: '/tmp/work',
      routerSession: ROUTER,
    })
    const ticket = await ctx.bots.openTicket({
      routerSession: ROUTER,
      title: 'Review #12',
      instruction: 'Review the diff and report.',
    })
    expect(ticket.stage).toBe('working')
    const worker = ticket.workerSession
    expect(worker).toMatch(/^bot-worker-/)

    const reported = await ctx.bots.report(worker!, ticket.id, { stage: 'ready', summary: 'No blockers.' })
    expect(reported.stage).toBe('ready')
    expect(ctx.bots.ticketsOf(ticket.botId)).toHaveLength(1)
    expect(followups).toEqual(['Ticket "Review #12" is ready: No blockers.'])
  })

  it('refuses a report from any Session other than the ticket worker', async () => {
    const { ctx } = await harness()
    await ctx.bots.create({
      name: 'reviewer',
      job: 'Review pull requests',
      workspace: '/tmp/work',
      routerSession: ROUTER,
    })
    const ticket = await ctx.bots.openTicket({
      routerSession: ROUTER,
      title: 'Review #12',
      instruction: 'Review the diff and report.',
    })
    await expect(ctx.bots.report(ROUTER, ticket.id, { stage: 'ready', summary: 'done' }))
      .rejects.toThrow(/only the worker Session/)
  })

  it('keeps notes across tickets and names the worker ticket', async () => {
    const { ctx } = await harness()
    const bot = await ctx.bots.create({
      name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
    })
    const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review the diff.' })
    const memory = await ctx.bots.remember(bot.id, 'The repo uses pnpm.', ticket.id)
    expect(memory.sourceTicket).toBe(ticket.id)
    expect(ctx.bots.memoriesOf(bot.id).map(entry => entry.text)).toEqual(['The repo uses pnpm.'])
    expect(ctx.bots.ticketOfWorker(ticket.workerSession!)?.id).toBe(ticket.id)
    expect(memoryRecordSchema.safeParse({ ...memory, text: '' }).success).toBe(false)
  })

  it('archives a bot and every ticket it opened', async () => {
    const { ctx } = await harness()
    const bot = await ctx.bots.create({
      name: 'reviewer',
      job: 'Review pull requests',
      workspace: '/tmp/work',
      routerSession: ROUTER,
    })
    const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review the diff.' })
    await ctx.bots.remember(bot.id, 'The repo uses pnpm.')
    await ctx.bots.requestApproval(ticket.id, 'merge', '{}')
    const archived = await ctx.bots.archive(bot.id)
    expect(archived).toEqual({ name: 'reviewer', archivedTickets: 1 })
    expect(ctx.bots.list()).toEqual([])
    expect(ctx.bots.ticketsOf(bot.id)).toEqual([])
    expect(ctx.bots.memoriesOf(bot.id)).toEqual([])
    expect(ctx.bots.approvalsOf(bot.id)).toEqual([])
    expect(ctx.bots.noticesOf(bot.id)).toEqual([])
    await expect(ctx.bots.archive(bot.id)).rejects.toThrow(/unknown bot/)
  })

  it('hands work to another bot and records the source ticket', async () => {
    const { ctx } = await harness()
    const reviewer = await ctx.bots.create({
      name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
    })
    await ctx.bots.create({
      name: 'fixer', job: 'Fix what the reviewer finds', workspace: '/tmp/work',
      routerSession: brandString<SessionId>('router-2'),
    })
    const source = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review the diff.' })
    const handed = await ctx.bots.handoff(source.id, 'fixer', 'Fix #12', 'Fix the failing test.')
    expect(handed.stage).toBe('working')
    expect(handed.parentTicket).toBe(source.id)
    expect(handed.parentBotName).toBe('reviewer')
    expect(handed.botId).not.toBe(reviewer.id)

    await expect(ctx.bots.handoff(source.id, 'reviewer', 'x', 'y')).rejects.toThrow(/same bot/)
    await expect(ctx.bots.handoff(source.id, 'missing', 'x', 'y')).rejects.toThrow(/no active bot/)
    await expect(ctx.bots.handoff(brandString<TicketId>('ticket-missing'), 'fixer', 'x', 'y'))
      .rejects.toThrow(/unknown ticket/)
  })

  it('queues a ticket when every worker slot is busy and starts it after a report', async () => {
    const { ctx } = await harness({ maxWorkersPerBot: 1 })
    await ctx.bots.create({
      name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
    })
    const first = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'First', instruction: 'One.' })
    const second = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Second', instruction: 'Two.' })
    expect(first.stage).toBe('working')
    expect(second.stage).toBe('queued')
    expect(second.workerSession).toBeUndefined()

    await ctx.bots.report(first.workerSession!, first.id, { stage: 'ready', summary: 'Done.' })
    const started = ctx.bots.ticketsOf(second.botId).find(ticket => ticket.id === second.id)
    expect(started?.stage).toBe('working')
    expect(started?.workerSession).toBeDefined()
  })

  it('refuses a handoff beyond the configured depth', async () => {
    const { ctx } = await harness({ maxHandoffDepth: 1 })
    await ctx.bots.create({ name: 'reviewer', job: 'A', workspace: '/tmp/work', routerSession: ROUTER })
    await ctx.bots.create({ name: 'fixer', job: 'B', workspace: '/tmp/work', routerSession: brandString<SessionId>('router-2') })
    await ctx.bots.create({ name: 'third', job: 'C', workspace: '/tmp/work', routerSession: brandString<SessionId>('router-3') })
    const source = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
    const firstHandoff = await ctx.bots.handoff(source.id, 'fixer', 'Fix #12', 'Fix it.')
    expect(firstHandoff.handoffDepth).toBe(1)
    await expect(ctx.bots.handoff(firstHandoff.id, 'third', 'Third', 'Go.'))
      .rejects.toThrow(/handoff depth 2 exceeds/)
  })

  it('cancels a worker that exceeds its budget and reports the ticket blocked', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, workers } = await harness({ workerTimeoutMinutes: 1 })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(ticket.workerSession).toBeDefined()
      expect(workers.get(ticket.workerSession!)?.cancel).toHaveBeenCalled()
      const updated = ctx.bots.ticketsOf(bot.id).find(entry => entry.id === ticket.id)
      expect(updated?.stage).toBe('blocked')
      expect(updated?.summary).toContain('exceeded the 1-minute budget')
    } finally {
      vi.useRealTimers()
    }
  })

  it('blocks workers that are no longer running and starts the queue', async () => {
    const { ctx, workers } = await harness({ maxWorkersPerBot: 1 })
    const bot = await ctx.bots.create({
      name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
    })
    const first = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'First', instruction: 'One.' })
    const second = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Second', instruction: 'Two.' })
    workers.clear()
    await ctx.bots.reconcile()
    const tickets = ctx.bots.ticketsOf(bot.id)
    expect(tickets.find(entry => entry.id === first.id)?.stage).toBe('blocked')
    expect(tickets.find(entry => entry.id === first.id)?.summary).toContain('not running')
    expect(tickets.find(entry => entry.id === second.id)?.stage).toBe('working')
  })

  it('disables the budget when workerTimeoutMinutes is 0', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, workers } = await harness({ workerTimeoutMinutes: 0 })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
      await vi.advanceTimersByTimeAsync(3_600_000)
      expect(workers.get(ticket.workerSession!)?.cancel).not.toHaveBeenCalled()
      expect(ctx.bots.ticketsOf(bot.id)[0]?.stage).toBe('working')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not expire a worker that already reported', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, workers } = await harness({ workerTimeoutMinutes: 1 })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
      await ctx.bots.report(ticket.workerSession!, ticket.id, { stage: 'ready', summary: 'Done.' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(workers.get(ticket.workerSession!)?.cancel).not.toHaveBeenCalled()
      expect(ctx.bots.ticketsOf(bot.id)[0]?.stage).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms a live worker and bounds a waiting ticket on reconciliation', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, workers } = await harness({ workerTimeoutMinutes: 1 })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const working = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Working', instruction: 'Work.' })
      const waiting = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Waiting', instruction: 'Wait.' })
      await ctx.bots.report(waiting.workerSession!, waiting.id, { stage: 'waiting', summary: 'Need input.' })
      await ctx.bots.reconcile()
      expect(ctx.bots.ticketsOf(bot.id).find(entry => entry.id === waiting.id)?.stage).toBe('waiting')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(workers.get(working.workerSession!)?.cancel).toHaveBeenCalled()
      expect(workers.get(waiting.workerSession!)?.cancel).toHaveBeenCalled()
      const waited = ctx.bots.ticketsOf(bot.id).find(entry => entry.id === waiting.id)
      expect(waited?.stage).toBe('blocked')
      expect(waited?.summary).toContain('waited past')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the budget running while a worker waits for an answer', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, workers } = await harness({ workerTimeoutMinutes: 1 })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Waiting', instruction: 'Wait.' })
      await ctx.bots.report(ticket.workerSession!, ticket.id, { stage: 'waiting', summary: 'Need input.' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(workers.get(ticket.workerSession!)?.cancel).toHaveBeenCalled()
      const updated = ctx.bots.ticketsOf(bot.id)[0]
      expect(updated?.stage).toBe('blocked')
      expect(updated?.summary).toContain('waited past')
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the clock when an answer reaches a waiting worker', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, workers } = await harness({ workerTimeoutMinutes: 1 })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
      const approval = await ctx.bots.requestApproval(ticket.id, 'merge', '{}')
      await ctx.bots.report(ticket.workerSession!, ticket.id, { stage: 'waiting', summary: 'Need a decision.' })
      await vi.advanceTimersByTimeAsync(50_000)
      await ctx.bots.decideApproval(approval.id, 'approved')
      expect(ctx.bots.ticketsOf(bot.id)[0]?.stage).toBe('working')
      await vi.advanceTimersByTimeAsync(50_000)
      expect(workers.get(ticket.workerSession!)?.cancel).not.toHaveBeenCalled()
      expect(ctx.bots.ticketsOf(bot.id)[0]?.stage).toBe('working')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(workers.get(ticket.workerSession!)?.cancel).toHaveBeenCalled()
      expect(ctx.bots.ticketsOf(bot.id)[0]?.stage).toBe('blocked')
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the budget when its bot is archived', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, workers } = await harness({ workerTimeoutMinutes: 1 })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
      await ctx.bots.archive(bot.id)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(workers.get(ticket.workerSession!)?.cancel).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a stranded ticket as blocked during startup reconciliation', async () => {
    const botId = brandString<BotId>('bot-seeded')
    const ticketId = brandString<TicketId>('ticket-seeded')
    const stamp = '2026-11-09T00:00:00.000Z'
    const { ctx, followups } = await harness({
      seed: async (facility) => {
        const domain = await facility.open(botDomainSpec)
        await domain.table('bots').put(botId, {
          id: botId, name: 'seeded', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER,
          status: 'active', createdAt: stamp, updatedAt: stamp,
        })
        await domain.table('tickets').put(ticketId, {
          id: ticketId, botId, title: 'Stranded', instruction: 'Go.', stage: 'working',
          routerSession: ROUTER, workerSession: WORKER, createdAt: stamp, updatedAt: stamp,
        })
        await domain.close()
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.bots.ticketsOf(botId)[0]?.stage).toBe('blocked')
    expect(ctx.bots.ticketsOf(botId)[0]?.summary).toContain('not running')
    expect(followups.some(text => text.includes('not running'))).toBe(true)
  })

  it('refuses to open a ticket when no bot is bound to the Session', async () => {
    const { ctx } = await harness()
    await expect(ctx.bots.openTicket({
      routerSession: ROUTER,
      title: 'Review #12',
      instruction: 'Review the diff and report.',
    })).rejects.toThrow(/call bot_create/)
  })
})

describe('approvals', () => {
  it('binds a request to its payload and wakes the worker on a decision', async () => {
    const { ctx, followups } = await harness()
    const bot = await ctx.bots.create({
      name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
    })
    const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review the diff.' })
    const approval = await ctx.bots.requestApproval(ticket.id, 'merge', '{"pull":12}')
    expect(approval.status).toBe('pending')
    expect(approval.payload).toBe('{"pull":12}')
    expect(approval.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(followups.some(text => text.includes(approval.id))).toBe(true)

    const decided = await ctx.bots.decideApproval(approval.id, 'approved', 'Ship it.')
    expect(decided).toMatchObject({ status: 'approved', note: 'Ship it.', payload: '{"pull":12}' })
    expect(followups.some(text => text.includes(`Approval ${approval.id} was approved`))).toBe(true)
    expect(ctx.bots.approvalsOf(bot.id)).toHaveLength(1)

    await expect(ctx.bots.decideApproval(approval.id, 'denied')).rejects.toThrow(/already approved/)
    await expect(ctx.bots.decideApproval(brandString<BotApprovalId>('approval-missing'), 'approved'))
      .rejects.toThrow(/unknown approval/)
  })

  it('refuses a hard-floor action before a request is stored', async () => {
    const { ctx } = await harness()
    const bot = await ctx.bots.create({
      name: 'reviewer', job: 'Review', workspace: '/tmp/work', routerSession: ROUTER, hardFloor: ['transfer-funds'],
    })
    const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
    await expect(ctx.bots.requestApproval(ticket.id, 'transfer-funds', '{}'))
      .rejects.toThrow(/hard floor/)
    const allowed = await ctx.bots.requestApproval(ticket.id, 'merge', '{}')
    expect(allowed.status).toBe('pending')
    expect(ctx.bots.approvalsOf(bot.id)).toHaveLength(1)
  })

  it('rejects an approval record with an unknown status', () => {
    const record = {
      id: 'approval-1', botId: 'bot-1', ticketId: 'ticket-1', action: 'merge',
      payload: '{}', digest: 'a'.repeat(64), status: 'pending', createdAt: '2026-11-08T00:00:00Z',
    }
    expect(approvalRecordSchema.safeParse(record).success).toBe(true)
    expect(approvalRecordSchema.safeParse({ ...record, status: 'maybe' }).success).toBe(false)
  })
})

describe('approval gate', () => {
  it('matches blocked command patterns case-insensitively', () => {
    expect(blockedCommand(undefined, 'git push')).toBeUndefined()
    expect(blockedCommand(['\\bgit\\s+push\\b'], 'git push origin main')).toBe('\\bgit\\s+push\\b')
    expect(blockedCommand(['\\bgit\\s+push\\b'], 'GIT PUSH origin main')).toBe('\\bgit\\s+push\\b')
    expect(blockedCommand(['\\bgit\\s+push\\b'], 'git status')).toBeUndefined()
    expect(blockedCommand(['gh pr merge'], 'gh pr merge --squash')).toBe('gh pr merge')
  })

  it('recognises hard-floor actions', () => {
    expect(isHardFloor(undefined, 'merge')).toBe(false)
    expect(isHardFloor(['merge'], 'merge')).toBe(true)
    expect(isHardFloor(['merge'], 'post')).toBe(false)
  })

  it('applies a bot tool allowlist but keeps the reporting tools', () => {
    expect(capabilityAllows(undefined, 'bash')).toBe(true)
    expect(capabilityAllows(['read', 'bash'], 'bash')).toBe(true)
    expect(capabilityAllows(['read'], 'bash')).toBe(false)
    expect(capabilityAllows(['read'], 'bot_report')).toBe(true)
    expect(capabilityAllows([], 'read')).toBe(false)
  })

  it('requires approval only for guarded tools with an exact command', () => {
    const approved = new Set(['pnpm test'])
    expect(requireApproval(['bash'], approved, { name: 'bash', arguments: { command: 'pnpm test', description: 'x' } }))
      .toEqual({ required: true, approved: true, command: 'pnpm test' })
    expect(requireApproval(['bash'], approved, { name: 'bash', arguments: { command: 'rm -rf x' } }))
      .toEqual({ required: true, approved: false, command: 'rm -rf x' })
    expect(requireApproval(['bash'], approved, { name: 'read', arguments: { path: 'x' } }))
      .toEqual({ required: false, approved: false })
    expect(requireApproval(['bash'], approved, { name: 'bash', arguments: { workdir: '/tmp' } }))
      .toEqual({ required: true, approved: false })
  })
})

describe('attention', () => {
  it('parses quiet windows and answers overnight boundaries', () => {
    expect(parseQuietHours('')).toBeUndefined()
    const window = parseQuietHours('22:00-07:00')
    expect(window).toEqual({ start: 22 * 60, end: 7 * 60 })
    expect(isQuietAt(window, new Date(2026, 10, 8, 23, 0))).toBe(true)
    expect(isQuietAt(window, new Date(2026, 10, 8, 6, 59))).toBe(true)
    expect(isQuietAt(window, new Date(2026, 10, 8, 7, 0))).toBe(false)
    expect(isQuietAt(parseQuietHours('09:00-17:00'), new Date(2026, 10, 8, 12, 0))).toBe(true)
    expect(() => parseQuietHours('22-7')).toThrow(/HH:MM/)
  })

  it('holds result notices for the digest but never blocks a blocker', async () => {
    const { ctx, followups } = await harness({ holdResults: true })
    const bot = await ctx.bots.create({
      name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
    })
    const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review.' })
    await ctx.bots.report(ticket.workerSession!, ticket.id, { stage: 'ready', summary: 'Done.' })
    expect(followups).toEqual([])
    expect(ctx.bots.noticesOf(bot.id).filter(notice => notice.deliveredAt === undefined)).toHaveLength(1)

    await ctx.bots.requestApproval(ticket.id, 'merge', '{}')
    expect(followups.some(text => text.includes('requested for ticket'))).toBe(true)

    await ctx.bots.flushNotices()
    expect(followups.some(text => text.includes('Held updates (1)'))).toBe(true)
  })

  it('holds notices during quiet hours and delivers one digest afterwards', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 10, 8, 23, 0))
      const { ctx, followups } = await harness({ quietHours: '22:00-07:00' })
      const bot = await ctx.bots.create({
        name: 'reviewer', job: 'Review pull requests', workspace: '/tmp/work', routerSession: ROUTER,
      })
      const ticket = await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review the diff.' })
      await ctx.bots.report(ticket.workerSession!, ticket.id, { stage: 'ready', summary: 'Done.' })
      expect(followups).toEqual([])
      expect(ctx.bots.noticesOf(bot.id).filter(notice => notice.deliveredAt === undefined)).toHaveLength(1)

      vi.setSystemTime(new Date(2026, 11, 9, 12, 0))
      await ctx.bots.flushNotices()
      expect(followups.some(text => text.includes('Held updates (1)'))).toBe(true)
      expect(ctx.bots.noticesOf(bot.id).every(notice => notice.deliveredAt !== undefined)).toBe(true)
      await ctx.bots.flushNotices()
      expect(followups.filter(text => text.includes('Held updates'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('worker instructions', () => {
  it('names the ticket, the instruction, and the report tool', () => {
    const bot = {
      id: brandString<BotId>('bot-1'),
      name: 'reviewer',
      job: 'Review pull requests',
      workspace: '/tmp/work',
      routerSession: ROUTER,
      status: 'active' as const,
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    }
    const ticket = {
      id: brandString<TicketId>('ticket-1'),
      botId: bot.id,
      title: 'Review #12',
      instruction: 'Review the diff and report.',
      stage: 'queued' as const,
      routerSession: ROUTER,
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    }
    const memory = {
      id: brandString<BotMemoryId>('memory-1'),
      botId: bot.id,
      text: 'Run the unit tests before opening a pull request.',
      createdAt: '2026-11-06T00:00:00.000Z',
    }
    const text = workerInstruction({ ...bot, tools: ['read', 'bash'], hardFloor: ['transfer-funds'] }, ticket, [memory])
    expect(text).toContain('ticket-1')
    expect(text).toContain('Review the diff and report.')
    expect(text).toContain('bot_report')
    expect(text).toContain('Run the unit tests before opening a pull request.')
    expect(text).toContain('You may call only these tools: read, bash, plus the bot reporting tools.')
    expect(text).toContain('do not request approval for them: transfer-funds')
    expect(workerInstruction(bot, ticket, [], { botName: 'planner', ticketId: brandString<TicketId>('ticket-0') }))
      .toContain('handed off from ticket ticket-0 of bot "planner"')
  })
})

describe('stored record schemas', () => {
  it('accepts a full bot record and rejects a bad status', () => {
    const record = {
      id: 'bot-1',
      name: 'reviewer',
      job: 'Review pull requests',
      workspace: '/tmp/work',
      routerSession: 'router-1',
      status: 'active',
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    }
    expect(botRecordSchema.safeParse(record).success).toBe(true)
    expect(botRecordSchema.safeParse({ ...record, status: 'sleeping' }).success).toBe(false)
  })

  it('rejects an unknown ticket stage', () => {
    const record = {
      id: 'ticket-1',
      botId: 'bot-1',
      title: 'Review #12',
      instruction: 'Review the diff.',
      stage: 'working',
      routerSession: 'router-1',
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
    }
    expect(ticketRecordSchema.safeParse(record).success).toBe(true)
    expect(ticketRecordSchema.safeParse({ ...record, stage: 'done' }).success).toBe(false)
  })
})

describe('bot projection', () => {
  const event = (seq: number): number => seq

  it('folds the bot, its ticket, and the report stage', () => {
    const call = (seq: number, callId: string, name: string, args: unknown) => ({
      type: 'tool/call' as const,
      seq: brandNumber<SessionSeq>(seq),
      time: 0,
      data: { turn: 1, step: 1, callId: brandString<ToolCallId>(callId), name, arguments: JSON.stringify(args) },
    })
    const result = (seq: number, callId: string, value: unknown, isError = false) => ({
      type: 'tool/result' as const,
      seq: brandNumber<SessionSeq>(seq),
      time: 0,
      surfaceOp: 'append' as const,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: brandString<ToolCallId>(callId),
          content: [{ type: 'text', text: JSON.stringify(value) }],
          isError,
        }),
      },
    })
    let state: BotProjectionState = {
      inheritedEventCount: SessionLogOffset(0),
      view: { bot: null, tickets: {} },
      pending: {},
    }
    state = botProjection.apply(state, call(event(1), 'c1', 'bot_create', { name: 'reviewer', job: 'Review', workspace: '/tmp/w' }))
    state = botProjection.apply(state, result(2, 'c1', { botId: 'bot-1', name: 'reviewer', workspace: '/tmp/w' }))
    expect(state.view.bot).toEqual({ botId: 'bot-1', name: 'reviewer', workspace: '/tmp/w' })

    state = botProjection.apply(state, call(event(3), 'c2', 'bot_open_ticket', { title: 'Review #12', instruction: 'Review it.' }))
    state = botProjection.apply(state, result(4, 'c2', { ticketId: 'ticket-1', stage: 'working', workerSession: 'worker-1' }))
    expect(state.view.tickets['ticket-1']).toMatchObject({ title: 'Review #12', stage: 'working', workerSession: 'worker-1' })

    state = botProjection.apply(state, call(event(5), 'c3', 'bot_report', { ticket_id: 'ticket-1', stage: 'ready', summary: 'Done.' }))
    state = botProjection.apply(state, result(6, 'c3', { ticketId: 'ticket-1', stage: 'ready' }))
    expect(state.view.tickets['ticket-1']).toMatchObject({ stage: 'ready', summary: 'Done.' })

    // A worker reports from its own Session; the notice it sends here carries the stage.
    state = botProjection.apply(state, {
      type: 'user/message',
      seq: brandNumber<SessionSeq>(7),
      time: 0,
      surfaceOp: 'append',
      data: createUserMessage({
        content: [{ type: 'text', text: 'Ticket "Review #12" is blocked: Need input.' }],
        source: {
          kind: 'bot',
          botId: brandString<BotId>('bot-1'),
          ticketId: brandString<TicketId>('ticket-1'),
          form: 'notice',
          summary: 'Need input.',
          stage: 'blocked',
        },
      }),
    })
    expect(state.view.tickets['ticket-1']).toMatchObject({ stage: 'blocked', summary: 'Need input.' })

    state = botProjection.apply(state, call(event(8), 'c4', 'bot_archive', {}))
    state = botProjection.apply(state, result(9, 'c4', { name: 'reviewer', archivedTickets: 1 }))
    expect(state.view).toEqual({ bot: null, tickets: {} })
  })

  it('ignores a failed result and an unrelated call', () => {
    const state: BotProjectionState = {
      inheritedEventCount: SessionLogOffset(0),
      view: { bot: null, tickets: {} },
      pending: {},
    }
    const call = {
      type: 'tool/call' as const,
      seq: brandNumber<SessionSeq>(1),
      time: 0,
      data: {
        turn: 1,
        step: 1,
        callId: brandString<ToolCallId>('c1'),
        name: 'bot_create',
        arguments: JSON.stringify({ name: 'reviewer', job: 'Review', workspace: '/tmp/w' }),
      },
    }
    const pending = botProjection.apply(state, call)
    const failed = {
      type: 'tool/result' as const,
      seq: brandNumber<SessionSeq>(2),
      time: 0,
      surfaceOp: 'append' as const,
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: brandString<ToolCallId>('c1'),
          content: [{ type: 'text', text: '{"error":"nope"}' }],
          isError: true,
        }),
      },
    }
    expect(botProjection.apply(pending, failed).view.bot).toBeNull()
  })
})
