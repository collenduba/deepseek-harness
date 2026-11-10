import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  admitted, candidateOf, mergePayload, mergeRefusal, rollupPasses, freshIssues, freshPullRequests, parseIssues, parsePullRequests,
  prepareReviewWorktree, pullRequestCandidateOf, pullRequestInstruction, removeReviewWorktree, reportComment,
  searchArgs, ticketInstruction,
} from '../src/github.ts'
import type { GithubIssue, GithubPullRequest, PollOptions } from '../src/github.ts'

const issue = (number: number, over: Partial<GithubIssue> = {}): GithubIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  updatedAt: '2026-11-08T00:00:00Z',
  author: { login: 'alice' },
  ...over,
})

describe('parseIssues', () => {
  it('accepts gh output and defaults a missing body', () => {
    const parsed = parseIssues(JSON.stringify([issue(1), { ...issue(2), body: undefined }]))
    expect(parsed.map(entry => entry.number)).toEqual([1, 2])
    expect(parsed[1]?.body).toBe('')
  })

  it('rejects a payload that is not an issue array', () => {
    expect(() => parseIssues('{"number":1}')).toThrow()
    expect(() => parseIssues(JSON.stringify([{ number: 'one' }]))).toThrow()
    expect(() => parseIssues(JSON.stringify([{ ...issue(3), author: undefined }]))).toThrow()
  })
})

describe('freshIssues', () => {
  it('keeps unseen numbers and sorts them oldest first', () => {
    const fresh = freshIssues(['2'], [issue(3), issue(2), issue(1)])
    expect(fresh.map(entry => entry.number)).toEqual([1, 3])
  })

  it('returns nothing when every number is handled', () => {
    expect(freshIssues(['1', '2'], [issue(1), issue(2)])).toEqual([])
  })
})

