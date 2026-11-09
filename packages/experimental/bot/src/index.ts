/**
 * Durable bots (`ctx.bots`): bot records, tickets, worker launch, and the four
 * model tools that drive them. A bot is a record, not a Session; the Session
 * that creates it becomes its router, and each ticket runs in its own worker
 * Session.
 * @module @deepseek-ai/dsh-bot
 */

import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { Context, Service } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-title'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import { botProjection } from './projection.ts'
import { botDomainSpec } from './spec.ts'
import type {
  BotId,
  BotRecord,
  CreateBotInput,
  OpenTicketInput,
  BotApprovalId,
  BotApprovalRecord,
  BotApprovalStatus,
  BotMemoryId,
  BotMemoryRecord,
  BotNoticeId,
  BotNoticeRecord,
  TicketId,
  TicketRecord,
  TicketReport,
  TicketStage,
} from './types.ts'
import { launchWorker } from './worker.ts'

export * from './types.ts'
export { approvalRecordSchema, botDomainSpec, botRecordSchema, memoryRecordSchema, noticeRecordSchema, ticketRecordSchema } from './spec.ts'
export { botProjection } from './projection.ts'
export type { BotProjectionState, BotView } from './projection.ts'
export { launchWorker, workerInstruction } from './worker.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    bots: BotRegistry
  }
}

/** Deployment attention policy for router notices. */
export interface BotAttentionConfig {
  /** Local quiet hours as `HH:MM-HH:MM`; empty disables holding. */
  quietHours: string
  /** Minutes between digests of held notices. */
  digestMinutes: number
  /** Deny guarded tools in ticket workers until an approval covers the exact command. */
  enforceApprovals: boolean
  /** Tool names the approval gate protects. */
  guardedTools: string[]
  /** Hold result notices (ready, waiting) for the next digest instead of delivering them immediately. */
  holdResults: boolean
  /** Worker Sessions one bot may run at once; extra tickets wait in `queued`. */
  maxWorkersPerBot: number
  /** Deepest handoff chain a ticket may belong to. */
  maxHandoffDepth: number
  /** Minutes one worker may run before it is cancelled; 0 disables the budget. */
  workerTimeoutMinutes: number
}

/** A resolved quiet window, in local minutes since midnight. */
export interface QuietWindow {
  readonly start: number
  readonly end: number
}

/**
 * Parse quiet hours.
 * @param value - `HH:MM-HH:MM`, or an empty string.
 * @returns the window, or undefined when disabled.
 * @throws when the text is not a valid range.
 */
export function parseQuietHours(value: string): QuietWindow | undefined {
  if (value.trim() === '') return undefined
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value.trim())
  if (match === null) throw new TypeError(`quietHours must be HH:MM-HH:MM, got '${value}'`)
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  if (start > 1439 || end > 1439) throw new TypeError(`quietHours is outside a day: '${value}'`)
  return { start, end }
}

/**
 * Whether a local time falls inside a quiet window.
 * @param window - the window, or undefined when disabled.
 * @param at - local time to test.
 * @returns true when the time is quiet.
 */
export function isQuietAt(window: QuietWindow | undefined, at: Date): boolean {
  if (window === undefined) return false
  const minutes = at.getHours() * 60 + at.getMinutes()
  return window.start <= window.end
    ? minutes >= window.start && minutes < window.end
    : minutes >= window.start || minutes < window.end
}

/**
 * Decide whether one tool call is guarded and whether an approved command covers it.
 * @param guardedTools - tool names the gate protects.
 * @param approvedCommands - payloads of approved requests for this ticket.
 * @param exec - the pending call's name and parsed arguments.
 * @returns whether the call is guarded, its command, and whether approval covers it.
 */
export function requireApproval(
  guardedTools: readonly string[],
  approvedCommands: ReadonlySet<string>,
  exec: { readonly name: string; readonly arguments: unknown },
): { readonly required: boolean; readonly approved: boolean; readonly command?: string } {
  if (!guardedTools.includes(exec.name)) return { required: false, approved: false }
  const record = exec.arguments
  const command = record !== null && typeof record === 'object' && !Array.isArray(record)
    ? (record as Record<string, unknown>)['command']
    : undefined
  if (typeof command !== 'string') return { required: true, approved: false }
  return { required: true, approved: approvedCommands.has(command), command }
}

