/**
 * REGRESSION — a fired reminder must NEVER disturb the owner's chat session.
 *
 * THE INCIDENT (live instance, 2026-08-17). Three consecutive journal lines:
 *
 *   [reminder-dispatcher] event=nudge_degraded route=compose_failed
 *       reason="SubstrateCallError: cc-llm-call: aborted"
 *   [repl] evicting abandon-poisoned warm session=… key-respawn
 *       (prior turn abandoned before reply; clean respawn for the next turn)
 *   [live-agent-turn] event=turn_failed error="cc-llm-call: persistent-repl: REPL
 *       process exited"
 *
 * …after which the owner could not send a single chat message until the service
 * was restarted. One background compose aborted and took his session with it.
 *
 * THE MECHANISM, and why it could only ever be fixed by separating the sessions:
 *   - the fire-time composer drains with an abort signal, and that drain cancels
 *     the handle when the signal fires (`runtime/collect-tokens.ts`,
 *     `keepAliveExempt: true`);
 *   - cancelling an UNSETTLED turn poisons the warm session
 *     (`runtime/adapters/claude-code/persistent/pool.ts:678`);
 *   - the next dispatch on that pool key evicts and respawns the child
 *     (`runtime/adapters/claude-code/persistent/spawn.ts:862-866`);
 *   - and the pool key STARTS with `substrate_instance_id`
 *     (`persistent/pool.ts` `poolKeyFor`), so composing on `cc-agent-*` meant the
 *     poisoned session WAS the owner's chat session.
 *
 * Matching the live-chat `--tools` surface and the live-chat model (the two
 * earlier patches at that call site) could stop an eviction caused by a MISMATCH.
 * Neither could stop an eviction caused by a FAILURE. Only a distinct pool key
 * can, which is what `cc-nudge-*` is.
 *
 * These tests model the pool with the REAL `poolKeyFor` and the real poison rule,
 * so they fail the moment background composition is pointed back at `cc-agent-*`.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import { buildSubstrateReminderLlm } from '@neutronai/reminders/dispatcher.ts'
import { poolKeyFor } from '@neutronai/runtime/adapters/claude-code/persistent/pool.ts'
import type { PersistentReplSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { githubSpawnEnvRef } from '@neutronai/gateway/wiring/substrate-profiles.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireSubstrates } from '../wiring/substrates.ts'

/** One warm child per pool key, exactly as the persistent pool holds it. */
interface WarmChild {
  /** Bumped on every respawn — a change means the owner lost his session. */
  generation: number
  poisoned: boolean
}

const keyFor = (opts: ClaudeCodeSubstrateOptions): string =>
  poolKeyFor(opts as unknown as PersistentReplSubstrateOptions)

/**
 * The subset of the persistent REPL pool this regression is about: reuse the warm
 * child for a pool key, evict + respawn it when a prior turn left it poisoned, and
 * poison it when a turn is cancelled before it settles.
 */
function warmPoolModel(): {
  acquire: (opts: ClaudeCodeSubstrateOptions) => WarmChild
  poison: (opts: ClaudeCodeSubstrateOptions) => void
} {
  const children = new Map<string, WarmChild>()
  return {
    acquire: (opts): WarmChild => {
      const key = keyFor(opts)
      const existing = children.get(key)
      if (existing !== undefined && !existing.poisoned) return existing
      const respawned: WarmChild = { generation: (existing?.generation ?? 0) + 1, poisoned: false }
      children.set(key, respawned)
      return respawned
    },
    poison: (opts): void => {
      const child = children.get(keyFor(opts))
      if (child !== undefined) child.poisoned = true
    },
  }
}

/** A turn whose prompt asks it to hang: it never settles until someone cancels. */
const HANG = 'HANG'

function makeCtx(): {
  ctx: OpenWiringContext
  spawnedFor: (instance_id: string) => ClaudeCodeSubstrateOptions | undefined
} {
  const pool = warmPoolModel()
  const captured: ClaudeCodeSubstrateOptions[] = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    captured.push(opts)
    return {
      start(spec: AgentSpec): SessionHandle {
        const child = pool.acquire(opts)
        let settled = false
        let releaseHang: (() => void) | undefined
        const events = (async function* (): AsyncGenerator<Event, void, void> {
          if (spec.prompt.includes(HANG)) {
            await new Promise<void>((resolve) => {
              releaseHang = resolve
            })
            return
          }
          // The generation that served this turn — a respawn is observable as a bump.
          yield { kind: 'token', text: 'gen' + String(child.generation) }
          settled = true
          yield {
            kind: 'completion',
            usage: { input_tokens: 1, output_tokens: 1 },
            substrate_instance_id: opts.substrate_instance_id,
          }
        })()
        return {
          events,
          async respondToTool(): Promise<void> {},
          async cancel(): Promise<void> {
            // `persistent/pool.ts:678` — cancelling an UNSETTLED turn poisons the
            // warm session; a settled one is a no-op.
            if (!settled) pool.poison(opts)
            releaseHang?.()
          },
          tool_resolution: 'internal',
        }
      },
    }
  }
  const ctx: OpenWiringContext = {
    llmPool: newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'anthropic:test', kind: 'api_key', secret: 'sk-test' }],
    }),
    owner_handle: 'owner',
    owner_home: '/tmp/owner-home',
    project_slug: 'owner',
    env: {} as NodeJS.ProcessEnv,
    db: {} as OpenWiringContext['db'],
    substrateFactory,
    prewarmSubstrate: async (): Promise<void> => {},
  }
  return {
    ctx,
    spawnedFor: (instance_id) => captured.find((o) => o.substrate_instance_id === instance_id),
  }
}

