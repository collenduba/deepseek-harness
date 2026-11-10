/**
 * GitHub issue polling: the `gh` invocation, response validation, and the
 * ticket instruction one new issue produces.
 * @module @deepseek-ai/dsh-bot-source-github/src/github
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
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
  author: z.object({ login: z.string().min(1) }),
})

/** A validated issue record. */
export type GithubIssue = z.infer<typeof issueSchema>

/** One open pull request as `gh pr list --json` reports it. */
export const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().default(''),
  url: z.string().min(1),
  updatedAt: z.string().min(1),
  author: z.object({ login: z.string().min(1) }),
  headRefOid: z.string().min(1),
  baseRefName: z.string().min(1),
  isDraft: z.boolean().default(false),
})

/** A validated pull request record. */
export type GithubPullRequest = z.infer<typeof pullRequestSchema>

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
 * Parse one `gh pr list --json` payload.
 * @param stdout - command output.
 * @returns validated pull requests.
 * @throws when the payload is not the expected array.
 */
export function parsePullRequests(stdout: string): GithubPullRequest[] {
  const parsed: unknown = JSON.parse(stdout)
  return z.array(pullRequestSchema).parse(parsed)
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
    body: issue.body,
    url: issue.url,
    state: 'would-open',
    kind: 'issue',
    createdAt,
  }
}

/**
 * The candidate one pull request revision produces. The id names the head SHA,
 * so a new push is a new candidate and an old one is never reopened.
 * @param repository - `owner/name` of the repository.
 * @param pullRequest - the pull request revision.
 * @param createdAt - ISO-8601 time of the decision.
 * @returns the candidate, in `would-open` state.
 */
export function pullRequestCandidateOf(
  repository: string,
  pullRequest: GithubPullRequest,
  createdAt: string,
): SourceCandidate {
  return {
    id: brandString<CandidateId>(`candidate-${repository}-pr-${pullRequest.number}-${pullRequest.headRefOid}`),
    repository,
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    url: pullRequest.url,
    state: 'would-open',
    kind: 'pull-request',
    headSha: pullRequest.headRefOid,
    createdAt,
  }
}

/**
 * Whether an issue author may open work.
 * @param author - the issue author's login.
 * @param allowed - configured logins; empty admits everyone.
 * @returns true when the author is admitted.
 */
export function admitted(author: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true
  const login = author.toLowerCase()
  return allowed.some(entry => entry.toLowerCase() === login)
}

/**
 * The comment one finished ticket leaves on its issue.
 * @param botName - the bot that ran the ticket.
 * @param ticket - the reported ticket.
 * @returns the comment body.
 */
export function reportComment(
  botName: string,
  ticket: { readonly title: string; readonly stage: string; readonly summary?: string | undefined },
): string {
  const summary = ticket.summary === undefined || ticket.summary.trim() === '' ? 'no summary' : ticket.summary.trim()
  return `Bot "${botName}" finished ticket ${ticket.title} with stage ${ticket.stage}: ${summary}`
}

/**
 * Pull requests whose `number@head` pair is not in the seen set, oldest first.
 * @param seen - handled `number@head` keys.
 * @param pullRequests - current open pull requests.
 * @returns the unreviewed revisions.
 */
export function freshPullRequests(
  seen: readonly string[],
  pullRequests: readonly GithubPullRequest[],
): GithubPullRequest[] {
  const handled = new Set(seen)
  return pullRequests
    .filter(pullRequest => !handled.has(`${pullRequest.number}@${pullRequest.headRefOid}`))
    .sort((left, right) => left.number - right.number)
}

/**
 * The review instruction one PR ticket's worker receives.
 * @param repository - `owner/name` of the repository.
 * @param pullRequest - the pull request and head revision to review.
 * @param workspace - an isolated checkout the runtime already created.
 * @returns the instruction text.
 */
