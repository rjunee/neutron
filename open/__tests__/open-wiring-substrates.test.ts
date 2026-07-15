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
import { replToolBridgeRef } from '@neutronai/runtime/adapters/claude-code/persistent/pool-state.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import { wireSubstrates } from '../wiring/substrates.ts'
import {
  resolveOpenModelProvider,
  resolveOpenOpenAiPool,
  buildOpenAiMcpResolver,
  buildOpenAiToolManifest,
  resolveOpenConversationalProvider,
} from '../composer.ts'

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

  test('O6: notice + recovered-reply sinks wire ONLY onto cc-agent-* (not cc-llm-*/trident)', async () => {
    const onDeadTurnNotice = (): void => {}
    const onSizeAlert = (): void => {}
    const onRateLimitBanner = (): void => {}
    const onRecoveredReply = (): void => {}
    const { ctx, captured } = makeCtx({
      liveAgentNoticeSinks: { onDeadTurnNotice, onSizeAlert, onRateLimitBanner },
      liveAgentRecoveredReplySink: onRecoveredReply,
      liveAgentDeliveryTopicId: 'app:owner',
    })
    const w = wireSubstrates(ctx)
    // Drain both conversational substrates + one ephemeral so all opts are captured.
    await drain(w.liveAgentSubstrate!)
    await drain(w.llmCallSubstrate!)
    await drain(w.makeEphemeralSubstrate('cc-trident')('/repo/x'))

    const agent = captured.find((o) => o.substrate_instance_id === 'cc-agent-owner')!
    // The owner's conversational REPL carries all four sinks + the delivery topic.
    expect(agent.onDeadTurnNotice).toBe(onDeadTurnNotice)
    expect(agent.onSizeAlert).toBe(onSizeAlert)
    expect(agent.onRateLimitBanner).toBe(onRateLimitBanner)
    expect(agent.onRecoveredReply).toBe(onRecoveredReply)
    expect(agent.delivery_topic_id).toBe('app:owner')

    // The phase-spec (cc-llm-*) + ephemeral trident substrates must NOT — a notice
    // there has no owner chat surface to deliver to (stderr-only default).
    const llm = captured.find((o) => o.substrate_instance_id === 'cc-llm-owner')!
    const trident = captured.find((o) => o.substrate_instance_id === 'cc-trident-owner')!
    for (const o of [llm, trident]) {
      expect(o.onDeadTurnNotice).toBeUndefined()
      expect(o.onSizeAlert).toBeUndefined()
      expect(o.onRateLimitBanner).toBeUndefined()
      expect(o.onRecoveredReply).toBeUndefined()
      expect(o.delivery_topic_id).toBeUndefined()
    }
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

describe('wireSubstrates — swappable provider (trident stays Claude Code)', () => {
  function openaiCtxOverrides(): Partial<OpenWiringContext> {
    return {
      provider: 'openai',
      openaiLlmPool: newCredentialPool({
        strategy: 'fill_first',
        credentials: [{ id: 'openai:k', kind: 'api_key', secret: 'sk-openai' }],
      }),
      bindMcpResolver: () => async () => ({}),
    }
  }

  /** A recording fetch capturing each OpenAI request body (SSE completion reply). */
  function recordingOpenAiFetch(): { fetchImpl: typeof fetch; bodies: Array<Record<string, unknown>> } {
    const bodies: Array<Record<string, unknown>> = []
    const sse =
      [
        { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
        { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } } } },
      ]
        .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
        .join('\n') + '\n'
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, bodies }
  }

  test('CAPABILITY PARITY (audit round 16): phase-spec (cc-llm) advertises NO tools; live-agent (cc-agent) advertises the manifest', async () => {
    const rec = recordingOpenAiFetch()
    const { ctx } = makeCtx({
      ...openaiCtxOverrides(),
      // A real MCP tool is in the manifest — it must reach ONLY the live-agent turn.
      toolManifest: () => [{ name: 'work_board_add', description: 'add', input_schema: { type: 'object' } }],
      openaiFetchImpl: rec.fetchImpl,
    })
    const w = wireSubstrates(ctx)
    // Phase-spec (onboarding, user-controlled) — must advertise NO MCP tools.
    await drain(w.llmCallSubstrate!)
    // Live-agent (post-onboarding chat) — mirrors enableToolBridge → tools present.
    await drain(w.liveAgentSubstrate!)
    expect(rec.bodies).toHaveLength(2)
    // bodies[0] = phase-spec: NO tools advertised (no privilege escalation).
    expect(rec.bodies[0]!['tools']).toBeUndefined()
    // bodies[1] = live-agent: the manifest tool IS advertised.
    const liveTools = (rec.bodies[1]!['tools'] as Array<{ name: string }> | undefined) ?? []
    expect(liveTools.map((t) => t.name)).toEqual(['work_board_add'])
  })

  test('provider=openai: trident-fire + ephemeral substrates STILL dispatch through the Claude Code factory', async () => {
    // The CC-typed `substrateFactory` is used ONLY by the anthropic path. If the
    // trident substrates recorded into `captured`, they are on Claude Code —
    // exactly the hard constraint (trident's Workflow inner loop is CC-only).
    const { ctx, captured } = makeCtx(openaiCtxOverrides())
    const w = wireSubstrates(ctx)
    await drain(w.makeWarmFireSubstrate('/repo/alpha'))
    await drain(w.makeEphemeralSubstrate('cc-trident')('/repo/one'))
    expect(captured.some((o) => o.substrate_instance_id.startsWith('cc-trident-fire-'))).toBe(true)
    expect(captured.some((o) => o.substrate_instance_id === 'cc-trident-owner')).toBe(true)
  })

  test('provider=openai: conversational substrates are built (non-null) and do NOT use the CC fake factory', async () => {
    const { ctx, captured } = makeCtx(openaiCtxOverrides())
    const w = wireSubstrates(ctx)
    // Constructed for the openai provider (routing to the gpt adapter happens at
    // dispatch — not exercised here to avoid a live HTTP call).
    expect(w.llmCallSubstrate).not.toBeNull()
    expect(w.liveAgentSubstrate).not.toBeNull()
    // The conversational substrates were NOT built on the CC fake path — only the
    // trident/ephemeral ones would be, and none were dispatched here.
    expect(captured.some((o) => o.substrate_instance_id === 'cc-agent-owner')).toBe(false)
    expect(captured.some((o) => o.substrate_instance_id === 'cc-llm-owner')).toBe(false)
  })

  test('OpenAI-ONLY box (llmPool null, openai pool present): conversational substrates are BUILT (Codex blocker fix)', () => {
    // Repro: NEUTRON_MODEL_PROVIDER=openai + OPENAI_API_KEY, NO Claude credential.
    // Pre-fix these nulled out because construction gated on the Anthropic llmPool.
    const { ctx } = makeCtx({ ...openaiCtxOverrides(), llmPool: null })
    const w = wireSubstrates(ctx)
    expect(w.llmCallSubstrate).not.toBeNull()
    expect(w.liveAgentSubstrate).not.toBeNull()
    // No Anthropic pool → no CC pre-warm fired (openai is stateless HTTP).
    expect(w.prewarmReady).toBeNull()
    expect(w.prewarmSettledRef.settled).toBe(true)
    // Trident stays Claude-Code-ONLY: with no Anthropic pool an autonomous build
    // cannot run, and the factory throws LOUDLY (never silently no-ops on GPT).
    expect(() => w.makeWarmFireSubstrate('/repo')).toThrow(/empty Anthropic credential pool/)
    expect(() => w.makeEphemeralSubstrate('cc-trident')('/repo')).toThrow(
      /empty Anthropic credential pool/,
    )
  })

  test('OPERATOR OVERRIDE: NEUTRON_OPENAI_MODEL on ctx.env is the model SENT on the wire (not the ambient global)', async () => {
    // Regression (audit round 11): the model preference must resolve from the
    // composer's SELECTED env (ctx.env), not global process.env. Drive a real GPT
    // dispatch through wireSubstrates + a recording fetch and assert body.model.
    let sentModel: unknown
    const recordingFetch = (async (_url: string | URL, init?: RequestInit) => {
      sentModel = (JSON.parse(String(init?.body)) as { model?: unknown }).model
      const sse =
        [
          { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
          { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } } } },
        ]
          .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
          .join('\n') + '\n'
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = makeCtx({
      ...openaiCtxOverrides(),
      // The composer's selected env carries the override; global process.env does NOT.
      env: { NEUTRON_OPENAI_MODEL: 'custom-model' } as unknown as NodeJS.ProcessEnv,
      openaiFetchImpl: recordingFetch,
    })
    const w = wireSubstrates(ctx)
    await drain(w.liveAgentSubstrate!)
    expect(sentModel).toBe('custom-model')
  })

  test('provider=openai but missing openai pool ⇒ FAILS LOUDLY (terminal error), NEVER silent Anthropic fallback', async () => {
    // An EXPLICIT openai selection must be honored even when incomplete — routing
    // the operator's prompts to Anthropic (the unselected provider) is the exact
    // silent-fallback bug this guards against (audit High).
    const { ctx, captured } = makeCtx({ provider: 'openai', openaiLlmPool: null, bindMcpResolver: () => async () => ({}) })
    const w = wireSubstrates(ctx)
    expect(w.liveAgentSubstrate).not.toBeNull()
    // Draining yields a LOUD terminal error and NEVER dispatches through the CC
    // fake factory (which only the anthropic path uses).
    const handle = w.liveAgentSubstrate!.start(SESSIONLESS_SPEC)
    const events: Event[] = []
    for await (const e of handle.events) events.push(e)
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.message).toMatch(/openai/i)
    // The Claude Code fake factory was NOT invoked — no silent Anthropic dispatch.
    expect(captured.some((o) => o.substrate_instance_id === 'cc-agent-owner')).toBe(false)
  })
})