describe('review worktrees', () => {
  it('fetches a revision into a worktree and removes it with its ref, twice safely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-wt-'))
    try {
      const repo = join(root, 'repo')
      const remote = join(root, 'remote.git')
      const workRoot = join(root, 'worktrees')
      const run = (...args: string[]): string => execFileSync('git', args, { stdio: 'pipe' }).toString()
      run('init', '-q', repo)
      run('-C', repo, 'config', 'user.email', 'test@example.com')
      run('-C', repo, 'config', 'user.name', 'Test')
      await writeFile(join(repo, 'a.txt'), 'a\n')
      run('-C', repo, 'add', '.')
      run('-C', repo, 'commit', '-q', '-m', 'init')
      run('init', '--bare', '-q', remote)
      run('-C', repo, 'remote', 'add', 'origin', remote)
      run('-C', repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
      const sha = run('-C', repo, 'rev-parse', 'HEAD').trim()
      run('-C', remote, 'update-ref', 'refs/pull/1/head', sha)

      const options: PollOptions = { repository: 'o/r', query: '', ghCommand: 'gh', timeoutMs: 30_000 }
      const signal = new AbortController().signal
      const path = await prepareReviewWorktree(options, {
        repoPath: repo, root: workRoot, pullRequest: pr(1, sha), signal,
      })
      expect(existsSync(path)).toBe(true)
      expect(run('-C', repo, 'show-ref', `refs/dsh-review/1-${sha.slice(0, 8)}`)).toContain(sha)

      const ref = `refs/dsh-review/1-${sha.slice(0, 8)}`
      await removeReviewWorktree(options, { repoPath: repo, path, ref, signal })
      expect(existsSync(path)).toBe(false)
      expect(() => run('-C', repo, 'show-ref', ref)).toThrow()
      await expect(removeReviewWorktree(options, { repoPath: repo, path, ref, signal })).resolves.toBeUndefined()

      await mkdir(path)
      await writeFile(join(path, 'junk.txt'), 'left behind\n')
      await expect(prepareReviewWorktree(options, {
        repoPath: repo, root: workRoot, pullRequest: pr(1, sha), signal,
      })).resolves.toBe(path)
      expect(existsSync(join(path, 'junk.txt'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('mergeRefusal', () => {
  const base = {
    enabled: true, gate: 'ready', candidateHead: 'sha-1', currentHead: 'sha-1',
    approvedPayloads: ['o/r#1@sha-1'], payload: 'o/r#1@sha-1',
  }
  it('refuses every incomplete condition', () => {
    expect(mergePayload('o/r', 1, 'sha-1')).toBe('o/r#1@sha-1')
    expect(mergeRefusal({ ...base, enabled: false })).toContain('disabled')
    expect(mergeRefusal({ ...base, gate: 'pending' })).toContain('gate is not ready')
    expect(mergeRefusal({ ...base, candidateHead: 'sha-2' })).toContain('not the current head')
    expect(mergeRefusal({ ...base, approvedPayloads: [] })).toContain('no approved merge')
    expect(mergeRefusal(base)).toBeUndefined()
  })
})

describe('rollupPasses', () => {
  it('requires every reported check to succeed', () => {
    expect(rollupPasses([])).toBe(false)
    expect(rollupPasses([{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe(true)
    expect(rollupPasses([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe(false)
    expect(rollupPasses([{ status: 'IN_PROGRESS' }])).toBe(false)
    expect(rollupPasses([{ state: 'SUCCESS' }, { conclusion: 'SUCCESS' }])).toBe(true)
    expect(rollupPasses([{ state: 'FAILURE' }])).toBe(false)
    expect(rollupPasses([], false)).toBe(true)
    expect(rollupPasses([], true)).toBe(false)
  })
})

describe('searchArgs', () => {
  it('omits the filter for an empty query', () => {
    expect(searchArgs('')).toEqual([])
    expect(searchArgs('   ')).toEqual([])
    expect(searchArgs('is:pr is:open')).toEqual(['--search', 'is:pr is:open'])
  })
})

describe('admitted', () => {
  it('admits everyone with an empty list and matches logins case-insensitively', () => {
    expect(admitted('alice', [])).toBe(true)
    expect(admitted('Alice', ['alice'])).toBe(true)
    expect(admitted('bob', ['alice'])).toBe(false)
  })
})

const pr = (number: number, sha: string, over: Partial<GithubPullRequest> = {}): GithubPullRequest => ({
  number,
  title: `PR ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  updatedAt: '2026-11-09T00:00:00Z',
  author: { login: 'alice' },
  headRefOid: sha,
  baseRefName: 'main',
  isDraft: false,
  ...over,
})

describe('pull requests', () => {
  it('parses gh output and drops drafts when asked', () => {
    const parsed = parsePullRequests(JSON.stringify([pr(1, 'a'), pr(2, 'b', { isDraft: true })]))
    expect(parsed.map(entry => entry.number)).toEqual([1, 2])
    expect(parsed[1]?.isDraft).toBe(true)
  })

  it('treats each head revision as its own candidate', () => {
    const first = pullRequestCandidateOf('o/r', pr(1, 'sha-1'), '2026-11-09T00:00:00Z')
    const second = pullRequestCandidateOf('o/r', pr(1, 'sha-2'), '2026-11-09T00:00:00Z')
    expect(first.id).not.toBe(second.id)
    expect(first).toMatchObject({ kind: 'pull-request', headSha: 'sha-1', number: 1 })
    expect(freshPullRequests([`1@${first.headSha}`], [pr(1, 'sha-1'), pr(1, 'sha-2')])
      .map(entry => entry.headRefOid)).toEqual(['sha-2'])
  })

  it('asks for an isolated worktree and one summary comment', () => {
    const text = pullRequestInstruction('o/r', pr(3, 'abcdef123456'))
    expect(text).toContain('git worktree add ../review-3-abcdef12 refs/review/3-abcdef12')
    expect(text).toContain('gh pr comment 3 --repo o/r')
    expect(text).toContain('Never push, merge, force-push')
    expect(pullRequestInstruction('o/r', pr(3, 'abcdef123456'), '/tmp/wt'))
      .toContain('isolated checkout of this revision at /tmp/wt')
    expect(pullRequestInstruction('o/r', pr(3, 'abcdef123456'))).not.toContain('bot_request_approval')
    expect(pullRequestInstruction('o/r', pr(3, 'abcdef123456'), undefined, true))
      .toContain('o/r#3@abcdef123456')
  })
})

describe('candidateOf', () => {
  it('builds one deterministic would-open candidate per issue', () => {
    const first = candidateOf('o/r', issue(7), '2026-11-08T00:00:00Z')
    const again = candidateOf('o/r', issue(7), '2026-11-09T00:00:00Z')
    expect(first.id).toBe(again.id)
    expect(first).toMatchObject({ repository: 'o/r', number: 7, state: 'would-open' })
    expect(first.ticketId).toBeUndefined()
  })
})

describe('reportComment', () => {
  it('names the bot, ticket, stage, and summary', () => {
    expect(reportComment('reviewer', { title: '#12 Retry login', stage: 'ready', summary: 'Fixed in #34.' }))
      .toBe('Bot "reviewer" finished ticket #12 Retry login with stage ready: Fixed in #34.')
    expect(reportComment('reviewer', { title: '#12 Retry login', stage: 'failed', summary: '  ' }))
      .toContain('with stage failed: no summary')
  })
})

describe('ticketInstruction', () => {
  it('names the repository, issue, URL, and body', () => {
    const text = ticketInstruction('o/r', {
      number: 7,
      title: 'Retry login',
      body: 'Steps to reproduce.',
      url: 'https://github.com/o/r/issues/7',
    })
    expect(text).toContain('Work on o/r issue #7: Retry login')
    expect(text).toContain('https://github.com/o/r/issues/7')
    expect(text).toContain('Steps to reproduce.')
  })

  it('marks an empty body', () => {
    expect(ticketInstruction('o/r', {
      number: 8, title: 'Empty', body: '  ', url: 'u',
    })).toContain('(no description)')
  })
})
