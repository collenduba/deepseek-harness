// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
// Type-only: registers the `bot` LocaleNamespaceMap key used by the locale seat.
import type {} from '../src/client/index.ts'
import { BotStrip } from '../src/client/BotDock.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh)

afterEach(cleanup)

describe('BotStrip', () => {
  it('renders nothing while loading, absent, or when no bot is bound', () => {
    expect(render(<BotStrip view={undefined} t={t} />).container.firstChild).toBeNull()
    cleanup()
    expect(render(<BotStrip view={null} t={t} />).container.firstChild).toBeNull()
    cleanup()
    expect(render(<BotStrip view={{ bot: null, tickets: {} }} t={t} />).container.firstChild).toBeNull()
  })

  it('names the bot and counts tickets that need a person', () => {
    render(<BotStrip
      view={{
        bot: { botId: 'bot-1', name: 'reviewer', workspace: '/tmp/w' },
        tickets: {
          'ticket-1': { ticketId: 'ticket-1', title: 'Review #12', stage: 'working' },
          'ticket-2': { ticketId: 'ticket-2', title: 'Review #13', stage: 'ready', summary: 'Done.' },
          'ticket-3': { ticketId: 'ticket-3', title: 'Review #14', stage: 'blocked' },
        },
      }}
      t={t}
    />)
    expect(screen.getByText('机器人: reviewer')).toBeTruthy()
    expect(screen.getByText('工单: 3')).toBeTruthy()
    expect(screen.getByText('待处理: 2')).toBeTruthy()
  })

  it('lists at most five tickets, the ones needing a person first', () => {
    render(<BotStrip
      view={{
        bot: { botId: 'bot-1', name: 'reviewer', workspace: '/tmp/w' },
        tickets: {
          't-working': { ticketId: 't-working', title: 'Work in flight', stage: 'working' },
          't-queued': { ticketId: 't-queued', title: 'Queued', stage: 'queued' },
          't-blocked': { ticketId: 't-blocked', title: 'Blocked one', stage: 'blocked' },
          't-failed': { ticketId: 't-failed', title: 'Failed one', stage: 'failed' },
          't-ready': { ticketId: 't-ready', title: 'Ready one', stage: 'ready' },
          't-waiting': { ticketId: 't-waiting', title: 'Waiting one', stage: 'waiting' },
        },
      }}
      t={t}
    />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(5)
    expect(rows[0]?.textContent).toContain('Blocked one')
    expect(rows[1]?.textContent).toContain('Failed one')
    expect(rows[2]?.textContent).toContain('Ready one')
    expect(rows[3]?.textContent).toContain('Waiting one')
    expect(rows[4]?.textContent).toContain('Work in flight')
    expect(screen.queryByText('Queued')).toBeNull()
  })

  it('opens a worker Session from its row and leaves rows without one plain', () => {
    const openSession = vi.fn()
    render(<BotStrip
      view={{
        bot: { botId: 'bot-1', name: 'reviewer', workspace: '/tmp/w' },
        tickets: {
          't-with': { ticketId: 't-with', title: 'Review #12', stage: 'working', workerSession: 'bot-worker-1' },
          't-without': { ticketId: 't-without', title: 'Review #13', stage: 'queued' },
        },
      }}
      t={t}
      openSession={openSession}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'Review #12' }))
    expect(openSession).toHaveBeenCalledWith('bot-worker-1')
    expect(screen.queryByRole('button', { name: 'Review #13' })).toBeNull()
    expect(screen.getByText('Review #13')).toBeTruthy()
  })
})
