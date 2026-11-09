import { describe, expect, it } from 'vitest'
import {
  admitted, candidateOf, freshIssues, freshPullRequests, parseIssues, parsePullRequests,
  pullRequestCandidateOf, pullRequestInstruction, reportComment, searchArgs, ticketInstruction,
} from '../src/github.ts'
import type { GithubIssue, GithubPullRequest } from '../src/github.ts'

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
