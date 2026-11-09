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

/** Identifies one notice the bot held or delivered. */
export type BotNoticeId = Branded<'BotNoticeId'>

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
  /** Tool names worker Sessions may call; absent means every tool. */
  readonly tools?: readonly string[] | undefined
  /** Case-insensitive regular expressions whose match denies a shell command. */
  readonly blockedCommands?: readonly string[] | undefined
  /** Action names a person must perform; the bot may never request them. */
  readonly hardFloor?: readonly string[] | undefined
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
  /** Working directory for the worker; absent means the bot's workspace. */
  readonly workspace?: string | undefined
  /** The worker Session running the ticket, once launched. */
  readonly workerSession?: SessionId | undefined
  /** The worker's latest one-line outcome or question. */
  readonly summary?: string | undefined
  /** The ticket this work was handed off from, when it was delegated. */
  readonly parentTicket?: TicketId | undefined
  /** The name of the bot that handed the work off. */
  readonly parentBotName?: string | undefined
  /** Handoff chain depth; absent on a ticket a person opened. */
  readonly handoffDepth?: number | undefined
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

/** One notice owed to a bot's conversation, held or delivered. */
export interface BotNoticeRecord {
  /** Stable identity, generated when the notice is created. */
  readonly id: BotNoticeId
  /** The bot the notice belongs to. */
  readonly botId: BotId
  /** The ticket the notice is about. */
  readonly ticketId: TicketId
  /** The Session that receives it. */
  readonly routerSession: SessionId
  /** The full message text. */
  readonly text: string
  /** One line for a digest or a ticket card. */
  readonly summary: string
  /** ISO-8601 creation time. */
  readonly createdAt: string
  /** How urgently the notice should interrupt: a blocker, or a result that can wait. */
  readonly severity?: 'interrupt' | 'digest' | undefined
  /** ISO-8601 delivery time; absent while the notice is held. */
  readonly deliveredAt?: string | undefined
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
  readonly preset?: string
  /** Optional tool allowlist for worker Sessions. */
  readonly tools?: readonly string[]
  /** Optional case-insensitive regular expressions that deny shell commands. */
  readonly blockedCommands?: readonly string[]
  /** Optional actions a person must perform. */
  readonly hardFloor?: readonly string[] | undefined
}

/** Input accepted by {@link BotRegistry.openTicket}. */
export interface OpenTicketInput {
  /** The Session that owns the bot. */
  readonly routerSession: SessionId
  /** Short title. */
  readonly title: string
  /** The instruction the worker runs. */
  readonly instruction: string
  /** Optional absolute working directory for this ticket's worker. */
  readonly workspace?: string
}
