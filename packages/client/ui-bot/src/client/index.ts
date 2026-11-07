/**
 * Bot status strip, browser half: one `conversation.input.dock` entry that
 * renders the bot bound to the current conversation and its ticket counts from
 * `useProjection('bot')`. It registers no actions and no Remote calls.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the Conversation service and input-dock slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard useProjection seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the `bot` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type {} from '@deepseek-ai/dsh-bot'
import { BotDock } from './BotDock.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type BotKey } from './locales.ts'

const NS = 'bot'

/** Required services for the dock entry and its copy. */
export const inject = ['slots', 'locale', 'uiConversation']

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The bot strip's copy. */
    bot: BotKey
  }
}

/**
 * Client plugin body: the bot status strip above the composer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-bot: dictionaries')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'bot',
    order: 9,
    locale: NS,
  }, BotDock))
}
