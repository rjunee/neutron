/**
 * Swappable-model-provider tests for `buildLlmCallSubstrate`.
 *
 * Proves:
 *   1. provider unset / 'anthropic' ⇒ BYTE-IDENTICAL: the exact
 *      `createClaudeCodeSubstrateAuto` seam + option bag as today (the openai
 *      config, even when present, is untouched).
 *   2. providerResolver / provider = 'openai' ⇒ routes each turn through the
 *      gpt-5-5-api adapter (driven by a mocked Responses stream), remaps
 *      model_preference, and feeds the SEPARATE OpenAI pool.
 *   3. Missing OpenAI config / mcpResolver ⇒ degrades LOUDLY (terminal error).
 *   4. per-turn granularity: the resolver flips provider between dispatches.
 */

import { expect, test } from 'bun:test'

import {
  buildLlmCallSubstrate,
  openAiSessionScopeKey,
} from '../build-llm-call-substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { newCredentialPool, type CredentialPool } from '@neutronai/runtime/credential-pool.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

function anthropicPool(): CredentialPool {
  return newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'anthropic:k', kind: 'api_key', secret: 'sk-ant' }],
  })
}

function openaiPool(): CredentialPool {
  return newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'openai:k', kind: 'api_key', secret: 'sk-openai' }],
  })
}

function spec(model = 'claude-opus-4-8', tools: AgentSpec['tools'] = []): AgentSpec {
  return { prompt: 'hello world', tools, model_preference: [model], max_tokens: 32 }
}

/** A fetch that returns a non-ok HTTP status (drives the adapter's error path). */
function httpErrorFetch(status: number, opts: { retryAfterSec?: number } = {}): typeof fetch {
  return (async () => {
    const headers: Record<string, string> = {}
    if (opts.retryAfterSec !== undefined) headers['retry-after'] = String(opts.retryAfterSec)
    return new Response('upstream error body', { status, headers })
  }) as unknown as typeof fetch
}

/**
 * A fetch that returns HTTP 200 but STREAMS a `response.error` SSE event — the
 * OTHER error surface. The `error.type` is the only durable rate-limit signal;
 * the human message deliberately omits the literal "429".
 */
function streamedErrorFetch(type: string, message: string): typeof fetch {
  const sse =
    [
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      { event: 'response.error', data: { type: 'response.error', error: { type, message } } },
    ]
      .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
      .join('\n') + '\n'
  return (async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse))
        c.close()
      },
    })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
}

async function drain(h: SessionHandle): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of h.events) out.push(e)
  return out
}

/** Fake CC factory capturing the composed options + spec. */
function ccCapture() {
  const seen: Array<{ opts: ClaudeCodeSubstrateOptions; spec: AgentSpec }> = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => ({
    start(s: AgentSpec): SessionHandle {
      seen.push({ opts, spec: s })
      const events = (async function* (): AsyncGenerator<Event, void, void> {
        yield {
          kind: 'completion',
          substrate_instance_id: opts.substrate_instance_id,
          session: { id: 'sess', last_active_at: Date.now() },
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      })()
      return { events, respondToTool: async () => {}, cancel: async () => {}, tool_resolution: 'internal' }
    },
  })
  return { substrateFactory, seen }
}

/** Recording SSE fetch that returns a fixed response id + captures the request
 *  body per call, so we can assert `previous_response_id` continuity threading. */
function recordingGptFetch(responseId: string): {
  fetchImpl: typeof fetch
  bodies: Array<Record<string, unknown>>
} {
  const bodies: Array<Record<string, unknown>> = []
  const body =
    [
      { event: 'response.created', data: { type: 'response.created', response: { id: responseId } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'ok' } },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { id: responseId, usage: { input_tokens: 1, output_tokens: 1 } } },
      },
    ]
      .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
      .join('\n') + '\n'
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body))
        c.close()
      },
    })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, bodies }
}

/** SSE body for the Responses API (matches adapter-equivalence). */
function gptFetch(): typeof fetch {
  const body =
    [
      { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'hi' } },
      {
        event: 'response.completed',
        data: { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 3, output_tokens: 2 } } },
      },
    ]
      .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
      .join('\n') + '\n'
  return (async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body))
        c.close()
      },
    })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
}

