/**
 * Real-service composition: a bot ticket launches a real root Session through
 * the Agent registry, and a report reaches the router Session's log.
 *
 * Only the model adapter and the external title/persistence seams are scripted;
 * sessions, sessions projections, tools, agents, the agent loop, the bot
 * domain, and the workspace registry are the shipped implementations.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, onTestFinished } from 'vitest'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import BotRegistry, { botDomainSpec } from '../src/index.ts'

const routerId = brandString<SessionId>('router-1')

/** Scripted adapter: every request answers with one short text turn. */
class TextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override providerInfo(provider: string) {
    return { id: provider, name: 'Scripted' }
  }

  override listModels(provider: string) {
    return Promise.resolve([{
      provider,
      id: 'scripted',
      name: 'Scripted',
      inputModalities: ['text'] as const,
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: 4_096 },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Boot the real service spine, then the bot registry on top. */
async function bench() {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-bot-composition-'))
  const ctx = new Context()
  onTestFinished(async () => { await rm(workspace, { recursive: true, force: true }) })

  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.provide('storageDomain' as string, facility)
  await ctx.plugin(JsonlSessionPersistence, { root: join(workspace, 'sessions'), compression: 'none' })
  await ctx.plugin(WorkspaceRegistry)
  ctx.provide('sessionTitle' as string, { rename: () => {} })
  ctx.provide('agentDefaultModel' as string, { currentSelection: () => ({ provider: 'mock', model: 'scripted' }) })

  const adapter = new TextAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)

  await ctx.plugin(BotRegistry)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, workspace, adapter, harness }
}

describe('bot composition', () => {
  it('opens the bot domain and registers the four tools', async () => {
    const { ctx } = await bench()
    expect(ctx.bots).toBeDefined()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('bot_create')
    expect(names).toContain('bot_open_ticket')
    expect(names).toContain('bot_report')
    expect(botDomainSpec.name).toBe('bot')
  })

  it('launches a real worker Session for a ticket and routes its report to the router', async () => {
    const { ctx, workspace, harness } = await bench()

    const router = await harness.create(routerId, { provider: 'mock', model: 'scripted' })
    const bot = await ctx.bots.create({
      name: 'reviewer',
      job: 'Review pull requests',
      workspace,
      routerSession: router.session.id,
    })
    const ticket = await ctx.bots.openTicket({
      routerSession: router.session.id,
      title: 'Review #12',
      instruction: 'Review the diff and report.',
    })

    expect(ticket.stage).toBe('working')
    const workerId = ticket.workerSession
    if (workerId === undefined) throw new Error('ticket launched without a worker Session')
    const worker = ctx.agents.get(workerId)
    if (worker === undefined) throw new Error('worker Session is not live')
    expect(worker.session.header.cwd).toBe(workspace)
    await worker.whenIdle()

    const notices: string[] = []
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      if (session.id !== router.session.id) return
      const source = event.data.source
      if (typeof source === 'object' && source !== null && source.kind === 'bot') {
        notices.push(event.data.content.map(block => block.type === 'text' ? block.text : '').join(''))
      }
    })

    const reported = await ctx.bots.report(workerId, ticket.id, { stage: 'ready', summary: 'No blockers.' })
    expect(reported.stage).toBe('ready')
    await router.whenIdle()
    expect(notices).toContain('Ticket "Review #12" is ready: No blockers.')
    expect(ctx.bots.ticketsOf(bot.id)).toHaveLength(1)
  })
})
