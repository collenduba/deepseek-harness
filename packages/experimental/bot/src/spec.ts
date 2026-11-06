/**
 * Durable bot and ticket records: the `defineDomain` declaration the registry
 * opens, plus the zod schemas that validate every stored record.
 * @module @deepseek-ai/dsh-bot/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { BotId, BotRecord, TicketId, TicketRecord } from './types.ts'

/** Brand a stored string as a {@link BotId}. */
const botId = z.string().min(1).transform(value => value as BotId)

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
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})

/**
 * The `bot` domain: two tables and no global state. Version 1 is the first
 * shipped format, so no compatibility window exists yet.
 */
export const botDomainSpec = defineDomain({
  name: 'bot',
  version: 1,
  tables: {
    bots: domainTable<BotId, BotRecord>(botRecordSchema),
    tickets: domainTable<TicketId, TicketRecord>(ticketRecordSchema),
  },
})
