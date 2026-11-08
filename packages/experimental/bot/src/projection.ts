/**
 * The `bot` Session projection: the bot bound to a conversation and its
 * tickets, folded from the tool calls and results the bot tools already log.
 * @module @deepseek-ai/dsh-bot/src/projection
 */

import { z } from 'zod'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

/** Tools whose logged calls and results the projection folds. */
const BOT_TOOLS = new Set(['bot_archive', 'bot_create', 'bot_open_ticket', 'bot_report'])

/** One bot as the panel shows it. */
const botView = z.object({
  botId: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string().min(1),
})

/** One ticket as the panel shows it. */
const ticketView = z.object({
  ticketId: z.string().min(1),
  title: z.string(),
  stage: z.string().min(1),
  workerSession: z.string().min(1).optional(),
  summary: z.string().optional(),
})

/** Client-facing view of the projection. */
const viewSchema = z.object({
  bot: botView.nullable(),
  tickets: z.record(z.string(), ticketView),
})

/** Fold state: the view plus the calls still waiting for their result. */
const stateSchema = z.object({
  /** Fork-inherited prefix length; inherited events create no bot state. */
  inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
  view: viewSchema,
  /** Calls of the open turn waiting for a result, keyed by call id. */
  pending: z.record(z.string(), z.object({
    kind: z.enum(['archive', 'create', 'open', 'report']),
    title: z.string().optional(),
    summary: z.string().optional(),
    ticketId: z.string().optional(),
  })),
})

/** Client-facing view inferred from {@link viewSchema}. */
export type BotView = z.infer<typeof viewSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The bot bound to the current Session and its tickets. */
    bot: BotView
  }
}

/** Fold state inferred from {@link stateSchema}. */
export type BotProjectionState = z.infer<typeof stateSchema>

/** Type of {@link botProjection}: the fold plus its Client view wire. */
export type BotProjectionDefinition = Omit<ProjectionDefinition<'bot', BotProjectionState>, 'wire'> & {
  readonly wire: NonNullable<ProjectionDefinition<'bot', BotProjectionState>['wire']>
}

/** Read the first text block of a tool result as JSON, or `undefined`. */
function resultValue(content: readonly { type: string; text?: string }[]): Record<string, unknown> | undefined {
  const text = content.find(block => block.type === 'text')?.text
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Drop one pending call without mutating the others. */
function withoutCall(
  pending: BotProjectionState['pending'],
  callId: string,
): BotProjectionState['pending'] {
  return Object.fromEntries(Object.entries(pending).filter(([id]) => id !== callId))
}

/**
 * Full-Session fold. A successful `bot_create` sets the bound bot; a
 * successful `bot_open_ticket` adds a ticket; a successful `bot_report`
 * updates the ticket's stage and summary. Failed calls change nothing.
 */
export const botProjection: BotProjectionDefinition = {
  key: 'bot',
  stateVersion: 1,
  stateSchema,
  init: (_header, inheritedEventCount) => ({
    inheritedEventCount,
    view: { bot: null, tickets: {} },
    pending: {},
  }),
  apply: (state, event) => {
    if (event.seq < state.inheritedEventCount) return state
    if (event.type === 'turn/start') {
      return Object.keys(state.pending).length === 0 ? state : { ...state, pending: {} }
    }
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind !== 'bot' || source.form !== 'notice') return state
      const ticketId = source.ticketId
      const stage = source.stage
      if (ticketId === undefined || stage === undefined) return state
      const current = state.view.tickets[ticketId]
      if (current === undefined) return state
      return {
        ...state,
        view: {
          ...state.view,
          tickets: {
            ...state.view.tickets,
            [ticketId]: { ...current, stage, summary: source.summary },
          },
        },
      }
    }
    if (event.type === 'tool/call') {
      if (!BOT_TOOLS.has(event.data.name)) return state
      let args: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(event.data.arguments)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return state
        args = parsed as Record<string, unknown>
      } catch {
        return state
      }
      const kind = event.data.name === 'bot_create'
        ? 'create'
        : event.data.name === 'bot_open_ticket'
          ? 'open'
          : event.data.name === 'bot_archive'
            ? 'archive'
            : 'report'
      return {
        ...state,
        pending: {
          ...state.pending,
          [event.data.callId]: {
            kind,
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(typeof args.summary === 'string' ? { summary: args.summary } : {}),
            ...(typeof args.ticket_id === 'string' ? { ticketId: args.ticket_id } : {}),
          },
        },
      }
    }
    if (event.type !== 'tool/result') return state
    const callId = event.data.message.toolCallId
    const call = Object.hasOwn(state.pending, callId) ? state.pending[callId] : undefined
    if (call === undefined) return state
    const pending = withoutCall(state.pending, callId)
    if (event.data.message.isError === true) return { ...state, pending }
    const value = resultValue(event.data.message.content)
    if (value === undefined) return { ...state, pending }

    if (call.kind === 'archive') {
      return { ...state, pending, view: { bot: null, tickets: {} } }
    }
    if (call.kind === 'create') {
      const bot = botView.safeParse(value)
      return bot.success ? { ...state, pending, view: { ...state.view, bot: bot.data } } : { ...state, pending }
    }
    if (call.kind === 'open') {
      const ticket = ticketView.safeParse({ title: call.title ?? '', ...value })
      if (!ticket.success) return { ...state, pending }
      return {
        ...state,
        pending,
        view: { ...state.view, tickets: { ...state.view.tickets, [ticket.data.ticketId]: ticket.data } },
      }
    }
    if (call.ticketId === undefined) return { ...state, pending }
    const current = state.view.tickets[call.ticketId]
    if (current === undefined) return { ...state, pending }
    return {
      ...state,
      pending,
      view: {
        ...state.view,
        tickets: {
          ...state.view.tickets,
          [call.ticketId]: {
            ...current,
            stage: typeof value.stage === 'string' ? value.stage : current.stage,
            ...(call.summary === undefined ? {} : { summary: call.summary }),
          },
        },
      },
    }
  },
  wire: {
    viewSchema,
    view: state => state.view,
  },
}