/** Tools every bot worker keeps regardless of its allowlist. */
export const BOT_PROTOCOL_TOOLS: readonly string[] = [
  'bot_handoff',
  'bot_remember',
  'bot_report',
  'bot_request_approval',
]

/**
 * Whether a bot's worker may call one tool.
 * @param granted - the bot's allowlist; undefined means every tool.
 * @param toolName - the tool being called.
 * @returns true when the call is allowed.
 */
export function capabilityAllows(granted: readonly string[] | undefined, toolName: string): boolean {
  if (granted === undefined) return true
  return granted.includes(toolName) || BOT_PROTOCOL_TOOLS.includes(toolName)
}

/**
 * Whether an action is on the bot's hard floor.
 * @param actions - the bot's floor; undefined means no floor.
 * @param action - action name from a request.
 * @returns true when a person must perform the action.
 */
export function isHardFloor(actions: readonly string[] | undefined, action: string): boolean {
  return actions?.includes(action) ?? false
}

/**
 * The first pattern that denies one shell command.
 * @param patterns - case-insensitive regular expressions; undefined allows every command.
 * @param command - the shell command the worker wants to run.
 * @returns the matching pattern, or undefined when the command is allowed.
 */
export function blockedCommand(patterns: readonly string[] | undefined, command: string): string | undefined {
  if (patterns === undefined) return undefined
  return patterns.find(pattern => new RegExp(pattern, 'i').test(command))
}

