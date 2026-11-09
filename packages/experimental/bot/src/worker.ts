/**
 * Worker Session launch: one ordinary root Session per ticket, created and
 * prompted through the public Agent registry. The worker is not a subagent:
 * it survives its creator, appears in the sidebar, and reports back through
 * the `bot_report` tool.
 * @module @deepseek-ai/dsh-bot/src/worker
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { BotId, BotMemoryRecord, BotRecord, TicketId, TicketRecord, TicketStage } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Input the bot runtime delivered to a worker or router Session. */
    bot: {
      readonly kind: 'bot'
      readonly botId: BotId
      readonly ticketId?: TicketId
      readonly form: 'instructions' | 'notice'
      readonly summary: string
      /** Reported stage, present on a notice the router receives. */
      readonly stage?: TicketStage
    }
  }
}

/**
 * The first message a worker receives: its job, the ticket instruction, and
 * the one tool call that ends its turn usefully.
 * @param bot - the bot that authorized the ticket.
 * @param ticket - the ticket being executed.
 * @returns the worker's instruction text.
 */
export function workerInstruction(
  bot: BotRecord,
  ticket: TicketRecord,
  memories: readonly BotMemoryRecord[] = [],
  origin?: TicketOrigin,
): string {
  return [
    `You are the worker for ticket ${ticket.id} of bot "${bot.name}".`,
    `Bot job: ${bot.job}`,
    ...origin === undefined ? [] : ['', `This ticket was handed off from ticket ${origin.ticketId} of bot "${origin.botName}".`],
    ...bot.tools === undefined ? [] : ['', `You may call only these tools: ${bot.tools.join(', ')}, plus the bot reporting tools.`],
    ...bot.hardFloor === undefined ? [] : ['', `A person must perform these actions; do not request approval for them: ${bot.hardFloor.join(', ')}.`],
    ...memories.length === 0 ? [] : ['', 'Known context for this bot, from earlier tickets:', ...memories.map(memory => `- ${memory.text}`)],
    '',
    'Work only on this instruction:',
    ticket.instruction,
    '',
    `When the work is done, call bot_report with ticket_id "${ticket.id}", stage "ready", and a one-line summary.`,
    'Use stage "waiting" only when a person must answer, "blocked" when something outside your control stops you, and "failed" when you cannot finish.',
  ].join('\n')
}

/** The ticket a handoff came from, as the new worker sees it. */
export interface TicketOrigin {
  /** Name of the bot that handed the work off. */
  readonly botName: string
  /** The ticket that delegated. */
  readonly ticketId: TicketId
}

/** Log a rollback failure without replacing the launch failure that caused it. */
function reportRollbackFailure(ctx: Context, subject: string, error: unknown): void {
  ctx.logger.warn(`bot: ${subject} rollback failed: ${String(error)}`)
}

/**
 * Create, attach, title, and prompt one worker Session for a ticket.
 *
 * The returned Session is the ticket's worker for its whole life; the caller
 * records its id and owns nothing else. A failure after the Agent was created
 * detaches and disposes it before rethrowing, so a failed launch leaves no
 * half-created worker behind.
 *
 * @param ctx - runtime context owning the resulting Agent and its services.
 * @param bot - the bot whose workspace and preset the worker uses.
 * @param ticket - the ticket the worker executes.
 * @returns the new worker Session id.
 */
export async function launchWorker(
  ctx: Context,
  bot: BotRecord,
  ticket: TicketRecord,
  memories: readonly BotMemoryRecord[] = [],
  origin?: TicketOrigin,
): Promise<SessionId> {
  const workspace = await ctx.workspaceRegistry.create(bot.workspace)
  const sessionId = brandString<SessionId>(`bot-worker-${randomUUID()}`)
  let presetId: string | undefined
  let mountPreset: ((agentCtx: Context) => Promise<void>) | undefined
  const presets = ctx.get('agentPresets')
  // A worker must inherit a preset: the root composition carries no file or
  // shell tools, so an unmounted worker could not act on its instruction.
  const wantedPreset = bot.preset ?? presets?.defaultId
  if (wantedPreset !== undefined) {
    if (presets === undefined) {
      throw new Error(`bot '${bot.name}' needs agent preset '${wantedPreset}', but no agent-preset registry is mounted`)
    }
    const resolved = await presets.resolve(wantedPreset)
    presetId = resolved.id
    const registry = presets
    mountPreset = async (agentCtx: Context) => { await registry.mount(agentCtx, resolved.id) }
  }
  let handle
  if (presetId === undefined || mountPreset === undefined) {
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path },
      agentOptions: ctx.agentDefaultModel.currentSelection(),
    })
  } else {
    handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, agentPreset: presetId },
      agentOptions: ctx.agentDefaultModel.currentSelection(),
      setup: mountPreset,
    })
  }
  let attached = false
  try {
    await workspace.attachSession(sessionId)
    attached = true
    ctx.sessionTitle.rename(handle.agent.session, `${bot.name}: ${ticket.title}`)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: workerInstruction(bot, ticket, memories, origin) }],
      source: {
        kind: 'bot',
        botId: bot.id,
        ticketId: ticket.id,
        form: 'instructions',
        summary: `Ticket ${ticket.id}`,
      },
    }))
    return sessionId
  } catch (error: unknown) {
    if (attached) {
      try {
        await workspace.detachSession(sessionId)
      } catch (rollbackError: unknown) {
        reportRollbackFailure(ctx, `Workspace detach for worker "${sessionId}"`, rollbackError)
      }
    }
    try {
      await handle.dispose()
    } catch (rollbackError: unknown) {
      reportRollbackFailure(ctx, `Agent disposal for worker "${sessionId}"`, rollbackError)
    }
    throw error
  }
}