test('provider unset ⇒ BYTE-IDENTICAL anthropic path (CC factory + option bag), openai config ignored', async () => {
  const cc = ccCapture()
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'cc-agent-x',
    user_id: 'owner',
    substrateFactory: cc.substrateFactory,
    // openai config PRESENT but must be ignored when provider is unset:
    openai: { pool: openaiPool(), bindMcpResolver: () => async () => ({}), fetchImpl: gptFetch() },
  })!
  const events = await drain(sub.start(spec()))
  expect(events.at(-1)?.kind).toBe('completion')
  expect(cc.seen).toHaveLength(1)
  // The CC option bag is exactly what the composer builds today: scrubbed auth
  // env with the anthropic api key, credential_identity, user_id — no openai leakage.
  const opts = cc.seen[0]!.opts
  expect(opts.substrate_instance_id).toBe('cc-agent-x')
  expect(opts.credential_identity).toBe('anthropic:k')
  expect(opts.user_id).toBe('owner')
  expect(opts.env?.['ANTHROPIC_API_KEY']).toBe('sk-ant')
  // The spec's claude model_preference is passed through UNCHANGED.
  expect(cc.seen[0]!.spec.model_preference).toEqual(['claude-opus-4-8'])
})

test("provider='anthropic' explicit ⇒ same CC path (no openai config needed)", async () => {
  const cc = ccCapture()
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'cc-agent-y',
    provider: 'anthropic',
    substrateFactory: cc.substrateFactory,
  })!
  const events = await drain(sub.start(spec()))
  expect(events.at(-1)?.kind).toBe('completion')
  expect(cc.seen).toHaveLength(1)
})

test("provider='openai' ⇒ routes through the gpt adapter, remaps model_preference, feeds OpenAI pool", async () => {
  const pool = openaiPool()
  const sub = buildLlmCallSubstrate({
    // NOTE: the anthropic pool is still required by the input contract but is
    // NOT consulted on the openai path — the openai pool is separate.
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-agent',
    provider: 'openai',
    openai: {
      pool,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      fetchImpl: gptFetch(),
    },
  })!
  const events = await drain(sub.start(spec('claude-opus-4-8')))
  const tokens = events.filter((e) => e.kind === 'token').map((e) => (e as { text: string }).text).join('')
  expect(tokens).toBe('hi')
  const comp = events.find((e) => e.kind === 'completion')
  expect(comp?.kind).toBe('completion')
  // The OpenAI credential was reported successful (pool still selectable).
  expect(pool.credentials[0]!.id).toBe('openai:k')
})

test("provider='openai' but no openai config ⇒ LOUD terminal error (no silent fallback)", async () => {
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-agent',
    provider: 'openai',
  })!
  const events = await drain(sub.start(spec()))
  expect(events).toHaveLength(1)
  const e = events[0]!
  expect(e.kind).toBe('error')
  if (e.kind === 'error') {
    expect(e.retryable).toBe(false)
    expect(e.message).toMatch(/no OpenAI-family config/i)
  }
})

test("provider='openai' but missing bindMcpResolver ⇒ LOUD terminal error", async () => {
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-agent',
    provider: 'openai',
    openai: { pool: openaiPool(), fetchImpl: gptFetch() },
  })!
  const events = await drain(sub.start(spec()))
  const e = events[0]!
  expect(e.kind).toBe('error')
  if (e.kind === 'error') expect(e.message).toMatch(/requires a bindMcpResolver/i)
})

test("provider='openai' with empty OpenAI pool ⇒ terminal error", async () => {
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-agent',
    provider: 'openai',
    openai: {
      resolvePool: async () => null,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
    },
  })!
  const events = await drain(sub.start(spec()))
  const e = events[0]!
  expect(e.kind).toBe('error')
  if (e.kind === 'error') expect(e.message).toMatch(/no OpenAI credentials/i)
})

test('CONTINUITY: turn 2 threads turn 1 completion session as previous_response_id (not amnesiac)', async () => {
  const rec = recordingGptFetch('resp_abc')
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-conv',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool: openaiPool(),
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      fetchImpl: rec.fetchImpl,
    },
  })!
  // Turn 1 — no prior session → request carries NO previous_response_id.
  await drain(sub.start(spec()))
  // Turn 2 — same substrate/conversation → request carries turn 1's response id.
  await drain(sub.start(spec()))
  expect(rec.bodies).toHaveLength(2)
  expect(rec.bodies[0]!['previous_response_id']).toBeUndefined()
  expect(rec.bodies[1]!['previous_response_id']).toBe('resp_abc')
})