/** The `command` argument of a shell tool call, when it carries one. */
function shellCommand(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as Record<string, unknown>).command
  return typeof command === 'string' ? command : undefined
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

  /** Deployment attention policy. */
  static Config: z<BotAttentionConfig> = z.object({
    quietHours: z.string().default('').description('Local quiet hours as HH:MM-HH:MM; empty disables holding.'),
    digestMinutes: z.natural().min(1).max(720).default(5).description('Minutes between digests of held notices.'),
    enforceApprovals: z.boolean().default(false)
      .description('Deny guarded tools in ticket workers until an approval covers the exact command.'),
    guardedTools: z.array(z.string()).default(['bash', 'pwsh'])
      .description('Tool names the approval gate protects.'),
    holdResults: z.boolean().default(false)
      .description('Hold ready and waiting notices for the next digest instead of delivering them immediately.'),
    maxWorkersPerBot: z.natural().min(1).max(16).default(2)
      .description('Worker Sessions one bot may run at once; extra tickets wait in queued.'),
    maxHandoffDepth: z.natural().max(10).default(3)
      .description('Deepest handoff chain a ticket may belong to.'),
    workerTimeoutMinutes: z.natural().max(720).default(30)
      .description('Minutes a worker turn may run before it is cancelled; an answer restarts the clock, and 0 disables the budget.'),
  })

  private botsTable!: KvTable<BotId, BotRecord>
  private ticketsTable!: KvTable<TicketId, TicketRecord>
  private memoriesTable!: KvTable<BotMemoryId, BotMemoryRecord>
  private approvalsTable!: KvTable<BotApprovalId, BotApprovalRecord>
  private noticesTable!: KvTable<BotNoticeId, BotNoticeRecord>
  private readonly quietWindow: QuietWindow | undefined
  private readonly digestMinutes: number
  private readonly enforceApprovals: boolean
  private readonly guardedTools: readonly string[]
  private readonly holdResults: boolean
  private readonly maxWorkersPerBot: number
  private readonly maxHandoffDepth: number
  private readonly workerTimeoutMinutes: number
  private readonly budgets = new Map<TicketId, ReturnType<typeof setTimeout>>()
  private reconciling = false
  private readonly pumping = new Set<BotId>()
  private readonly pumpPending = new Set<BotId>()

  constructor(ctx: Context, config: Partial<BotAttentionConfig> = {}) {
    super(ctx, 'bots')
    this.quietWindow = parseQuietHours(config.quietHours ?? '')
    this.digestMinutes = config.digestMinutes ?? 5
    this.enforceApprovals = config.enforceApprovals ?? false
    this.guardedTools = config.guardedTools ?? ['bash', 'pwsh']
    this.holdResults = config.holdResults ?? false
    this.maxWorkersPerBot = config.maxWorkersPerBot ?? 2
    this.maxHandoffDepth = config.maxHandoffDepth ?? 3
    this.workerTimeoutMinutes = config.workerTimeoutMinutes ?? 30
  }

  /** Open the domain and register the model tools. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(botDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'bot.domainClose')
    this.ctx.effect(() => () => {
      for (const timer of this.budgets.values()) clearTimeout(timer)
      this.budgets.clear()
    }, 'bot.budgets')
    this.botsTable = domain.table('bots')
    this.ticketsTable = domain.table('tickets')
    this.memoriesTable = domain.table('memories')
    this.approvalsTable = domain.table('approvals')
    this.noticesTable = domain.table('notices')
    this.ctx.effect(() => {
      const timer = setInterval(() => { void this.flushNotices() }, this.digestMinutes * 60_000)
      return () => { clearInterval(timer) }
    }, 'bot.attention')
    await this.ctx.sessionProjections.register(botProjection)
    this.ctx.effect(
      () => this.ctx.on('tools/pre-execute', (exec, next) => this.guard(exec, next)),
      'bot.approvalGate',
    )
    this.ctx.effect(() => this.registerTools(), 'bot.tools')
    queueMicrotask(() => {
      void this.reconcile().catch((error: unknown) => {
        this.ctx.logger.warn(`bot: startup reconciliation failed: ${String(error)}`)
      })
      void this.pumpWhenReady().catch((error: unknown) => {
        this.ctx.logger.warn(`bot: startup pump failed: ${String(error)}`)
      })
    })
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
    const tools = input.tools === undefined ? undefined : input.tools.map(tool => requireText(tool, 'tools'))
    const hardFloor = input.hardFloor === undefined ? undefined : input.hardFloor.map(action => requireText(action, 'hardFloor'))
    const blockedCommands = input.blockedCommands === undefined
      ? undefined
      : input.blockedCommands.map((entry) => {
        const pattern = requireText(entry, 'blockedCommands')
        try {
          new RegExp(pattern, 'i')
        } catch {
          throw new Error(`blockedCommands pattern is not a valid regular expression: ${pattern}`)
        }
        return pattern
      })
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
      ...(tools === undefined ? {} : { tools }),
      ...(hardFloor === undefined ? {} : { hardFloor }),
      ...(blockedCommands === undefined ? {} : { blockedCommands }),
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
    return await this.createTicket(bot, input.title, input.instruction, undefined, input.workspace)
  }

  /**
   * Hand one unit of work to another bot and link the new ticket to its source.
   * @param fromTicketId - the ticket whose worker delegates.
   * @param targetName - name of an active bot.
   * @param title - short title for the new ticket.
   * @param instruction - the instruction the target worker runs.
   * @returns the new ticket.
   */
  async handoff(fromTicketId: TicketId, targetName: string, title: string, instruction: string): Promise<TicketRecord> {
    const source = this.ticketsTable.get(fromTicketId)
    if (source === undefined) throw new Error(`unknown ticket '${fromTicketId}'`)
    const sourceBot = this.botsTable.get(source.botId)
    if (sourceBot === undefined) throw new Error(`unknown bot '${source.botId}'`)
    const candidates = this.list().filter(bot => bot.name === targetName && bot.status === 'active')
    const [target] = candidates
    if (target === undefined) throw new Error(`no active bot named '${targetName}'`)
    if (candidates.length > 1) throw new Error(`more than one active bot is named '${targetName}'`)
    if (String(target.id) === String(source.botId)) throw new Error('cannot hand off to the same bot')
    const depth = (source.handoffDepth ?? 0) + 1
    if (depth > this.maxHandoffDepth) {
      throw new Error(`handoff depth ${depth} exceeds the configured maximum ${this.maxHandoffDepth}`)
    }
    return await this.createTicket(target, title, instruction, { ticket: source, bot: sourceBot, depth })
  }

  /** Create a ticket for one bot, then launch it when a worker slot is free. */
  private async createTicket(
    bot: BotRecord,
    titleInput: string,
    instructionInput: string,
    parent?: { readonly ticket: TicketRecord; readonly bot: BotRecord; readonly depth: number },
    workspaceInput?: string,
  ): Promise<TicketRecord> {
    const title = requireText(titleInput, 'title')
    const instruction = requireText(instructionInput, 'instruction')
    const workspace = workspaceInput === undefined ? undefined : requireText(workspaceInput, 'workspace')
    if (workspace !== undefined && !isAbsolute(workspace)) {
      throw new Error(`ticket workspace must be an absolute path: ${workspace}`)
    }
    const timestamp = now()
    const ticket: TicketRecord = {
      id: brandString<TicketId>(`ticket-${randomUUID()}`),
      botId: bot.id,
      title,
      instruction,
      stage: 'queued',
      routerSession: bot.routerSession,
      ...(workspace === undefined ? {} : { workspace }),
      ...(parent === undefined
        ? {}
        : { parentTicket: parent.ticket.id, parentBotName: parent.bot.name, handoffDepth: parent.depth }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.ticketsTable.put(ticket.id, ticket)
    if (this.activeWorkers(bot.id) >= this.maxWorkersPerBot) return ticket
    return await this.launchTicket(bot, ticket)
  }

  /** Worker Sessions currently holding a slot for one bot. */
  private activeWorkers(botId: BotId): number {
    return [...this.ticketsTable.entries()]
      .filter(([, ticket]) => String(ticket.botId) === String(botId)
        && (ticket.stage === 'working' || ticket.stage === 'waiting'))
      .length
  }

  /** Launch one queued ticket and record the outcome. */
  private async launchTicket(bot: BotRecord, ticket: TicketRecord): Promise<TicketRecord> {
    const origin = ticket.parentTicket === undefined || ticket.parentBotName === undefined
      ? undefined
      : { botName: ticket.parentBotName, ticketId: ticket.parentTicket }
    try {
      const workerSession = await launchWorker(this.ctx, bot, ticket, this.memoriesOf(bot.id), origin)
      const launched = await this.ticketsTable.update(ticket.id, current => ({
        ...current,
        stage: 'working',
        workerSession,
        updatedAt: now(),
      }))
      this.armBudget(ticket.id)
      return launched
    } catch (error: unknown) {
      this.ctx.logger.warn(`bot: worker launch for ticket '${ticket.id}' failed: ${String(error)}`)
      return await this.ticketsTable.update(ticket.id, current => ({
        ...current,
        stage: 'failed',
        summary: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      }))
    }
  }

  /** Launch queued tickets for one bot while it has free slots. */
  private async pumpQueue(botId: BotId): Promise<void> {
    const bot = this.botsTable.get(botId)
    if (bot === undefined || bot.status !== 'active') return
    if (this.pumping.has(botId)) {
      this.pumpPending.add(botId)
      return
    }
    this.pumping.add(botId)
    try {
      do {
        this.pumpPending.delete(botId)
        let active = this.activeWorkers(botId)
        const queued = [...this.ticketsTable.entries()]
          .map(([, ticket]) => ticket)
          .filter(ticket => String(ticket.botId) === String(botId) && ticket.stage === 'queued')
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        for (const ticket of queued) {
          if (active >= this.maxWorkersPerBot) break
          const launched = await this.launchTicket(bot, ticket)
          if (launched.stage === 'working') active += 1
        }
      } while (this.pumpPending.has(botId))
    } finally {
      this.pumping.delete(botId)
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
    if (report.stage === 'ready' || report.stage === 'failed' || report.stage === 'blocked') {
      this.clearBudget(ticketId)
    }
    await this.notifyRouter(ticket, report.stage, summary)
    if (report.stage === 'ready' || report.stage === 'failed' || report.stage === 'blocked') {
      await this.pumpQueue(ticket.botId)
    }
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
    const tickets = this.ticketsOf(botId)
    for (const ticket of tickets) this.clearBudget(ticket.id)
    const archivedTickets = await this.ticketsTable.deleteMany(tickets.map(ticket => ticket.id))
    await this.memoriesTable.deleteMany(this.memoriesOf(botId).map(memory => memory.id))
    await this.approvalsTable.deleteMany(this.approvalsOf(botId).map(approval => approval.id))
    await this.noticesTable.deleteMany(this.noticesOf(botId).map(notice => notice.id))
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
   * The tool gate: a guarded shell command in a ticket worker needs an approved
   * request whose payload is exactly that command.
   */
  private async guard(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
    if (exec.agent === undefined) return await next()
    const ticket = this.ticketOfWorker(exec.agent.session.id)
    if (ticket === undefined) return await next()
    const owner = this.botsTable.get(ticket.botId)
    if (owner !== undefined && !capabilityAllows(owner.tools, exec.name)) {
      return {
        kind: 'deny',
        reason: `This bot grants only ${(owner.tools ?? []).join(', ')}, plus its reporting tools.`,
      }
    }
    if (owner !== undefined && this.guardedTools.includes(exec.name)) {
      const command = shellCommand(exec.arguments)
      const pattern = command === undefined ? undefined : blockedCommand(owner.blockedCommands, command)
      if (pattern !== undefined) {
        return { kind: 'deny', reason: `This bot blocks shell commands matching /${pattern}/i.` }
      }
    }
    if (!this.enforceApprovals) return await next()
    const approvals = this.approvalsOf(ticket.botId).filter(approval => String(approval.ticketId) === String(ticket.id))
    const approved = new Set(approvals.filter(approval => approval.status === 'approved').map(approval => approval.payload))
    const decision = requireApproval(this.guardedTools, approved, { name: exec.name, arguments: exec.arguments })
    if (!decision.required || decision.approved) return await next()
    return {
      kind: 'deny',
      reason: decision.command === undefined
        ? `Tool ${exec.name} needs approval, but its arguments carry no command to approve.`
        : 'This command needs approval. Call bot_request_approval with action "shell" and this exact command as the payload, wait for bot_decide_approval, then retry.',
    }
  }

  /**
   * Notices of one bot, newest first.
   * @param botId - the owning bot.
   * @returns matching notices.
   */
  noticesOf(botId: BotId): BotNoticeRecord[] {
    return [...this.noticesTable.entries()]
      .filter(([, notice]) => String(notice.botId) === String(botId))
      .map(([, notice]) => notice)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * Deliver every held notice as one digest per conversation. Runs on the
   * configured interval and is safe to call directly.
   * @returns after every digest is sent and recorded.
   */
  async flushNotices(): Promise<void> {
    if (isQuietAt(this.quietWindow, new Date())) return
    const held = [...this.noticesTable.entries()]
      .map(([, notice]) => notice)
      .filter(notice => notice.deliveredAt === undefined)
    if (held.length === 0) return
    const byRouter = new Map<string, BotNoticeRecord[]>()
    for (const notice of held) {
      const list = byRouter.get(String(notice.routerSession)) ?? []
      list.push(notice)
      byRouter.set(String(notice.routerSession), list)
    }
    for (const list of byRouter.values()) {
      const first = list[0]
      if (first === undefined) continue
      const router = this.ctx.agents.get(first.routerSession)
      const text = `Held updates (${list.length}):\n${list.map(notice => `- ${notice.summary}`).join('\n')}`
      if (router === undefined) continue
      try {
        router.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'bot', botId: first.botId, form: 'notice', summary: `${list.length} held updates` },
        }))
      } catch (error: unknown) {
        this.ctx.logger.warn(`bot: digest for '${String(first.routerSession)}' failed: ${String(error)}`)
        continue
      }
      for (const notice of list) {
        await this.noticesTable.update(notice.id, record => ({ ...record, deliveredAt: now() }))
      }
    }
  }

  /**
   * Approval requests of one bot, newest first.
   * @param botId - the owning bot.
   * @returns matching requests.
   */
  approvalsOf(botId: BotId): BotApprovalRecord[] {
    return [...this.approvalsTable.entries()]
      .filter(([, approval]) => String(approval.botId) === String(botId))
      .map(([, approval]) => approval)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * One approval request.
   * @param id - approval identity.
   * @returns the record, or `undefined`.
   */
  approval(id: BotApprovalId): BotApprovalRecord | undefined {
    return this.approvalsTable.get(id)
  }

  /**
   * Record a worker's request and notify the bot's conversation.
   * @param ticketId - the ticket whose worker asked.
   * @param action - short name of the action, such as merge.
   * @param payload - the exact content the decision covers.
   * @returns the stored request.
   */
  async requestApproval(ticketId: TicketId, action: string, payload: string): Promise<BotApprovalRecord> {
    const ticket = this.ticketsTable.get(ticketId)
    if (ticket === undefined) throw new Error(`unknown ticket '${ticketId}'`)
    const bot = this.botsTable.get(ticket.botId)
    if (bot !== undefined && isHardFloor(bot.hardFloor, action)) {
      throw new Error(`'${action}' is on this bot's hard floor: a person must perform it, so the bot may not request approval`)
    }
    const text = requireText(payload, 'payload')
    const record: BotApprovalRecord = {
      id: brandString<BotApprovalId>(`approval-${randomUUID()}`),
      botId: ticket.botId,
      ticketId,
      action: requireText(action, 'action'),
      payload: text,
      digest: createHash('sha256').update(text).digest('hex'),
      status: 'pending',
      createdAt: now(),
    }
    await this.approvalsTable.put(record.id, record)
    await this.notify(ticket, `Approval ${record.id} requested for ticket "${ticket.title}": ${record.action}. Decide with bot_decide_approval.`, `Approval ${record.id}: ${record.action}`, 'interrupt')
    return record
  }

  /**
   * Decide a pending request and tell the worker.
   * @param id - approval identity.
   * @param decision - approved or denied.
   * @param note - optional one-line reason.
   * @returns the updated request.
   */
  async decideApproval(id: BotApprovalId, decision: Exclude<BotApprovalStatus, 'pending'>, note?: string): Promise<BotApprovalRecord> {
    const current = this.approvalsTable.get(id)
    if (current === undefined) throw new Error(`unknown approval '${id}'`)
    if (current.status !== 'pending') throw new Error(`approval '${id}' is already ${current.status}`)
    const owner = this.botsTable.get(current.botId)
    if (owner !== undefined && isHardFloor(owner.hardFloor, current.action)) {
      throw new Error(`'${current.action}' is on this bot's hard floor: a person must perform it, so this request cannot be approved`)
    }
    const updated = await this.approvalsTable.update(id, record => ({
      ...record,
      status: decision,
      decidedAt: now(),
      ...(note === undefined ? {} : { note: requireText(note, 'note') }),
    }))
    const ticket = this.ticketsTable.get(current.ticketId)
    const worker = ticket?.workerSession === undefined ? undefined : this.ctx.agents.get(ticket.workerSession)
    if (ticket === undefined || worker === undefined) return updated
    if (ticket.stage !== 'waiting' && ticket.stage !== 'working') return updated
    try {
      worker.followup(createUserMessage({
        content: [{ type: 'text', text: `Approval ${id} was ${decision}.${updated.note === undefined ? '' : ` Note: ${updated.note}`}` }],
        source: { kind: 'bot', botId: current.botId, ticketId: current.ticketId, form: 'notice', summary: `Approval ${id} ${decision}` },
      }))
      if (ticket.stage === 'waiting') {
        const resumed = await this.ticketsTable.update(current.ticketId, row =>
          row.stage === 'waiting' ? { ...row, stage: 'working', updatedAt: now() } : row)
        if (resumed.stage === 'working') this.armBudget(current.ticketId)
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`bot: approval notice for '${id}' failed: ${String(error)}`)
    }
    return updated
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

  /** Arm one ticket's worker budget. */
  private armBudget(ticketId: TicketId): void {
    this.clearBudget(ticketId)
    if (this.workerTimeoutMinutes <= 0) return
    const timer = setTimeout(() => {
      void this.expireBudget(ticketId).catch((error: unknown) => {
        this.ctx.logger.warn(`bot: worker budget for ticket '${ticketId}' failed: ${String(error)}`)
      })
    }, this.workerTimeoutMinutes * 60_000)
    this.budgets.set(ticketId, timer)
  }

  /** Drop one ticket's armed budget. */
  private clearBudget(ticketId: TicketId): void {
    const timer = this.budgets.get(ticketId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.budgets.delete(ticketId)
  }

  /** Cancel one overdue worker, report it blocked, and start the next queued ticket. */
  private async expireBudget(ticketId: TicketId): Promise<void> {
    this.budgets.delete(ticketId)
    const ticket = this.ticketsTable.get(ticketId)
    if (ticket === undefined) return
    const waited = ticket.stage === 'waiting'
    if (ticket.stage !== 'working' && !waited) return
    const summary = waited
      ? `worker waited past the ${this.workerTimeoutMinutes}-minute budget without an answer`
      : `worker exceeded the ${this.workerTimeoutMinutes}-minute budget`
    const updated = await this.ticketsTable.update(ticketId, (current) => {
      if (current.stage !== 'working' && current.stage !== 'waiting') return current
      return { ...current, stage: 'blocked', summary, updatedAt: now() }
    })
    if (updated.stage !== 'blocked' || updated.summary !== summary) return
    const committed = this.ticketsTable.get(ticketId)
    if (committed === undefined || committed.stage !== 'blocked' || committed.summary !== summary) return
    const agent = committed.workerSession === undefined ? undefined : this.ctx.agents.get(committed.workerSession)
    if (agent !== undefined && agent.status === 'running') agent.cancel({ kind: 'user' })
    await this.notifyRouter(committed, 'blocked', summary)
    await this.pumpQueue(committed.botId)
  }

  /**
   * Pump queued tickets once the preset registry is mounted, retrying briefly.
   * A fresh boot composes rows in order, so launching before the registry
   * exists would fail the launch and mark the ticket failed.
   */
  private async pumpWhenReady(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (this.ctx.get('agentPresets') !== undefined) {
        for (const bot of this.list()) {
          if (bot.status !== 'active') continue
          try {
            await this.pumpQueue(bot.id)
          } catch (error: unknown) {
            this.ctx.logger.warn(`bot: startup pump for bot '${bot.id}' failed: ${String(error)}`)
          }
        }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 1_000))
    }
  }

  /**
   * Mark workers that are no longer running as blocked, then fill free slots.
   * Runs once at startup; a live worker is re-armed with a fresh budget.
   */
  async reconcile(): Promise<void> {
    if (this.reconciling) return
    this.reconciling = true
    try {
      for (const [id, ticket] of [...this.ticketsTable.entries()]) {
        try {
          if (ticket.stage !== 'working' && ticket.stage !== 'waiting') continue
          const agent = ticket.workerSession === undefined ? undefined : this.ctx.agents.get(ticket.workerSession)
          if (agent === undefined) {
            const summary = 'worker is not running; the Host restarted or its Session ended'
            const updated = await this.ticketsTable.update(id, (current) => {
              if (current.stage !== 'working' && current.stage !== 'waiting') return current
              return { ...current, stage: 'blocked', summary, updatedAt: now() }
            })
            if (updated.stage === 'blocked' && updated.summary === summary) {
              await this.notifyRouter(updated, 'blocked', summary)
            }
            continue
          }
          this.armBudget(id)
        } catch (error: unknown) {
          this.ctx.logger.warn(`bot: startup reconciliation of ticket '${id}' failed: ${String(error)}`)
        }
      }
    } finally {
      this.reconciling = false
    }
  }

  /** Send one ticket-stage notice to the router Session, ignoring an offline router. */
  private async notifyRouter(ticket: TicketRecord, stage: string, summary: string): Promise<void> {
    const severity = stage === 'blocked' || stage === 'failed' ? 'interrupt' : 'digest'
    await this.notify(ticket, `Ticket "${ticket.title}" is ${stage}: ${summary}`, summary, severity, stage as TicketStage)
  }

  /** Record one router notice and deliver it now, unless quiet hours hold it for a digest. */
  private async notify(
    ticket: TicketRecord,
    text: string,
    summary: string,
    severity: 'interrupt' | 'digest',
    stage?: TicketStage,
  ): Promise<void> {
    const record: BotNoticeRecord = {
      id: brandString<BotNoticeId>(`notice-${randomUUID()}`),
      botId: ticket.botId,
      ticketId: ticket.id,
      routerSession: ticket.routerSession,
      text,
      summary,
      severity,
      createdAt: now(),
    }
    await this.noticesTable.put(record.id, record)
    if (isQuietAt(this.quietWindow, new Date())) return
    if (severity === 'digest' && this.holdResults) return
    const router = this.ctx.agents.get(record.routerSession)
    if (router === undefined) return
    try {
      router.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'bot',
          botId: record.botId,
          ticketId: record.ticketId,
          form: 'notice',
          summary,
          ...(stage === undefined ? {} : { stage }),
        },
      }))
    } catch (error: unknown) {
      this.ctx.logger.warn(`bot: router notice for ticket '${ticket.id}' failed: ${String(error)}`)
      return
    }
    await this.noticesTable.update(record.id, current => ({ ...current, deliveredAt: now() }))
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
          tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool names its workers may call. Omit to allow every tool.' },
          hard_floor: { type: 'array', items: { type: 'string' }, description: 'Optional action names a person must perform; the bot may never request them.' },
          blocked_commands: { type: 'array', items: { type: 'string' }, description: 'Optional case-insensitive regular expressions that deny shell commands matching them.' },
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
            ...(args.tools === undefined ? {} : { tools: args.tools }),
            ...(args.hard_floor === undefined ? {} : { hardFloor: args.hard_floor }),
            ...(args.blocked_commands === undefined ? {} : { blockedCommands: args.blocked_commands }),
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
          workspace: { type: 'string', description: 'Optional absolute working directory for this ticket\'s worker.' },
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
            ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
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
        name: 'bot_request_approval',
        description: 'Ask the bot\'s conversation to approve one consequential action before you take it. Only a ticket worker may call this. The decision is bound to the exact payload you send; changing the payload needs a new request.',
        parameters: {
          action: { type: 'string', required: true, description: 'Short action name, such as merge, post, or push.' },
          payload: { type: 'string', required: true, description: 'The exact content the decision covers, for example the command or the message text.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              approvalId: { type: 'string', required: true },
              digest: { type: 'string', required: true },
              status: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_request_approval requires a calling agent')
          const ticket = ctx.bots.ticketOfWorker(exec.agent.session.id)
          if (ticket === undefined) throw new Error('only a ticket worker may request approval')
          const approval = await ctx.bots.requestApproval(ticket.id, args.action, args.payload)
          return { approvalId: approval.id, digest: approval.digest, status: approval.status }
        },
        presentCall: args => ({ card: 'generic', title: 'bot_request_approval', rawInput: args }),
      })),

      this.ctx.tools.register(defineTool({
        name: 'bot_decide_approval',
        description: 'Approve or deny one pending approval request for this conversation\'s bot. The decision applies to the exact payload the worker sent.',
        parameters: {
          approval_id: { type: 'string', required: true, description: 'Approval id from the request notice.' },
          decision: { type: 'string', required: true, enum: ['approved', 'denied'], description: 'approved lets the worker proceed; denied stops that action.' },
          note: { type: 'string', description: 'Optional one-line reason the worker reads.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              approvalId: { type: 'string', required: true },
              status: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_decide_approval requires a calling agent')
          const bot = ctx.bots.findByRouter(exec.agent.session.id)
          if (bot === undefined) throw new Error('only the bot\'s conversation may decide its approvals')
          const approvalId = brandString<BotApprovalId>(args.approval_id)
          const approval = ctx.bots.approval(approvalId)
          if (approval === undefined || String(approval.botId) !== String(bot.id)) {
            throw new Error(`unknown approval '${args.approval_id}' for this bot`)
          }
          const updated = await ctx.bots.decideApproval(approvalId, args.decision, args.note)
          return { approvalId: updated.id, status: updated.status }
        },
        presentCall: args => ({ card: 'generic', title: 'bot_decide_approval', rawInput: args }),
      })),

      this.ctx.tools.register(defineTool({
        name: 'bot_handoff',
        description: 'Hand one unit of work to another bot. Only a ticket worker may call this. The new ticket names the handoff source so its worker knows where the work came from.',
        parameters: {
          bot: { type: 'string', required: true, description: 'Name of the target bot.' },
          title: { type: 'string', required: true, description: 'Short title for the new ticket.' },
          instruction: { type: 'string', required: true, description: 'The complete instruction the target worker runs.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ticketId: { type: 'string', required: true },
              bot: { type: 'string', required: true },
              stage: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          if (exec.agent === undefined) throw new Error('bot_handoff requires a calling agent')
          const ticket = ctx.bots.ticketOfWorker(exec.agent.session.id)
          if (ticket === undefined) throw new Error('only a ticket worker may hand work off')
          const handed = await ctx.bots.handoff(ticket.id, args.bot, args.title, args.instruction)
          return { ticketId: handed.id, bot: args.bot, stage: handed.stage }
        },
        presentCall: args => ({ card: 'generic', title: 'bot_handoff', rawInput: args }),
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
