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

/** Identifies one candidate the source considered. */
export type CandidateId = Branded<'BotSourceGithubCandidateId'>

/** One issue the source considered, and what it did about it. */
export const candidateSchema = z.object({
  id: z.string().min(1).transform(value => value as CandidateId),
  repository: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().default(''),
  url: z.string().min(1),
  state: z.enum(['would-open', 'opened', 'filtered']),
  kind: z.enum(['issue', 'pull-request']).default('issue'),
  headSha: z.string().min(1).optional(),
  ticketId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  commentedAt: z.string().min(1).optional(),
})

/** Stored candidate. */
export type SourceCandidate = z.infer<typeof candidateSchema>

/** The source's own domain, version 6: candidates can describe a pull request revision. */
export const sourceDomainSpec = defineDomain({
  name: 'bot_source_github',
  version: 6,
  compatibleVersions: [1, 2, 3, 4, 5],
  tables: {
    cursors: domainTable<SourceKey, SourceCursor>(cursorSchema),
    candidates: domainTable<CandidateId, SourceCandidate>(candidateSchema),
  },
})
