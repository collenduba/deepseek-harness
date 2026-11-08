// @vitest-environment jsdom

/**
 * ui-bot browser half on a real cordis Context with fake slots/locale/
 * uiConversation faces: the plugin registers one `conversation.input.dock`
 * entry and removes it with its fiber, and the node half stays inert.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

/** Boot the plugin over a root slot declaration and fake locale/uiConversation faces. */
async function bench() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.input.dock': { kind: 'list', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('uiConversation' as string, {})
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return { ctx, fiber }
}

describe('ui-bot browser plugin', () => {
  it('registers one dock entry and removes it when the fiber disposes', async () => {
    const { ctx, fiber } = await bench()
    await fiber.await()
    const entries = ctx.slots.entries('conversation.input.dock')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.options.id).toBe('bot')
    expect(entries[0]?.locale).toBe('bot')

    await fiber.dispose()
    expect(ctx.slots.entries('conversation.input.dock')).toHaveLength(0)
  })

  it('keeps the node half inert', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
