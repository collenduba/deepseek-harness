import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import BotRegistry, { botProjection, botRecordSchema, memoryRecordSchema, ticketRecordSchema, workerInstruction } from '../src/index.ts'
import type { BotId, BotMemoryId, BotProjectionState, TicketId } from '../src/index.ts'

const ROUTER = brandString<SessionId>('router-1')
const WORKER = brandString<SessionId>('worker-1')

/** Boot a context with real storage, the bot registry, and fake peer services. */
async function harness() {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain' as string, facility)
  const followups: string[] = []
  ctx.provide('tools' as string, { register: () => () => {} })
  ctx.provide('agents' as string, {
    create: async () => ({
      agent: { session: { id: WORKER }, followup: () => {} },
      dispose: async () => {},
    }),
    get: () => ({ followup: (message: { content: { type: string; text: string }[] }) => {
      followups.push(message.content[0]?.text ?? '')
    } }),
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
  await ctx.plugin(BotRegistry)
  return { ctx, followups }
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
    await ctx.bots.openTicket({ routerSession: ROUTER, title: 'Review #12', instruction: 'Review the diff.' })
    await ctx.bots.remember(bot.id, 'The repo uses pnpm.')
    const archived = await ctx.bots.archive(bot.id)
    expect(archived).toEqual({ name: 'reviewer', archivedTickets: 1 })
    expect(ctx.bots.list()).toEqual([])
    expect(ctx.bots.ticketsOf(bot.id)).toEqual([])
    expect(ctx.bots.memoriesOf(bot.id)).toEqual([])
    await expect(ctx.bots.archive(bot.id)).rejects.toThrow(/unknown bot/)
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
    const text = workerInstruction(bot, ticket, [memory])
    expect(text).toContain('ticket-1')
    expect(text).toContain('Review the diff and report.')
    expect(text).toContain('bot_report')
    expect(text).toContain('Run the unit tests before opening a pull request.')
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
