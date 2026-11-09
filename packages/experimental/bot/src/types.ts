/**
 * Public vocabulary of the bot domain: identities, ticket stages, and the
 * durable records the registry stores. Types only; no runtime code.
 * @module @deepseek-ai/dsh-bot/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one durable bot record. */
export type BotId = Branded<'BotId'>

/** Identifies one unit of work a bot opened. */
export type TicketId = Branded<'TicketId'>

/** Identifies one remembered fact. */
export type BotMemoryId = Branded<'BotMemoryId'>

/** Identifies one approval request. */
export type BotApprovalId = Branded<'BotApprovalId'>

/**
 * Where a ticket stands. `queued` and `working` need no person; `waiting`
 * waits for a next input; `ready`, `blocked`, and `failed` all need a person.
 */
export type TicketStage = 'queued' | 'working' | 'waiting' | 'ready' | 'blocked' | 'failed'

/** Whether a bot accepts new tickets. */
export type BotStatus = 'active' | 'paused'

/**
 * One durable bot. The record outlives every Session it starts: `routerSession`
 * names the conversation that owns it, and `workspace` is the directory its
 * workers run in.
 */
export interface BotRecord {
  /** Stable identity, generated at create. */
  readonly id: BotId
  /** Display name, unique among bots bound to the same Session. */
  readonly name: string
  /** What the bot is for, in the operator's words. */
  readonly job: string
  /** Absolute directory the bot's workers run in. */
  readonly workspace: string
  /** The Session that opened this bot and receives its reports. */
  readonly routerSession: SessionId
  /** Agent preset for worker Sessions; absent means the deployment default. */
  readonly preset?: string | undefined
  /** Whether new tickets are accepted. */
  readonly status: BotStatus
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 time of the latest write. */
  readonly updatedAt: string
}

/** One durable unit of work, from a direct request to its outcome. */
export interface TicketRecord {
  /** Stable identity, generated when the ticket opens. */
  readonly id: TicketId
  /** The bot that authorized the work. */
  readonly botId: BotId
  /** Short title shown in the panel and the Session title. */
  readonly title: string
  /** The instruction the worker runs, in the requester's words. */
  readonly instruction: string
  /** Current stage. */
  readonly stage: TicketStage
  /** The Session that receives this ticket's reports. */
  readonly routerSession: SessionId
  /** The worker Session running the ticket, once launched. */
  readonly workerSession?: SessionId | undefined
  /** The worker's latest one-line outcome or question. */
  readonly summary?: string | undefined
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** ISO-8601 time of the latest write. */
  readonly updatedAt: string
}

/** One durable note a bot keeps across tickets. */
export interface BotMemoryRecord {
  /** Stable identity, generated when the note is written. */
  readonly id: BotMemoryId
  /** The bot the note belongs to. */
  readonly botId: BotId
  /** The note text, one fact or rule. */
  readonly text: string
  /** ISO-8601 time of the write. */
  readonly createdAt: string
  /** The ticket whose worker wrote it, when a worker did. */
  readonly sourceTicket?: TicketId | undefined
}

/** Where an approval request stands. */
export type BotApprovalStatus = 'pending' | 'approved' | 'denied'

/** One payload-bound approval a worker requested and a person decided. */
export interface BotApprovalRecord {
  /** Stable identity, generated when the request is made. */
  readonly id: BotApprovalId
  /** The bot the requesting ticket belongs to. */
  readonly botId: BotId
  /** The ticket whose worker asked. */
  readonly ticketId: TicketId
  /** Short name of the action, such as merge or post. */
  readonly action: string
  /** The exact payload the decision applies to, as lossless JSON text. */
  readonly payload: string
  /** SHA-256 of {@link payload}, so a decision names the exact bytes. */
  readonly digest: string
  /** Current decision state. */
  readonly status: BotApprovalStatus
  /** ISO-8601 request time. */
  readonly createdAt: string
  /** ISO-8601 decision time, once decided. */
  readonly decidedAt?: string | undefined
  /** The decider's one-line note, when they left one. */
  readonly note?: string | undefined
}

/** What a bot's worker reports about its ticket. */
export interface TicketReport {
  /** One of the stages a worker may report. */
  readonly stage: Extract<TicketStage, 'waiting' | 'ready' | 'blocked' | 'failed'>
  /** One line the requester can read without opening the Session. */
  readonly summary: string
}

/** Input accepted by {@link BotRegistry.create}. */
export interface CreateBotInput {
  /** Display name. */
  readonly name: string
  /** What the bot is for. */
  readonly job: string
  /** Absolute directory for worker Sessions. */
  readonly workspace: string
  /** The Session that owns the bot. */
  readonly routerSession: SessionId
  /** Optional worker Agent preset. */
  readonly preset?: string | undefined
}

/** Input accepted by {@link BotRegistry.openTicket}. */
export interface OpenTicketInput {
  /** The Session that owns the bot. */
  readonly routerSession: SessionId
  /** Short title. */
  readonly title: string
  /** The instruction the worker runs. */
  readonly instruction: string
}
