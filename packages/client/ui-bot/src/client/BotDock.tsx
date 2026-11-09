/**
 * BotDock: one line above the composer naming the bot bound to this
 * conversation, its ticket count, and how many tickets need a person. The
 * durable value arrives through `useProjection('bot')`; a conversation with no
 * bot renders nothing.
 */

import type { BotView } from '@deepseek-ai/dsh-bot'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { BotKey } from './locales.ts'
import css from './BotDock.module.css'

/** Full props of the dock entry: the InputZone owner share and the locale seat. */
export type BotDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'bot'>

/** Presentational props: the projected view and the locale seat. */
export interface BotStripProps {
  /** Projected bot view; undefined while loading, null when the Session has no projection. */
  readonly view: BotView | null | undefined
  /** Locale lookup for the `bot` namespace. */
  readonly t: TranslateNS<'bot'>
}

/** Stages whose ticket waits for a person. */
const NEEDS_PERSON = new Set(['waiting', 'ready', 'blocked', 'failed'])

/** Display order: what needs a person first, then work in flight. */
const STAGE_ORDER: Record<string, number> = { blocked: 0, failed: 1, ready: 2, waiting: 3, working: 4, queued: 5 }

/** How many ticket rows the strip lists before it stops. */
const MAX_ROWS = 5

/**
 * Render the strip from an already-projected view.
 * @param props - the projected view and the locale lookup.
 * @returns the strip, or null when no bot is bound.
 */
export function BotStrip({ view, t }: BotStripProps) {
  if (view == null || view.bot === null) return null
  const tickets = Object.values(view.tickets)
  const needs = tickets.filter(ticket => NEEDS_PERSON.has(ticket.stage)).length
  const rows = [...tickets]
    .sort((left, right) => (STAGE_ORDER[left.stage] ?? 9) - (STAGE_ORDER[right.stage] ?? 9)
      || left.title.localeCompare(right.title))
    .slice(0, MAX_ROWS)
  return (
    <div className={css.strip} role="status">
      <div className={css.row}>
        <span className={css.bot}>{t('label.bot')}: {view.bot.name}</span>
        <span>{t('label.tickets')}: {tickets.length}</span>
        <span className={needs > 0 ? css.needs : undefined}>{t('label.needs')}: {needs}</span>
      </div>
      {rows.length > 0 && (
        <ul className={css.tickets}>
          {rows.map(ticket => (
            <li key={ticket.ticketId} className={css.ticket}>
              <span className={css.title}>{ticket.title}</span>
              <span className={css.stage}>{ticket.stage}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Dock adapter: reads the `bot` projection and renders the strip. */
export function BotDock({ useProjection, t }: BotDockProps) {
  return <BotStrip view={useProjection('bot')} t={t} />
}

/** Re-exported for tests and future entries; the key union stays package-owned. */
export type { BotKey }
