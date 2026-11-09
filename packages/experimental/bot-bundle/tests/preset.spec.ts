import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

interface PluginRow {
  readonly id?: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
}

interface PresetRow {
  readonly id?: string
  readonly config?: { readonly plugins?: readonly PluginRow[] }
}

const root = fileURLToPath(new URL('..', import.meta.url))
const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
const rows = (parsed as { insert?: readonly PresetRow[] }[]).flatMap(patch => patch.insert ?? [])

/** One preset's child rows by id. */
function preset(id: string): readonly PluginRow[] {
  const row = rows.find(candidate => candidate.id === id)
  expect(row?.config?.plugins).toBeDefined()
  return row?.config?.plugins ?? []
}

describe('bot presets', () => {
  it('composes the reviewer without a file-mutation tool but with a read-only one', () => {
    const plugins = preset('preset-bot-reviewer')
    const ids = plugins.map(plugin => plugin.id)
    expect(ids).toContain('tool-fs')
    expect(ids).toContain('tool-fs-search')
    expect(ids).toContain('tool-working-directory')
    expect(ids).toContain('tool-todo')
    const fileTool = plugins.find(plugin => plugin.id === 'tool-fs')?.config
    expect(fileTool).toMatchObject({ read: true, write: false, edit: false, applyPatch: false })
    const search = plugins.find(plugin => plugin.id === 'tool-fs-search')?.config
    expect(search).toMatchObject({ sampleOverCapGlobResults: false })
  })

  it('never declares one plugin id twice in a preset', () => {
    for (const id of ['preset-bot-worker', 'preset-bot-reviewer']) {
      const ids = preset(id).map(plugin => plugin.id)
      expect(new Set(ids).size, `${id} repeats a plugin id`).toBe(ids.length)
    }
  })

  it('gives both unattended presets the required tool configs', () => {
    for (const id of ['preset-bot-worker', 'preset-bot-reviewer']) {
      const todo = preset(id).find(plugin => plugin.id === 'tool-todo')?.config
      expect(todo).toMatchObject({ allowParallelInProgress: true })
    }
  })
})