export function pullRequestInstruction(
  repository: string,
  pullRequest: GithubPullRequest,
  workspace?: string,
  merge = false,
): string {
  const short = pullRequest.headRefOid.slice(0, 8)
  const worktree = `../review-${pullRequest.number}-${short}`
  const setup = workspace === undefined
    ? [
      'Build an isolated checkout of this revision:',
      `  git fetch origin pull/${pullRequest.number}/head:refs/review/${pullRequest.number}-${short}`,
      `  git worktree add ${worktree} refs/review/${pullRequest.number}-${short}`,
      `Then change your working directory to ${worktree} before reading files.`,
    ]
    : [`You are in an isolated checkout of this revision at ${workspace}.`]
  return [
    `Review pull request #${pullRequest.number} in ${repository}: ${pullRequest.title}`,
    pullRequest.url,
    `Head ${pullRequest.headRefOid} on base ${pullRequest.baseRefName}.`,
    '',
    ...setup,
    '',
    `Review what this revision changes: \`git diff ${pullRequest.baseRefName}...${pullRequest.headRefOid}\` and the files it touches.`,
    'Read the repository\'s AGENTS.md or CLAUDE.md when present and judge against those conventions.',
    'Check correctness, security, error handling, tests, and consistency with the surrounding code. Run the project\'s existing typecheck, lint, and tests when they are cheap enough.',
    '',
    'Post exactly one summary comment on the pull request:',
    `  gh pr comment ${pullRequest.number} --repo ${repository} --body-file <your review file>`,
    'List findings as `path:line — severity — problem — suggested fix`. If nothing is wrong, say so and list what you checked.',
    'Then call bot_report with the ticket id from your instructions, stage ready, a one-line summary, and verdict "pass" when no blocker remains or "fail" otherwise.',
    'Never push, merge, force-push, or change the pull request.',
    ...merge
      ? [
        'If the verdict is "pass", request a merge approval with bot_request_approval: action "merge" and payload',
        `  ${mergePayload(repository, pullRequest.number, pullRequest.headRefOid)}`,
        'so a person can authorize bot_merge. Never merge the pull request yourself.',
      ]
      : [],
  ].join('\n')
}

/**
 * The instruction one ticket's worker receives.
 * @param repository - `owner/name` of the repository.
 * @param issue - the issue the ticket is about.
 * @returns the instruction text.
 */
export function ticketInstruction(repository: string, issue: Pick<GithubIssue, 'number' | 'title' | 'body' | 'url'>): string {
  const body = issue.body.trim() === '' ? '(no description)' : issue.body.trim()
  return [
    `Work on ${repository} issue #${issue.number}: ${issue.title}`,
    '',
    issue.url,
    '',
    body,
  ].join('\n')
}

/** The `--search` arguments for one query; an empty query lists every open item. */
export function searchArgs(query: string): string[] {
  const trimmed = query.trim()
  return trimmed === '' ? [] : ['--search', trimmed]
}

/** The non-interactive, scrubbed environment every `gh` child receives. */
const GH_ENV = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_PAGER: '',
  NO_COLOR: '1',
}

/** Run one git command in the repository clone. */
async function git(
  options: PollOptions,
  repoPath: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  const result = await execa('git', ['-C', repoPath, ...args], {
    env: { ...scrubbedParentEnv(), GIT_TERMINAL_PROMPT: '0' },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.timedOut) throw new Error(`git ${args[0] ?? ''} timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr}`)
}

/**
 * Fetch one pull-request revision into a detached worktree.
 * @param options - repository, executable, and deadline.
 * @param input - repository clone, worktree parent, and revision.
 * @returns the worktree path.
 */
export async function prepareReviewWorktree(
  options: PollOptions,
  input: {
    readonly repoPath: string
    readonly root: string
    readonly pullRequest: GithubPullRequest
    readonly signal: AbortSignal
  },
): Promise<string> {
  const short = input.pullRequest.headRefOid.slice(0, 8)
  const path = join(input.root, `review-${input.pullRequest.number}-${short}`)
  const ref = `refs/dsh-review/${input.pullRequest.number}-${short}`
  await mkdir(input.root, { recursive: true })
  // Retry-safe: a previous attempt may have left a registration, a directory, or the ref.
  await git(options, input.repoPath, ['worktree', 'remove', '--force', path], input.signal).catch(() => {})
  await rm(path, { recursive: true, force: true })
  await git(options, input.repoPath, ['update-ref', '-d', ref], input.signal).catch(() => {})
  await git(options, input.repoPath, ['fetch', 'origin', `pull/${input.pullRequest.number}/head:${ref}`], input.signal)
  await git(options, input.repoPath, ['worktree', 'add', '--detach', path, ref], input.signal)
  return path
}

/**
 * Remove one review worktree and prune its registration.
 * @param options - repository and deadline.
 * @param input - repository clone and worktree path.
 */
export async function removeReviewWorktree(
  options: PollOptions,
  input: { readonly repoPath: string; readonly path: string; readonly ref: string; readonly signal: AbortSignal },
): Promise<void> {
  await git(options, input.repoPath, ['worktree', 'remove', '--force', input.path], input.signal)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('is not a working tree') && !message.includes('No such file')) throw error
    })
  await rm(input.path, { recursive: true, force: true })
  if (existsSync(input.path)) throw new Error(`worktree '${input.path}' still exists after removal`)
  await git(options, input.repoPath, ['worktree', 'prune'], input.signal).catch(() => {})
  await git(options, input.repoPath, ['update-ref', '-d', input.ref], input.signal).catch(() => {})
}

