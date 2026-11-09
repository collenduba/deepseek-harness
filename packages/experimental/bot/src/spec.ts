/**
 * Durable bot and ticket records: the `defineDomain` declaration the registry
 * opens, plus the zod schemas that validate every stored record.
 * @module @deepseek-ai/dsh-bot/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BotApprovalId, BotApprovalRecord, BotId, BotMemoryId, BotMemoryRecord, BotNoticeId, BotNoticeRecord, BotRecord, TicketId, TicketRecord } from './types.ts'

/** Brand a stored string as a {@link BotId}. */
const botId = z.string().min(1).transform(value => value as BotId)

/** Brand a stored string as a {@link BotNoticeId}. */
const noticeId = z.string().min(1).transform(value => value as BotNoticeId)

/** Brand a stored string as a {@link BotApprovalId}. */
const approvalId = z.string().min(1).transform(value => value as BotApprovalId)

/** Brand a stored string as a {@link BotMemoryId}. */
const memoryId = z.string().min(1).transform(value => value as BotMemoryId)

/** Brand a stored string as a {@link TicketId}. */
const ticketId = z.string().min(1).transform(value => value as TicketId)

/** Brand a stored string as a {@link SessionId}. */
const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))

/** Durable shape of one bot record. */
export const botRecordSchema = z.object({
  id: botId,
  name: z.string().min(1),
  job: z.string().min(1),
  workspace: z.string().min(1),
  routerSession: sessionId,
  preset: z.string().min(1).optional(),
  tools: z.array(z.string().min(1)).optional(),
  blockedCommands: z.array(z.string().min(1)).optional(),
  hardFloor: z.array(z.string().min(1)).optional(),
  status: z.enum(['active', 'paused']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** Durable shape of one ticket record. */
export const ticketRecordSchema = z.object({
  id: ticketId,
  botId,
  title: z.string().min(1),
  instruction: z.string().min(1),
  stage: z.enum(['queued', 'working', 'waiting', 'ready', 'blocked', 'failed']),
  routerSession: sessionId,
  workerSession: sessionId.optional(),
  summary: z.string().optional(),
  parentTicket: ticketId.optional(),
  parentBotName: z.string().min(1).optional(),
  handoffDepth: z.number().int().nonnegative().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** Durable shape of one remembered note. */
export const memoryRecordSchema = z.object({
  id: memoryId,
  botId,
  text: z.string().min(1),
  createdAt: z.string().min(1),
  sourceTicket: ticketId.optional(),
})

/** Durable shape of one approval request. */
export const approvalRecordSchema = z.object({
  id: approvalId,
  botId,
  ticketId,
  action: z.string().min(1),
  payload: z.string().min(1),
  digest: z.string().min(1),
  status: z.enum(['pending', 'approved', 'denied']),
  createdAt: z.string().min(1),
  decidedAt: z.string().min(1).optional(),
  note: z.string().optional(),
})

/** Durable shape of one notice. */
export const noticeRecordSchema = z.object({
  id: noticeId,
  botId,
  ticketId,
  routerSession: sessionId,
  text: z.string().min(1),
  summary: z.string().min(1),
  severity: z.enum(['interrupt', 'digest']).default('interrupt'),
  createdAt: z.string().min(1),
  deliveredAt: z.string().min(1).optional(),
})

/**
 * The `bot` domain: bots, tickets, remembered notes, approval requests, and
 * notices, with no global state. Version 10 adds optional blocked shell
 * command patterns on a bot; versions 1 through 9 load unchanged.
 */
export const botDomainSpec = defineDomain({
  name: 'bot',
  version: 10,
  compatibleVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  tables: {
    bots: domainTable<BotId, BotRecord>(botRecordSchema),
    tickets: domainTable<TicketId, TicketRecord>(ticketRecordSchema),
    memories: domainTable<BotMemoryId, BotMemoryRecord>(memoryRecordSchema),
    approvals: domainTable<BotApprovalId, BotApprovalRecord>(approvalRecordSchema),
    notices: domainTable<BotNoticeId, BotNoticeRecord>(noticeRecordSchema),
  },
})
