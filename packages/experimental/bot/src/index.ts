/**
 * Durable bots (`ctx.bots`): bot records, tickets, worker launch, and the four
 * model tools that drive them. A bot is a record, not a Session; the Session
 * that creates it becomes its router, and each ticket runs in its own worker
 * Session.
 * @module @deepseek-ai/dsh-bot
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-title'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { botProjection } from './projection.ts'
import { botDomainSpec } from './spec.ts'
import type {
  BotId,
  BotRecord,
  CreateBotInput,
  OpenTicketInput,
  BotMemoryId,
  BotMemoryRecord,
  TicketId,
  TicketRecord,
  TicketReport,
  TicketStage,
} from './types.ts'
import { launchWorker } from './worker.ts'

export * from './types.ts'
export { botDomainSpec, botRecordSchema, memoryRecordSchema, ticketRecordSchema } from './spec.ts'
export { botProjection } from './projection.ts'
export type { BotProjectionState, BotView } from './projection.ts'
export { launchWorker, workerInstruction } from './worker.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    bots: BotRegistry
  }
}

/** Current time as the ISO-8601 string every stored timestamp uses. */
function now(): string {
  return new Date().toISOString()
}

/** Require one non-empty, trimmed string from tool input. */
function requireText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '') throw new TypeError(`${field} must be a non-empty string`)
  return trimmed
}

/**
 * Durable bot registry and ticket runtime.
 *
 * The service opens the `bot` domain during initialization, then registers the
 * four `bot_*` tools as effects of its own fiber. Every mutation is a table
 * write; reads are synchronous from the validated in-memory domain state.
 */
export class BotRegistry extends Service {
  static inject = [
    'storageDomain',
    'tools',
    'agents',
    'agentDefaultModel',
    'sessionTitle',
    'sessionProjections',
    'workspaceRegistry',
  ]

  private botsTable!: KvTable<BotId, BotRecord>
  private ticketsTable!: KvTable<TicketId, TicketRecord>
  private memoriesTable!: KvTable<BotMemoryId, BotMemoryRecord>

  constructor(ctx: Context) {
    super(ctx, 'bots')
  }

