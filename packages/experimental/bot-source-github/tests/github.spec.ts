import { describe, expect, it } from 'vitest'
import { candidateOf, freshIssues, parseIssues, ticketInstruction } from '../src/github.ts'
import type { GithubIssue } from '../src/github.ts'

const issue = (number: number, over: Partial<GithubIssue> = {}): GithubIssue => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  updatedAt: '2026-11-08T00:00:00Z',
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

describe('candidateOf', () => {
  it('builds one deterministic would-open candidate per issue', () => {
    const first = candidateOf('o/r', issue(7), '2026-11-08T00:00:00Z')
    const again = candidateOf('o/r', issue(7), '2026-11-09T00:00:00Z')
    expect(first.id).toBe(again.id)
    expect(first).toMatchObject({ repository: 'o/r', number: 7, state: 'would-open' })
    expect(first.ticketId).toBeUndefined()
  })
})

describe('ticketInstruction', () => {
  it('names the repository, issue, URL, and body', () => {
    const text = ticketInstruction('o/r', {
      number: 7,
      title: 'Retry login',
      body: 'Steps to reproduce.',
      url: 'https://github.com/o/r/issues/7',
      updatedAt: '2026-11-08T00:00:00Z',
    })
    expect(text).toContain('Work on o/r issue #7: Retry login')
    expect(text).toContain('https://github.com/o/r/issues/7')
    expect(text).toContain('Steps to reproduce.')
  })

  it('marks an empty body', () => {
    expect(ticketInstruction('o/r', {
      number: 8, title: 'Empty', body: '  ', url: 'u', updatedAt: 't',
    })).toContain('(no description)')
  })
})
