/**
 * Durable source state: the issue numbers already handled for each repository.
 * @module @deepseek-ai/dsh-bot-source-github/src/spec
 */

import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Cursor key: the repository in `owner/name` form. */
export type SourceKey = Branded<'BotSourceGithubKey'>

/** One repository's handled issue numbers, newest first. */
export const cursorSchema = z.object({
  seen: z.array(z.string().min(1)),
})

/** Stored cursor. */
export type SourceCursor = z.infer<typeof cursorSchema>

/** The source's own domain, version 1. */
export const sourceDomainSpec = defineDomain({
  name: 'bot-source-github',
  version: 1,
  tables: {
    cursors: domainTable<SourceKey, SourceCursor>(cursorSchema),
  },
})