describe('open composer — swappable provider boot helpers', () => {
  test('resolveOpenModelProvider reads NEUTRON_MODEL_PROVIDER, defaults anthropic, THROWS on typo', () => {
    expect(resolveOpenModelProvider({} as NodeJS.ProcessEnv)).toBe('anthropic')
    expect(resolveOpenModelProvider({ NEUTRON_MODEL_PROVIDER: 'openai' } as unknown as NodeJS.ProcessEnv)).toBe('openai')
    // Root-cause fix: an unknown value is a LOUD boot error, NOT a silent Claude fallback.
    expect(() =>
      resolveOpenModelProvider({ NEUTRON_MODEL_PROVIDER: 'nonsense' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/Unknown model provider 'nonsense'/)
  })

  test('resolveOpenOpenAiPool resolves an api_key pool from OPENAI_API_KEY, null otherwise', () => {
    expect(resolveOpenOpenAiPool({} as NodeJS.ProcessEnv)).toBeNull()
    const pool = resolveOpenOpenAiPool({ OPENAI_API_KEY: 'sk-o' } as unknown as NodeJS.ProcessEnv)
    expect(pool).not.toBeNull()
    expect(pool!.credentials[0]!.kind).toBe('api_key')
    expect(pool!.credentials[0]!.secret).toBe('sk-o')
  })

  test('buildOpenAiMcpResolver: the project-bound resolver throws loudly when the tool bridge is not yet wired', async () => {
    const resolver = buildOpenAiMcpResolver()({ project_id: 'proj-x' })
    await expect(resolver({ call_id: 'c', tool_name: 't', args: {} })).rejects.toThrow(/tool bridge not wired/i)
  })

  test('PROJECT SCOPING (audit High): the bound resolver forwards project_id to ReplToolBridge.dispatch', async () => {
    // The production defect: a project-scoped tool (work_board_*, dispatch, …)
    // invoked from a GPT turn must reach ReplToolBridge.dispatch WITH the active
    // project_id — exactly like the Claude path threads it. Assert the DISPATCHED
    // context carries the bound project.
    const dispatched: Array<{ tool_name: string; project_id: string | null | undefined }> = []
    const prev = replToolBridgeRef.current
    replToolBridgeRef.current = {
      listToolSchemas: () => [{ name: 'work_board_add', description: 'x', input_schema: { type: 'object' } }],
      dispatch: async (input: {
        tool_name: string
        args: unknown
        call_id: string
        project_id?: string | null
      }) => {
        dispatched.push({ tool_name: input.tool_name, project_id: input.project_id })
        return { ok: true }
      },
    }
    try {
      const resolver = buildOpenAiMcpResolver()({ project_id: 'proj-77' })
      await resolver({ call_id: 'c1', tool_name: 'work_board_add', args: { title: 't' } })
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]!.tool_name).toBe('work_board_add')
      expect(dispatched[0]!.project_id).toBe('proj-77')
    } finally {
      replToolBridgeRef.current = prev
    }
  })

  test('PROJECT SCOPING: an ABSENT project binds to null (General/default scope), matching the CC sink fallback', async () => {
    const dispatched: Array<{ project_id: string | null | undefined }> = []
    const prev = replToolBridgeRef.current
    replToolBridgeRef.current = {
      listToolSchemas: () => [],
      dispatch: async (input: { project_id?: string | null }) => {
        dispatched.push({ project_id: input.project_id })
        return {}
      },
    }
    try {
      const resolver = buildOpenAiMcpResolver()({}) // no project_id
      await resolver({ call_id: 'c', tool_name: 't', args: {} })
      expect(dispatched[0]!.project_id).toBeNull()
    } finally {
      replToolBridgeRef.current = prev
    }
  })
})

