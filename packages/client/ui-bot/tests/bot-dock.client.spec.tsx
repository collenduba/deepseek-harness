// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
})