/** Drive one turn to completion and return its accumulated text (`gen<N>`). */
async function turn(sub: Substrate, prompt: string): Promise<string> {
  const handle = sub.start({ prompt, tools: [], model_preference: ['sonnet'] })
  let text = ''
  for await (const ev of handle.events) {
    if (ev.kind === 'token') text += ev.text
  }
  return text
}

beforeEach(() => {
  githubSpawnEnvRef.resolve = undefined
})

describe('background composition runs on its own REPL', () => {
  test('the nudge substrate does not share a pool key with the owner chat', async () => {
    const { ctx, spawnedFor } = makeCtx()
    const w = wireSubstrates(ctx)
    expect(w.reminderComposeSubstrate).not.toBeNull()
    await turn(w.liveAgentSubstrate!, 'hello')
    await turn(w.reminderComposeSubstrate!, 'compose a nudge')

    const chat = spawnedFor('cc-agent-owner')
    const nudge = spawnedFor('cc-nudge-owner')
    expect(chat).toBeDefined()
    expect(nudge).toBeDefined()
    expect(keyFor(nudge!)).not.toBe(keyFor(chat!))
    // …but it is the SAME TRUST CLASS. A ritual composes on this lane and ISSUES
    // #504 settled that it must reach Core tools, so tightening the grants here
    // would rebuild the `cc-ritual-*` sandbox that broke the morning brief.
    // The split is the SESSION, not the capability.
    expect(nudge!.enableToolBridge).toBe(true)
    expect(nudge!.skip_permissions).toBe(chat!.skip_permissions)
    expect(nudge!.frontier_model_floor).toBe(chat!.frontier_model_floor)
  })

  test('an ABORTED reminder compose leaves the warm chat session usable', async () => {
    const { ctx } = makeCtx()
    const w = wireSubstrates(ctx)

    // The owner is mid-conversation on a warm child.
    expect(await turn(w.liveAgentSubstrate!, 'hello')).toBe('gen1')

    // A reminder comes due and its composition times out — the exact shape of the
    // incident: `cc-llm-call: aborted`, produced by the drain's own abort watchdog.
    const llm = buildSubstrateReminderLlm(w.reminderComposeSubstrate!, { timeout_ms: 5 })
    await expect(
      llm.compose({ prompt: HANG, tools: [], model_preference: ['sonnet'] }),
    ).rejects.toThrow(/aborted/)

    // His NEXT chat turn must land on the SAME warm child. `gen2` here would mean
    // the background failure evicted and respawned the session he is talking to —
    // which is the outage, one turn before the owner sees it.
    expect(await turn(w.liveAgentSubstrate!, 'still there?')).toBe('gen1')
  })

  test('the background lane poisons only ITSELF', async () => {
    const { ctx } = makeCtx()
    const w = wireSubstrates(ctx)
    const llm = buildSubstrateReminderLlm(w.reminderComposeSubstrate!, { timeout_ms: 5 })
    await expect(
      llm.compose({ prompt: HANG, tools: [], model_preference: ['sonnet'] }),
    ).rejects.toThrow(/aborted/)
    // Its own next turn respawns a clean child (the designed self-heal)…
    expect(await turn(w.reminderComposeSubstrate!, 'compose')).toBe('gen2')
    // …while the owner's chat has never respawned at all.
    expect(await turn(w.liveAgentSubstrate!, 'hello')).toBe('gen1')
  })
})

describe('the composer binds background composition to the background substrate', () => {
  // The behavioural tests above prove the SUBSTRATES are separable. This one pins
  // the WIRING — the defect was never that a separate substrate could not exist,
  // it was that both timer-driven callers were handed the chat one.
  const composerSrc = readFileSync(join(import.meta.dir, '..', 'composer.ts'), 'utf8')

  test('no timer-driven composer is wrapped around liveAgentSubstrate', () => {
    expect(composerSrc).not.toContain('buildSubstrateReminderLlm(liveAgentSubstrate)')
  })

  test('both timer-driven callers wrap the background substrate', () => {
    const wraps = composerSrc.match(/buildSubstrateReminderLlm\(([A-Za-z]+)\)/g) ?? []
    // The fired-reminder dispatcher and the work-board wakeup.
    expect(wraps.length).toBe(2)
    for (const wrap of wraps) {
      expect(wrap).toBe('buildSubstrateReminderLlm(reminderComposeSubstrate)')
    }
  })
})
