import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

/** The reviewer preset block: from its id to the end of the file. */
function reviewerBlock(): string {
  const start = patch.indexOf('- id: preset-bot-reviewer')
  expect(start).toBeGreaterThan(-1)
  return patch.slice(start)
}

describe('bot-reviewer preset', () => {
  it('cannot write to the checkout it reviews', () => {
    const block = reviewerBlock()
    expect(block).not.toMatch(/^\s+- id: tool-fs\s*$/m)
    expect(block).toContain('- id: tool-fs-search')
    expect(block).toContain('sampleOverCapGlobResults: false')
    expect(block).toContain('- id: tool-bash')
    expect(block).toContain('- id: tool-working-directory')
  })

  it('declares the required tool-todo config', () => {
    expect(reviewerBlock()).toContain('allowParallelInProgress: true')
  })
})