/** Whether every reported check on a pull request passed.
 * @param rollup - reported checks; empty means none were reported.
 * @param requireChecks - when true, an empty rollup fails; when false, it passes.
 * @returns whether the checks are green under the policy.
 */
export function rollupPasses(rollup: readonly {
  readonly conclusion?: string | null
  readonly status?: string | null
  readonly state?: string | null
}[], requireChecks: boolean): boolean {
  if (rollup.length === 0) return !requireChecks
  return rollup.every(check =>
    check.conclusion === 'SUCCESS' || check.conclusion === 'NEUTRAL' || check.conclusion === 'SKIPPED'
    || (check.conclusion === undefined && check.state === 'SUCCESS'))
}

/**
 * Add one label to a pull request.
 * @param options - repository and executable.
 * @param number - pull request number.
 * @param label - label to add.
 * @param signal - poll cancellation.
 */
export async function labelPullRequest(
  options: PollOptions,
  number: number,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await execa(options.ghCommand, [
    'pr', 'edit', String(number), '--repo', options.repository, '--add-label', label,
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.timedOut) throw new Error(`gh pr edit timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`gh pr edit failed: ${result.stderr}`)
}

/**
 * Remove one label from a pull request; a missing label is not an error.
 * @param options - repository and executable.
 * @param number - pull request number.
 * @param label - label to remove.
 * @param signal - poll cancellation.
 */
export async function removeLabel(
  options: PollOptions,
  number: number,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await execa(options.ghCommand, [
    'pr', 'edit', String(number), '--repo', options.repository, '--remove-label', label,
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.timedOut) throw new Error(`gh pr edit timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0 && !result.stderr.includes('not found')) {
    throw new Error(`gh pr edit failed: ${result.stderr}`)
  }
}

/**
 * Read a pull request's current head SHA.
 * @param options - repository and executable.
 * @param number - pull request number.
 * @param signal - poll cancellation.
 * @returns the head SHA.
 */
export async function pullRequestHead(
  options: PollOptions,
  number: number,
  signal: AbortSignal,
): Promise<string> {
  const result = await execa(options.ghCommand, [
    'pr', 'view', String(number), '--repo', options.repository, '--json', 'headRefOid',
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.timedOut) throw new Error(`gh pr view timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`gh pr view failed: ${result.stderr}`)
  const parsed = z.object({ headRefOid: z.string().min(1) }).parse(JSON.parse(result.stdout))
  return parsed.headRefOid
}

/**
 * Read a pull request's status checks and say whether all passed.
 * @param options - repository and executable.
 * @param number - pull request number.
 * @param signal - poll cancellation.
 * @param requireChecks - when true, no reported checks means not green.
 * @returns true when the checks are green under the policy.
 */
export async function pullRequestChecksPass(
  options: PollOptions,
  number: number,
  signal: AbortSignal,
  requireChecks: boolean,
): Promise<boolean> {
  const result = await execa(options.ghCommand, [
    'pr', 'view', String(number), '--repo', options.repository, '--json', 'statusCheckRollup',
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.timedOut) throw new Error(`gh pr view timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`gh pr view failed: ${result.stderr}`)
  const parsed: unknown = JSON.parse(result.stdout)
  const rollup = (parsed as { statusCheckRollup?: readonly { conclusion?: string | null }[] }).statusCheckRollup ?? []
  return rollupPasses(rollup, requireChecks)
}

/** The payload one merge approval covers for a pull-request revision. */
export function mergePayload(repository: string, number: number, headSha: string): string {
  return `${repository}#${number}@${headSha}`
}

/**
 * Whether a merge is authorized by a passing gate and an approved request.
 * @param input - candidate gate, head, current head, and approved payloads.
 * @returns the refusal reason, or undefined when the merge may proceed.
 */
export function mergeRefusal(input: {
  readonly enabled: boolean
  readonly gate: string | undefined
  readonly candidateHead: string | undefined
  readonly currentHead: string | undefined
  readonly approvedPayloads: readonly string[]
  readonly payload: string
}): string | undefined {
  if (!input.enabled) return 'merging is disabled'
  if (input.gate !== 'ready') return 'the review gate is not ready'
  if (input.candidateHead === undefined || input.candidateHead !== input.currentHead) {
    return 'the reviewed revision is not the current head'
  }
  if (!input.approvedPayloads.includes(input.payload)) return 'no approved merge request covers this revision'
  return undefined
}

/**
 * Merge one pull request with a squash merge.
 * @param options - repository and executable.
 * @param number - pull request number.
 * @param signal - poll cancellation.
 */
export async function mergePullRequest(
  options: PollOptions,
  number: number,
  signal: AbortSignal,
): Promise<void> {
  const result = await execa(options.ghCommand, [
    'pr', 'merge', String(number), '--repo', options.repository, '--squash',
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.timedOut) throw new Error(`gh pr merge timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`gh pr merge failed: ${result.stderr}`)
}

/**
 * List the open pull requests matching the configured query.
 * @param options - repository, query, executable, and deadline.
 * @param includeDrafts - whether draft pull requests are reviewed too.
 * @param signal - poll cancellation.
 * @returns the pull requests.
 * @throws when `gh` cannot run or exits non-zero.
 */
export async function listPullRequests(
  options: PollOptions,
  includeDrafts: boolean,
  signal: AbortSignal,
): Promise<GithubPullRequest[]> {
  const result = await execa(options.ghCommand, [
    'pr', 'list',
    '--repo', options.repository,
    '--state', 'open',
    ...searchArgs(options.query),
    '--json', 'number,title,body,url,updatedAt,author,headRefOid,baseRefName,isDraft',
    '--limit', '30',
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.isCanceled) throw signal.reason
  if (result.timedOut) throw new Error(`gh pr list timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`gh pr list failed: ${result.stderr}`)
  const pullRequests = parsePullRequests(result.stdout)
  return includeDrafts ? pullRequests : pullRequests.filter(pullRequest => !pullRequest.isDraft)
}

/**
 * Comment one result on an issue.
 * @param options - repository, executable, and deadline.
 * @param issueNumber - the issue to comment on.
 * @param body - the comment text.
 * @param signal - poll cancellation.
 * @throws when `gh` cannot run or exits non-zero.
 */
export async function commentIssue(
  options: PollOptions,
  issueNumber: number,
  body: string,
  signal: AbortSignal,
): Promise<void> {
  const result = await execa(options.ghCommand, [
    'issue', 'comment', String(issueNumber),
    '--repo', options.repository,
    '--body', body,
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
    extendEnv: false,
    stdin: 'ignore',
    reject: false,
    timeout: options.timeoutMs,
    cancelSignal: signal,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.isCanceled) throw signal.reason
  if (result.timedOut) throw new Error(`gh issue comment timed out after ${options.timeoutMs}ms`)
  if (result.exitCode !== 0) throw new Error(`gh issue comment failed: ${result.stderr}`)
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
    ...searchArgs(options.query),
    '--json', 'number,title,body,url,updatedAt,author',
    '--limit', '30',
  ], {
    env: { ...scrubbedParentEnv(), ...GH_ENV },
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