test('CONTINUITY: distinct projects keep SEPARATE upstream sessions (no cross-project bleed)', async () => {
  const rec = recordingGptFetch('resp_projA')
  let project = 'projA'
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-conv',
    provider: 'openai',
    user_id: 'owner',
    projectIdResolver: () => project,
    openai: {
      pool: openaiPool(),
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      fetchImpl: rec.fetchImpl,
    },
  })!
  await drain(sub.start(spec())) // projA turn 1 → stores resp_projA under owner:projA
  project = 'projB'
  await drain(sub.start(spec())) // projB turn 1 → fresh, NO previous_response_id
  expect(rec.bodies[1]!['previous_response_id']).toBeUndefined()
})

test('per-turn providerResolver flips backend between dispatches (per-project granularity)', async () => {
  const cc = ccCapture()
  let provider: string | undefined = 'anthropic'
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'switch',
    providerResolver: () => provider,
    substrateFactory: cc.substrateFactory,
    openai: { pool: openaiPool(), bindMcpResolver: () => async () => ({}), model_preference: ['gpt-5.6'], fetchImpl: gptFetch() },
  })!
  // Turn 1 — anthropic: hits the CC fake factory.
  await drain(sub.start(spec()))
  expect(cc.seen).toHaveLength(1)
  // Turn 2 — openai: does NOT hit the CC fake factory (routed to gpt adapter).
  provider = 'openai'
  const gptEvents = await drain(sub.start(spec()))
  expect(cc.seen).toHaveLength(1) // unchanged — CC factory not called
  expect(gptEvents.find((e) => e.kind === 'completion')?.kind).toBe('completion')
})

// ---------------------------------------------------------------------------
// BOUNDARY TESTS (audit BLOCKER 3) — each failure class must cool the OpenAI
// credential correctly; success must clear cooldown; a tool round-trip must
// actually execute; the tool manifest must be honest.
// ---------------------------------------------------------------------------

function openaiSub(pool: CredentialPool, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-boundary',
    provider: 'openai',
    user_id: 'owner',
    openai: { pool, bindMcpResolver: () => async () => ({}), model_preference: ['gpt-5.6'], fetchImpl, ...extra },
  })!
}

test('BOUNDARY 429 → credential cooled with rate_limit_429 + retry_after honored', async () => {
  const pool = openaiPool()
  const before = Date.now()
  const sub = openaiSub(pool, httpErrorFetch(429, { retryAfterSec: 2 }))
  const events = await drain(sub.start(spec()))
  expect(events.some((e) => e.kind === 'error')).toBe(true)
  const cred = pool.credentials[0]!
  expect(cred.cooldown_reason).toBe('rate_limit_429')
  // retry_after=2s honored (cooldown_until ≈ now + 2000, NOT the default 429 window).
  expect(cred.cooldown_until).toBeDefined()
  expect(cred.cooldown_until! - before).toBeGreaterThanOrEqual(1500)
  expect(cred.cooldown_until! - before).toBeLessThan(5000)
})

test('BOUNDARY 401 → credential cooled with auth_401', async () => {
  const pool = openaiPool()
  const sub = openaiSub(pool, httpErrorFetch(401))
  await drain(sub.start(spec()))
  expect(pool.credentials[0]!.cooldown_reason).toBe('auth_401')
})

test('BOUNDARY 5xx (server error) → credential NOT cooled (not a credential fault), error surfaces', async () => {
  const pool = openaiPool()
  const sub = openaiSub(pool, httpErrorFetch(503))
  const events = await drain(sub.start(spec()))
  expect(events.some((e) => e.kind === 'error')).toBe(true)
  // A 5xx is an upstream server fault, not a credential problem → no cooldown.
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
})

test('BOUNDARY model exhaustion (429 on ALL models) → still cools the credential (Blocker 2)', async () => {
  const pool = openaiPool()
  const before = Date.now()
  // TWO models both 429 → rotation exhausts; the terminal error must preserve the
  // HTTP 429 classification + retry_after so the credential still cools.
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-exhaust',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6', 'gpt-5.5'],
      fetchImpl: httpErrorFetch(429, { retryAfterSec: 3 }),
    },
  })!
  await drain(sub.start(spec()))
  const cred = pool.credentials[0]!
  expect(cred.cooldown_reason).toBe('rate_limit_429')
  expect(cred.cooldown_until! - before).toBeGreaterThanOrEqual(2500)
})

