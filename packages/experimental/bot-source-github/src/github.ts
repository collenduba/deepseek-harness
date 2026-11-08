/**
 * GitHub issue polling: the `gh` invocation, response validation, and the
 * ticket instruction one new issue produces.
 * @module @deepseek-ai/dsh-bot-source-github/src/github
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { execa } from 'execa'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import type { CandidateId, SourceCandidate } from './spec.ts'

/** One open issue as `gh issue list --json` reports it. */
export const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().default(''),
  url: z.string().min(1),
  updatedAt: z.string().min(1),
})

/** A validated issue record. */
export type GithubIssue = z.infer<typeof issueSchema>

/** Executable and limits for one poll. */
export interface PollOptions {
  /** Repository in `owner/name` form. */
  readonly repository: string
  /** `gh` search query selecting the issues to watch. */
  readonly query: string
  /** `gh` executable name or absolute path. */
  readonly ghCommand: string
  /** Deadline for one invocation. */
  readonly timeoutMs: number
}

/**
 * Parse one `gh issue list --json` payload.
 * @param stdout - command output.
 * @returns validated issues.
 * @throws when the payload is not the expected array.
 */
export function parseIssues(stdout: string): GithubIssue[] {
  const parsed: unknown = JSON.parse(stdout)
  return z.array(issueSchema).parse(parsed)
}

/**
 * Issues whose numbers are not in the seen set, oldest first.
 * @param seen - issue numbers already handled.
 * @param issues - current open issues.
 * @returns the new issues.
 */
export function freshIssues(seen: readonly string[], issues: readonly GithubIssue[]): GithubIssue[] {
  const handled = new Set(seen)
  return issues.filter(issue => !handled.has(String(issue.number)))
    .sort((left, right) => left.number - right.number)
}

/**
 * The candidate record one issue produces. The id is deterministic, so a
 * retried poll overwrites its own record instead of duplicating it.
 * @param repository - `owner/name` of the repository.
 * @param issue - the issue considered.
 * @param createdAt - ISO-8601 time of the decision.
 * @returns the candidate, in `would-open` state.
 */
export function candidateOf(repository: string, issue: GithubIssue, createdAt: string): SourceCandidate {
  return {
    id: brandString<CandidateId>(`candidate-${repository}-${issue.number}`),
    repository,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: 'would-open',
    createdAt,
  }
}

/**
 * The instruction one ticket's worker receives.
 * @param repository - `owner/name` of the repository.
 * @param issue - the issue the ticket is about.
 * @returns the instruction text.
 */
export function ticketInstruction(repository: string, issue: GithubIssue): string {
  const body = issue.body.trim() === '' ? '(no description)' : issue.body.trim()
  return [
    `Work on ${repository} issue #${issue.number}: ${issue.title}`,
    '',
    issue.url,
    '',
    body,
  ].join('\n')
}

/**
 * List the open issues matching the configured query.
 * @param options - repository, query, executable, and deadline.
 * @param signal - poll cancellation.
 * @returns the issues.
 * @throws when `gh` cannot run or exits non-zero.
 */
export async function listIssues(options: PollOptions, signal: AbortSignal): Promise<GithubIssue[]> {
  const result = await execa(options.ghCommand, [
    'issue', 'list',
    '--repo', options.repository,
    '--state', 'open',
    '--search', options.query,
    '--json', 'number,title,body,url,updatedAt',
    '--limit', '30',
  ], {
    env: {
      ...scrubbedParentEnv(),
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_PAGER: '',
      NO_COLOR: '1',
    },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.isCanceled) throw signal.reason
  if (result.timedOut) throw new Error(`gh issue list timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`gh issue list failed: ${result.stderr}`)
  return parseIssues(result.stdout)
}