describe('resolveOpenConversationalProvider — every declared value dispatches coherently', () => {
  const deps = (openaiKeyPresent: boolean) => ({
    resolveOpenAiPool: () =>
      openaiKeyPresent
        ? newCredentialPool({ strategy: 'fill_first', credentials: [{ id: 'openai:k', kind: 'api_key' as const, secret: 'sk' }] })
        : null,
    buildMcpResolver: buildOpenAiMcpResolver,
    buildToolManifest: buildOpenAiToolManifest,
  })

  test('unset / anthropic → {} (Claude Code, no provider override)', () => {
    expect(resolveOpenConversationalProvider({} as NodeJS.ProcessEnv, deps(false))).toEqual({})
    expect(
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'anthropic' } as unknown as NodeJS.ProcessEnv,
        deps(false),
      ),
    ).toEqual({})
  })

  test('openai + OPENAI_API_KEY → fully-wired GPT ctx', () => {
    const ctx = resolveOpenConversationalProvider(
      { NEUTRON_MODEL_PROVIDER: 'openai' } as unknown as NodeJS.ProcessEnv,
      deps(true),
    )
    expect(ctx.provider).toBe('openai')
    expect(ctx.openaiLlmPool).not.toBeNull()
    expect(ctx.openaiLlmPool).toBeDefined()
    expect(typeof ctx.bindMcpResolver).toBe('function')
    expect(typeof ctx.toolManifest).toBe('function')
  })

  test('openai WITHOUT a key → honored (provider set) so turns fail LOUD, NOT a silent Claude fallback', () => {
    const ctx = resolveOpenConversationalProvider(
      { NEUTRON_MODEL_PROVIDER: 'openai' } as unknown as NodeJS.ProcessEnv,
      deps(false),
    )
    expect(ctx.provider).toBe('openai')
    expect(ctx.openaiLlmPool).toBeUndefined() // no key → substrate fails loud per turn
  })

  test('typo like "openaii" (unknown value) → THROWS at the normalizer, NOT a silent {} Claude fallback', () => {
    expect(() =>
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'openaii' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      ),
    ).toThrow(/Unknown model provider 'openaii'/)
    // Mutation check: must NOT silently return {} (Claude fallback) on a typo.
    let threw = false
    try {
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'garbage-value' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  test('openai-codex-cli (declared but NOT production-wired) → THROWS a loud boot error (never silent Claude)', () => {
    expect(() =>
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'openai-codex-cli' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      ),
    ).toThrow(/not.*production-wired|refusing to boot/i)
    // Mutation check: it must NOT silently return {} (Claude fallback).
    let threw = false
    try {
      resolveOpenConversationalProvider(
        { NEUTRON_MODEL_PROVIDER: 'openai-codex-cli' } as unknown as NodeJS.ProcessEnv,
        deps(true),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
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
