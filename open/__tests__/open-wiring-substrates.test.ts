/**
 * Focused unit coverage for `open/wiring/substrates.ts` (C3a carve).
 *
 * Constructs `wireSubstrates` with a fake wiring context + a capturing fake
 * `substrateFactory`, then dispatches each returned substrate/factory to pin the
 * CARE invariants the carve must preserve:
 *   - substrate instance-id prefixes are byte-identical (`cc-llm-`, `cc-agent-`,
 *     ephemeral `cc-trident-*`, warm `cc-trident-fire-*`);
 *   - `enableToolBridge: true` ONLY on `cc-agent-*`; the rest omit it;
 *   - `cc-trident-fire-*` is WARM per repo cwd (Map cache: same cwd → same id +
 *     same instance; distinct cwd → distinct id) and NON-ephemeral;
 *   - `prewarmReady` never rejects and `prewarmSettledRef.settled` flips true
 *     only AFTER the pre-warm resolves (live reference, not a boot snapshot);
 *   - LLM-less (`llmPool: null`) leaves the warm substrates null and the
 *     factories throwing.
 */

import { describe, expect, test } from 'bun:test'

import { newCredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireSubstrates } from '../wiring/substrates.ts'

function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'token', text: 'ok' }
    yield {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: instanceId,
    }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

const SESSIONLESS_SPEC: AgentSpec = { prompt: 'x', tools: [], model_preference: ['sonnet'] }

function makeCtx(
  overrides: Partial<OpenWiringContext> = {},
): { ctx: OpenWiringContext; captured: ClaudeCodeSubstrateOptions[]; prewarmCalls: Substrate[] } {
  const captured: ClaudeCodeSubstrateOptions[] = []
  const prewarmCalls: Substrate[] = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    captured.push(opts)
    return { start: () => cannedHandle(opts.substrate_instance_id) }
  }
  const ctx: OpenWiringContext = {
    llmPool: newCredentialPool({
      strategy: 'fill_first',
      credentials: [{ id: 'anthropic:test', kind: 'api_key', secret: 'sk-test' }],
    }),
    internal_handle: 'owner',
    owner_home: '/tmp/owner-home',
    project_slug: 'owner',
    env: {} as NodeJS.ProcessEnv,
    db: {} as OpenWiringContext['db'],
    substrateFactory,
    prewarmSubstrate: async (s: Substrate): Promise<void> => {
      prewarmCalls.push(s)
    },
    ...overrides,
  }
  return { ctx, captured, prewarmCalls }
}

/** Drain a session handle's events so the fake factory records its opts. */
async function drain(sub: Substrate): Promise<void> {
  const handle = sub.start(SESSIONLESS_SPEC)
  for await (const _ of handle.events) {
    /* consume */
  }
}

describe('wireSubstrates — instance ids + tool-bridge invariants', () => {
  test('cc-llm-* phase-spec substrate omits the tool bridge', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    expect(w.llmCallSubstrate).not.toBeNull()
    await drain(w.llmCallSubstrate!)
    const opts = captured.find((o) => o.substrate_instance_id === 'cc-llm-owner')
    expect(opts).toBeDefined()
    expect(opts!.enableToolBridge).not.toBe(true)
    expect(opts!.ephemeral).not.toBe(true)
    expect(opts!.skip_permissions).toBe(true)
  })

  test('ONLY cc-agent-* opts into the tool bridge', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    expect(w.liveAgentSubstrate).not.toBeNull()
    await drain(w.liveAgentSubstrate!)
    const opts = captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')
    expect(opts).toBeDefined()
    expect(opts!.enableToolBridge).toBe(true)
    expect(opts!.ephemeral).not.toBe(true)
    expect(opts!.skip_permissions).toBe(true)
  })

  test('makeEphemeralSubstrate builds a per-cwd ephemeral cc-<prefix>-* substrate (no bridge)', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    const sub = w.makeEphemeralSubstrate('cc-trident')('/repo/one')
    await drain(sub)
    const opts = captured.find((o) => o.substrate_instance_id === 'cc-trident-owner')
    expect(opts).toBeDefined()
    expect(opts!.ephemeral).toBe(true)
    expect(opts!.enableToolBridge).not.toBe(true)
    expect(opts!.cwd).toBe('/repo/one')
  })

  test('makeWarmFireSubstrate is WARM per repo cwd: cached same-cwd, distinct id per cwd, no bridge, not ephemeral', async () => {
    const { ctx, captured } = makeCtx()
    const w = wireSubstrates(ctx)
    const a1 = w.makeWarmFireSubstrate('/repo/alpha')
    const a2 = w.makeWarmFireSubstrate('/repo/alpha')
    const b1 = w.makeWarmFireSubstrate('/repo/beta')
    // Same cwd → the SAME cached substrate instance (warm reuse).
    expect(a1).toBe(a2)
    // Distinct cwd → a distinct substrate.
    expect(a1).not.toBe(b1)
    await drain(a1)
    await drain(b1)
    const fireOpts = captured.filter((o) => o.substrate_instance_id.startsWith('cc-trident-fire-'))
    const ids = new Set(fireOpts.map((o) => o.substrate_instance_id))
    // Two distinct repo cwds → two distinct fire instance ids.
    expect(ids.size).toBe(2)
    for (const o of fireOpts) {
      expect(o.enableToolBridge).not.toBe(true)
      expect(o.ephemeral).not.toBe(true)
    }
  })
})

describe('wireSubstrates — pre-warm live reference', () => {
  test('prewarmReady never rejects and prewarmSettledRef flips true only after it resolves', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => {
      release = res
    })
    const { ctx } = makeCtx({
      prewarmSubstrate: async (): Promise<void> => {
        await gate
      },
    })
    const w = wireSubstrates(ctx)
    expect(w.prewarmReady).not.toBeNull()
    // Not settled while the pre-warm is still in flight.
    expect(w.prewarmSettledRef.settled).toBe(false)
    // Never rejects.
    let rejected = false
    void w.prewarmReady!.catch(() => {
      rejected = true
    })
    release()
    await w.prewarmReady
    // The `.then` flipped the LIVE reference — the composer's cold-window read
    // now sees true.
    expect(w.prewarmSettledRef.settled).toBe(true)
    expect(rejected).toBe(false)
  })

  test('LLM-less: warm substrates null, prewarm skipped (settled true), factories throw', () => {
    const { ctx } = makeCtx({ llmPool: null })
    const w = wireSubstrates(ctx)
    expect(w.llmCallSubstrate).toBeNull()
    expect(w.liveAgentSubstrate).toBeNull()
    expect(w.prewarmReady).toBeNull()
    // No pre-warm to await → settled seeds true immediately.
    expect(w.prewarmSettledRef.settled).toBe(true)
    expect(() => w.makeEphemeralSubstrate('cc-trident')('/repo')).toThrow(
      'cc-trident: empty Anthropic credential pool',
    )
    expect(() => w.makeWarmFireSubstrate('/repo')).toThrow(
      'cc-trident-fire: empty Anthropic credential pool',
    )
    expect(w.cleanups).toEqual([])
  })
})