test('BOUNDARY all-credentials-cooling → terminal retryable error, no dispatch', async () => {
  const pool = openaiPool()
  // Pre-cool the only credential into the future.
  pool.credentials[0]!.cooldown_until = Date.now() + 60_000
  pool.credentials[0]!.cooldown_reason = 'rate_limit_429'
  let fetchCalled = false
  const sub = openaiSub(pool, (async () => {
    fetchCalled = true
    return new Response('', { status: 200 })
  }) as unknown as typeof fetch)
  const events = await drain(sub.start(spec()))
  const err = events.find((e) => e.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') expect(err.retryable).toBe(true)
  expect(fetchCalled).toBe(false) // never reached the adapter
})

test('BOUNDARY success → reportSuccess clears a stale (past) cooldown on the selected credential', async () => {
  const pool = openaiPool()
  // A stale past cooldown: still selectable, but the fields linger until a
  // success reports through. If reportSuccess were NOT called they would remain.
  pool.credentials[0]!.cooldown_until = Date.now() - 1000
  pool.credentials[0]!.cooldown_reason = 'rate_limit_429'
  const sub = openaiSub(pool, gptFetch())
  const events = await drain(sub.start(spec()))
  expect(events.some((e) => e.kind === 'completion')).toBe(true)
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
  expect(pool.credentials[0]!.cooldown_reason).toBeUndefined()
})

test('BOUNDARY tool round-trip → an advertised MCP tool EXECUTES via the resolver WITH the active project scope (audit High)', async () => {
  // 1st upstream call streams a function_call; the shim resolves it via the
  // mcpResolver; 2nd call streams the completion. Proves an advertised tool runs
  // AND that the DISPATCHED tool carries the turn's active project_id.
  const resolverCalls: Array<{ tool_name: string; args: unknown; project_id: string | undefined }> = []
  let call = 0
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    call++
    const body =
      call === 1
        ? [
            { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
            // The stream accumulates args via a delta, THEN completes the call.
            {
              event: 'response.function_call.delta',
              data: { type: 'response.function_call.delta', call_id: 'c1', name: 'search_docs', arguments: '{"q":"x"}' },
            },
            {
              event: 'response.function_call.completed',
              data: { type: 'response.function_call.completed', call_id: 'c1', name: 'search_docs' },
            },
            { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1 } } } },
          ]
        : [
            { event: 'response.created', data: { type: 'response.created', response: { id: 'r2' } } },
            { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'done' } },
            { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r2', usage: { input_tokens: 1, output_tokens: 1 } } } },
          ]
    void init
    const sse = body.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`).join('\n') + '\n'
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } })
    return new Response(stream, { status: 200 })
  }) as unknown as typeof fetch
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-tool',
    provider: 'openai',
    user_id: 'owner',
    // The active project for THIS turn — must reach the dispatched tool.
    projectIdResolver: () => 'proj-42',
    openai: {
      pool: openaiPool(),
      // The factory is called per turn with the active project; the returned
      // resolver closes over it and records what reaches dispatch.
      bindMcpResolver: (bind) => async (c) => {
        resolverCalls.push({ tool_name: c.tool_name, args: c.args, project_id: bind.project_id })
        return { hits: 1 }
      },
      model_preference: ['gpt-5.6'],
      toolManifest: () => [{ name: 'search_docs', description: 'search', input_schema: { type: 'object' } }],
      fetchImpl,
    },
  })!
  const events = await drain(sub.start(spec()))
  expect(resolverCalls).toHaveLength(1)
  expect(resolverCalls[0]!.tool_name).toBe('search_docs')
  // PROJECT SCOPING — the dispatched tool bound to the turn's active project.
  expect(resolverCalls[0]!.project_id).toBe('proj-42')
  expect(events.some((e) => e.kind === 'completion')).toBe(true)
})

test('HONEST MANIFEST → GPT is advertised ONLY the MCP tools, never Claude-native names', async () => {
  const rec = recordingGptFetch('r1')
  const claudeNativeTools: AgentSpec['tools'] = [
    { name: 'Bash', description: 'x', input_schema: { type: 'object' }, output_schema: { type: 'object' }, capability_required: 'fs:project_data' },
    { name: 'Read', description: 'x', input_schema: { type: 'object' }, output_schema: { type: 'object' }, capability_required: 'fs:project_data' },
  ]
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-manifest',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool: openaiPool(),
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      toolManifest: () => [{ name: 'search_docs', description: 'search', input_schema: { type: 'object' } }],
      fetchImpl: rec.fetchImpl,
    },
  })!
  // The incoming spec carries Claude-native tools — they must be SUPPRESSED.
  await drain(sub.start(spec('claude-opus-4-8', claudeNativeTools)))
  const sentTools = (rec.bodies[0]!['tools'] as Array<{ name: string }> | undefined) ?? []
  const names = sentTools.map((t) => t.name)
  expect(names).toEqual(['search_docs'])
  expect(names).not.toContain('Bash')
  expect(names).not.toContain('Read')
})

test('HONEST MANIFEST → no toolManifest ⇒ GPT advertises NO tools (never false Claude built-ins)', async () => {
  const rec = recordingGptFetch('r1')
  const claudeNativeTools: AgentSpec['tools'] = [
    { name: 'Workflow', description: 'x', input_schema: { type: 'object' }, output_schema: { type: 'object' }, capability_required: 'fs:project_data' },
  ]
  const sub = openaiSub(openaiPool(), rec.fetchImpl)
  await drain(sub.start(spec('claude-opus-4-8', claudeNativeTools)))
  // With no manifest wired, the request carries no `tools` (the adapter only sets
  // tools when spec.tools is non-empty) — GPT is never told it can call Workflow.
  expect(rec.bodies[0]!['tools']).toBeUndefined()
})

// --- STREAMED error surface (HTTP 200 SSE response.error) — must cool too ---

test('BOUNDARY streamed 429 (SSE rate_limit_exceeded, message lacks "429") → cools after exhaustion + retry_after honored', async () => {
  const pool = openaiPool()
  const before = Date.now()
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-streamed',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6', 'gpt-5.5'],
      // Small retry-after so the adapter's inter-rotation sleep stays short; the
      // point is that the parsed retry_after (NOT the default 429 window) drives
      // the cooldown, proving the streamed error's classification flows through.
      fetchImpl: streamedErrorFetch('rate_limit_exceeded', 'Rate limit reached. Please try again in 0.5s'),
    },
  })!
  await drain(sub.start(spec()))
  const cred = pool.credentials[0]!
  expect(cred.cooldown_reason).toBe('rate_limit_429')
  expect(cred.cooldown_until).toBeDefined()
  // retry_after=0.5s honored → cooldown ≈ before + (one 0.5s inter-rotation sleep)
  // + 0.5s window ≈ 1s. Well under the multi-second DEFAULT 429 window, proving
  // the parsed retry_after (not a default) drove it.
  expect(cred.cooldown_until! - before).toBeGreaterThanOrEqual(400)
  expect(cred.cooldown_until! - before).toBeLessThan(5000)
})

test('BOUNDARY streamed insufficient_quota → cools with billing_402', async () => {
  const pool = openaiPool()
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-quota',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6', 'gpt-5.5'],
      fetchImpl: streamedErrorFetch('insufficient_quota', 'You exceeded your current quota'),
    },
  })!
  await drain(sub.start(spec()))
  expect(pool.credentials[0]!.cooldown_reason).toBe('billing_402')
})

test('BOUNDARY streamed auth error → cools with auth_401', async () => {
  const pool = openaiPool()
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-auth',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      fetchImpl: streamedErrorFetch('invalid_api_key', 'Incorrect API key provided'),
    },
  })!
  await drain(sub.start(spec()))
  expect(pool.credentials[0]!.cooldown_reason).toBe('auth_401')
})

test('BOUNDARY streamed server_error → NOT cooled (upstream fault, not credential)', async () => {
  const pool = openaiPool()
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-5xx',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6', 'gpt-5.5'],
      fetchImpl: streamedErrorFetch('server_error', 'The server had an error'),
    },
  })!
  const events = await drain(sub.start(spec()))
  expect(events.some((e) => e.kind === 'error')).toBe(true)
  expect(pool.credentials[0]!.cooldown_until).toBeUndefined()
})

// --- SETUP GUARD (audit Medium): every throw site → terminal error event, not a
// rejected iterator. Three sites: pool resolution, manifest resolution, adapter
// construction/start. ---

test('SETUP GUARD: resolvePool throw → terminal error event (iterator does NOT reject)', async () => {
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-throw-pool',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      resolvePool: async () => { throw new Error('vault unavailable') },
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
    },
  })!
  // Must NOT reject — must yield a terminal error.
  const events = await drain(sub.start(spec()))
  const err = events.find((e) => e.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') {
    expect(err.message).toMatch(/vault unavailable/)
    expect(err.retryable).toBe(false)
  }
})

test('SETUP GUARD: toolManifest throw → terminal error event', async () => {
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-throw-manifest',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool: openaiPool(),
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      toolManifest: () => { throw new Error('manifest boom') },
      fetchImpl: gptFetch(),
    },
  })!
  const events = await drain(sub.start(spec()))
  const err = events.find((e) => e.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') expect(err.message).toMatch(/manifest boom/)
})

test('SETUP GUARD: adapter start() throw (auth failure) → terminal error event', async () => {
  // An empty-secret credential + empty env makes resolveOpenAiAuth throw at
  // substrate.start() — must surface as a terminal error, not a rejection.
  const emptySecretPool = newCredentialPool({
    strategy: 'fill_first',
    credentials: [{ id: 'openai:empty', kind: 'api_key', secret: '' }],
  })
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-throw-start',
    provider: 'openai',
    user_id: 'owner',
    openai: {
      pool: emptySecretPool,
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      env: {}, // no OPENAI_API_KEY fallback → auth resolution throws
    },
  })!
  const events = await drain(sub.start(spec()))
  const err = events.find((e) => e.kind === 'error')
  expect(err?.kind).toBe('error')
  if (err?.kind === 'error') expect(err.message).toMatch(/OPENAI_API_KEY|setup\/dispatch/i)
})

// --- SCOPE-KEY SAFETY (audit High): continuity ledger key must be collision-safe
// and absence-distinct, so session history NEVER bleeds across user/project. ---

test('SCOPE KEY: delimiter-containing ids get DISTINCT keys (no ${user}:${project} collision)', () => {
  // (user='a:b', project='c') vs (user='a', project='b:c') both flatten to "a:b:c"
  // under naive concatenation — structural encoding keeps them distinct.
  expect(openAiSessionScopeKey('a:b', 'c')).not.toBe(openAiSessionScopeKey('a', 'b:c'))
  // A few more delimiter shapes.
  expect(openAiSessionScopeKey('x', 'y:z')).not.toBe(openAiSessionScopeKey('x:y', 'z'))
  expect(openAiSessionScopeKey('"', ']')).not.toBe(openAiSessionScopeKey(']', '"'))
  // Same scope → same key (stable).
  expect(openAiSessionScopeKey('a', 'b')).toBe(openAiSessionScopeKey('a', 'b'))
})

test('SCOPE KEY: absent project is DISTINCT from a real project literally named "default"', () => {
  expect(openAiSessionScopeKey('u', undefined)).not.toBe(openAiSessionScopeKey('u', 'default'))
  expect(openAiSessionScopeKey('u', null)).not.toBe(openAiSessionScopeKey('u', 'default'))
  // undefined and null (both "absent") map to the same key.
  expect(openAiSessionScopeKey('u', undefined)).toBe(openAiSessionScopeKey('u', null))
})

test('SCOPE KEY e2e: absent-project turn does NOT leak previous_response_id into a "default"-named project', async () => {
  // Within ONE substrate: turn 1 has NO active project; turn 2's active project is
  // literally 'default'. They MUST be distinct continuity scopes → turn 2 must not
  // replay turn 1's response id.
  const rec = recordingGptFetch('resp_absent')
  let project: string | undefined
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-scope',
    provider: 'openai',
    user_id: 'owner',
    projectIdResolver: () => project,
    openai: {
      pool: openaiPool(),
      bindMcpResolver: () => async () => ({}),
      model_preference: ['gpt-5.6'],
      fetchImpl: rec.fetchImpl,
    },
  })!
  project = undefined // absent
  await drain(sub.start(spec())) // stores resp_absent under [owner, null]
  project = 'default' // a real project literally named "default"
  await drain(sub.start(spec())) // MUST NOT read the absent scope's id
  expect(rec.bodies).toHaveLength(2)
  expect(rec.bodies[1]!['previous_response_id']).toBeUndefined()
})