  /** Open the domain and register the model tools. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(botDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'bot.domainClose')
    this.botsTable = domain.table('bots')
    this.ticketsTable = domain.table('tickets')
    this.memoriesTable = domain.table('memories')
    await this.ctx.sessionProjections.register(botProjection)
    this.ctx.effect(() => this.registerTools(), 'bot.tools')
  }

  /**
   * Bind a bot to the Session that creates it.
   * @param input - name, job, workspace, and the owning router Session.
   * @returns the stored record.
   */
  async create(input: CreateBotInput): Promise<BotRecord> {
    const name = requireText(input.name, 'name')
    const job = requireText(input.job, 'job')
    const workspace = requireText(input.workspace, 'workspace')
    if (!isAbsolute(workspace)) throw new TypeError(`workspace must be absolute, got '${workspace}'`)
    const preset = input.preset === undefined ? undefined : requireText(input.preset, 'preset')
    for (const [, bot] of this.botsTable.entries()) {
      if (String(bot.routerSession) !== String(input.routerSession)) continue
      if (bot.name === name) throw new Error(`this Session already owns a bot named '${name}'`)
    }
    const timestamp = now()
    const record: BotRecord = {
      id: brandString<BotId>(`bot-${randomUUID()}`),
      name,
      job,
      workspace,
      routerSession: input.routerSession,
      ...(preset === undefined ? {} : { preset }),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.botsTable.put(record.id, record)
    return record
  }

  /**
   * The bot that owns a Session, when one exists.
   * @param session - router Session id.
   * @returns the bot record, or `undefined`.
   */
  findByRouter(session: SessionId): BotRecord | undefined {
    for (const [, bot] of this.botsTable.entries()) {
      if (String(bot.routerSession) === String(session)) return bot
    }
    return undefined
  }

  /** Every bot, oldest first. */
  list(): BotRecord[] {
    return [...this.botsTable.entries()].map(([, bot]) => bot)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  /**
   * Open a ticket for a direct request and launch its worker.
   *
   * A failed launch keeps the ticket and marks it `failed`; the caller still
   * receives the failure, and the panel can show what happened.
   *
   * @param input - the owning Session, a title, and the instruction.
   * @returns the launched ticket.
   */
  async openTicket(input: OpenTicketInput): Promise<TicketRecord> {
    const bot = this.findByRouter(input.routerSession)
    if (bot === undefined) throw new Error('no bot is bound to this Session; call bot_create first')
    if (bot.status !== 'active') throw new Error(`bot '${bot.name}' is paused`)
    const title = requireText(input.title, 'title')
    const instruction = requireText(input.instruction, 'instruction')
    const timestamp = now()
    const ticket: TicketRecord = {
      id: brandString<TicketId>(`ticket-${randomUUID()}`),
      botId: bot.id,
      title,
      instruction,
      stage: 'queued',
      routerSession: input.routerSession,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.ticketsTable.put(ticket.id, ticket)
    try {
      const workerSession = await launchWorker(this.ctx, bot, ticket, this.memoriesOf(bot.id))
      return await this.ticketsTable.update(ticket.id, current => ({
        ...current,
        stage: 'working',
        workerSession,
        updatedAt: now(),
      }))
    } catch (error: unknown) {
      this.ctx.logger.warn(`bot: worker launch for ticket '${ticket.id}' failed: ${String(error)}`)
      const failed = await this.ticketsTable.update(ticket.id, current => ({
        ...current,
        stage: 'failed',
        summary: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      }))
      return failed
    }
  }

  /**
   * Record a worker's report on its ticket and notify the router Session.
   * @param session - the reporting worker Session.
   * @param ticketId - the ticket the report is about.
   * @param report - stage and one-line summary.
   * @returns the updated ticket.
   */
  async report(session: SessionId, ticketId: TicketId, report: TicketReport): Promise<TicketRecord> {
    const ticket = this.ticketsTable.get(ticketId)
    if (ticket === undefined) throw new Error(`unknown ticket '${ticketId}'`)
    if (ticket.workerSession === undefined || String(ticket.workerSession) !== String(session)) {
      throw new Error(`only the worker Session of ticket '${ticketId}' can report on it`)
    }
    const summary = requireText(report.summary, 'summary')
    const updated = await this.ticketsTable.update(ticketId, current => ({
      ...current,
      stage: report.stage,
      summary,
      updatedAt: now(),
    }))
    this.notifyRouter(ticket, report.stage, summary)
    return updated
  }

  /**
   * Remove one bot and every ticket it opened. Records disappear; the worker
   * Sessions and their directories stay, because this is not a data-erasure
   * operation.
   * @param botId - the bot to archive.
   * @returns the archived bot's name and ticket count.
   */
  async archive(botId: BotId): Promise<{ name: string; archivedTickets: number }> {
    const bot = this.botsTable.get(botId)
    if (bot === undefined) throw new Error(`unknown bot '${botId}'`)
    const archivedTickets = await this.ticketsTable.deleteMany(this.ticketsOf(botId).map(ticket => ticket.id))
    await this.memoriesTable.deleteMany(this.memoriesOf(botId).map(memory => memory.id))
    await this.botsTable.delete(botId)
    return { name: bot.name, archivedTickets }
  }

  /**
   * Notes one bot keeps across tickets, newest first.
   * @param botId - the owning bot.
   * @returns matching notes.
   */
  memoriesOf(botId: BotId): BotMemoryRecord[] {
    return [...this.memoriesTable.entries()]
      .filter(([, memory]) => String(memory.botId) === String(botId))
      .map(([, memory]) => memory)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * Write one durable note for a bot.
   * @param botId - the bot the note belongs to.
   * @param text - the note, one fact or rule.
   * @param sourceTicket - the ticket whose worker wrote it, when a worker did.
   * @returns the stored note.
   */
  async remember(botId: BotId, text: string, sourceTicket?: TicketId): Promise<BotMemoryRecord> {
    const bot = this.botsTable.get(botId)
    if (bot === undefined) throw new Error(`unknown bot '${botId}'`)
    const note = requireText(text, 'text')
    const record: BotMemoryRecord = {
      id: brandString<BotMemoryId>(`memory-${randomUUID()}`),
      botId,
      text: note,
      createdAt: now(),
      ...(sourceTicket === undefined ? {} : { sourceTicket }),
    }
    await this.memoriesTable.put(record.id, record)
    return record
  }

  /**
   * The ticket a worker Session is running, when one exists.
   * @param session - worker Session id.
   * @returns the ticket, or `undefined`.
   */
  ticketOfWorker(session: SessionId): TicketRecord | undefined {
    for (const [, ticket] of this.ticketsTable.entries()) {
      if (ticket.workerSession !== undefined && String(ticket.workerSession) === String(session)) return ticket
    }
    return undefined
  }

  /**
   * Tickets of one bot, newest first.
   * @param botId - the owning bot.
   * @returns matching tickets.
   */
  ticketsOf(botId: BotId): TicketRecord[] {
    return [...this.ticketsTable.entries()]
      .filter(([, ticket]) => String(ticket.botId) === String(botId))
      .map(([, ticket]) => ticket)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /** Send one notice to the router Session, ignoring an offline router. */
  private notifyRouter(ticket: TicketRecord, stage: string, summary: string): void {
    const router = this.ctx.agents.get(ticket.routerSession)
    if (router === undefined) return
    try {
      router.followup(createUserMessage({
        content: [{ type: 'text', text: `Ticket "${ticket.title}" is ${stage}: ${summary}` }],
        source: {
          kind: 'bot',
          botId: ticket.botId,
          ticketId: ticket.id,
          form: 'notice',
          summary,
          stage: stage as TicketStage,
        },
      }))
    } catch (error: unknown) {
      this.ctx.logger.warn(`bot: router notice for ticket '${ticket.id}' failed: ${String(error)}`)
    }
  }

  /** Register the four model tools and return their combined disposer. */
  private registerTools(): () => void {
    const ctx = this.ctx
    const disposers = [
      this.ctx.tools.register(defineTool({
        name: 'bot_create',
        description: 'Create a durable bot in this conversation. The conversation becomes the bot\'s router: it receives the bot\'s ticket reports. Use bot_open_ticket to give the bot work.',
        parameters: {
          name: { type: 'string', required: true, description: 'Short display name, such as reviewer.' },
          job: { type: 'string', required: true, description: 'What the bot is for, in one sentence.' },
          workspace: { type: 'string', required: true, description: 'Absolute directory the bot\'s workers run in.' },
          preset: { type: 'string', description: 'Optional worker agent preset id. Omit to use the deployment default.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              botId: { type: 'string', required: true },
              name: { type: 'string', required: true },
              workspace: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_create requires a calling agent')
          const bot = await ctx.bots.create({
            name: args.name,
            job: args.job,
            workspace: args.workspace,
            ...(args.preset === undefined ? {} : { preset: args.preset }),
            routerSession: exec.agent.session.id,
          })
          return { botId: bot.id, name: bot.name, workspace: bot.workspace }
        },
        presentCall: args => ({ card: 'generic', title: 'bot_create', rawInput: args }),
      })),

      this.ctx.tools.register(defineTool({
        name: 'bot_list',
        description: 'List the bots in this deployment with their open ticket counts.',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              bots: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    botId: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    job: { type: 'string', required: true },
                    workspace: { type: 'string', required: true },
                    openTickets: { type: 'number', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: () => Promise.resolve({
          bots: ctx.bots.list().map(bot => ({
            botId: bot.id,
            name: bot.name,
            job: bot.job,
            workspace: bot.workspace,
            openTickets: ctx.bots.ticketsOf(bot.id)
              .filter(ticket => ticket.stage !== 'ready' && ticket.stage !== 'failed').length,
          })),
        }),
        presentCall: args => ({ card: 'generic', title: 'bot_list', rawInput: args }),
      })),

      this.ctx.tools.register(defineTool({
        name: 'bot_open_ticket',
        description: 'Give this conversation\'s bot one unit of work. A worker Session runs the instruction and reports back here. Use this when the request is concrete enough to execute without further questions.',
        parameters: {
          title: { type: 'string', required: true, description: 'Short title for the work, shown in the panel.' },
          instruction: { type: 'string', required: true, description: 'The complete instruction the worker executes, including every fact it needs.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ticketId: { type: 'string', required: true },
              stage: { type: 'string', required: true },
              workerSession: { type: 'string' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_open_ticket requires a calling agent')
          const ticket = await ctx.bots.openTicket({
            routerSession: exec.agent.session.id,
            title: args.title,
            instruction: args.instruction,
          })
          return {
            ticketId: ticket.id,
            stage: ticket.stage,
            ...(ticket.workerSession === undefined ? {} : { workerSession: ticket.workerSession }),
          }
        },
        presentCall: args => ({ card: 'generic', title: 'bot_open_ticket', rawInput: args }),
      })),


      this.ctx.tools.register(defineTool({
        name: 'bot_archive',
        description: 'Remove a bot and every ticket it opened. Worker Sessions and their directories stay. Omit bot_id to archive the bot bound to this conversation.',
        parameters: {
          bot_id: { type: 'string', description: 'Bot id from bot_list. Omit to archive this conversation\'s bot.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              archivedTickets: { type: 'number', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_archive requires a calling agent')
          const botId = args.bot_id !== undefined
            ? brandString<BotId>(args.bot_id)
            : ctx.bots.findByRouter(exec.agent.session.id)?.id
          if (botId === undefined) throw new Error('no bot is bound to this Session; pass bot_id')
          return await ctx.bots.archive(botId)
        },
        presentCall: args => ({ card: 'generic', title: 'bot_archive', rawInput: args }),
      })),

      this.ctx.tools.register(defineTool({
        name: 'bot_remember',
        description: 'Keep one durable note for this bot, such as a standing rule, a repository fact, or a preference. Every later worker for this bot reads the notes. Call it from the bot\'s conversation or from a ticket worker.',
        parameters: {
          text: { type: 'string', required: true, description: 'One fact or rule, stated completely in one or two sentences.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              botId: { type: 'string', required: true },
              memoryId: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_remember requires a calling agent')
          const session = exec.agent.session.id
          const workerTicket = ctx.bots.ticketOfWorker(session)
          const bot = ctx.bots.findByRouter(session)
            ?? (workerTicket === undefined
              ? undefined
              : ctx.bots.list().find(candidate => String(candidate.id) === String(workerTicket.botId)))
          if (bot === undefined) throw new Error('no bot is bound to this Session or its ticket')
          const memory = await ctx.bots.remember(bot.id, args.text, workerTicket?.id)
          return { botId: bot.id, memoryId: memory.id }
        },
        presentCall: args => ({ card: 'generic', title: 'bot_remember', rawInput: args }),
      })),
      this.ctx.tools.register(defineTool({
        name: 'bot_report',
        description: 'Report the outcome of the ticket you are working on. Only the ticket\'s worker Session may call this. Include one line the requester can read without opening your Session.',
        parameters: {
          ticket_id: { type: 'string', required: true, description: 'The ticket id from your instructions.' },
          stage: { type: 'string', required: true, enum: ['waiting', 'ready', 'blocked', 'failed'], description: 'ready when done, waiting when a person must answer, blocked when outside your control, failed when you cannot finish.' },
          summary: { type: 'string', required: true, description: 'One line naming the result or the question.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ticketId: { type: 'string', required: true },
              stage: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_report requires a calling agent')
          const ticket = await ctx.bots.report(
            exec.agent.session.id,
            brandString<TicketId>(args.ticket_id),
            { stage: args.stage, summary: args.summary },
          )
          return { ticketId: ticket.id, stage: ticket.stage }
        },
        presentCall: args => ({ card: 'generic', title: 'bot_report', rawInput: args }),
      })),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }
}

export default BotRegistry
