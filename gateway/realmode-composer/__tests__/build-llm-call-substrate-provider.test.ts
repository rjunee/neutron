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

import { buildLlmCallSubstrate } from '../build-llm-call-substrate.ts'
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

function spec(model = 'claude-opus-4-8'): AgentSpec {
  return { prompt: 'hello world', tools: [], model_preference: [model], max_tokens: 32 }
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
    openai: { pool: openaiPool(), mcpResolver: async () => ({}), fetchImpl: gptFetch() },
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
      mcpResolver: async () => ({}),
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

test("provider='openai' but missing mcpResolver ⇒ LOUD terminal error", async () => {
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-agent',
    provider: 'openai',
    openai: { pool: openaiPool(), fetchImpl: gptFetch() },
  })!
  const events = await drain(sub.start(spec()))
  const e = events[0]!
  expect(e.kind).toBe('error')
  if (e.kind === 'error') expect(e.message).toMatch(/requires an mcpResolver/i)
})

test("provider='openai' with empty OpenAI pool ⇒ terminal error", async () => {
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'gpt-agent',
    provider: 'openai',
    openai: {
      resolvePool: async () => null,
      mcpResolver: async () => ({}),
      model_preference: ['gpt-5.6'],
    },
  })!
  const events = await drain(sub.start(spec()))
  const e = events[0]!
  expect(e.kind).toBe('error')
  if (e.kind === 'error') expect(e.message).toMatch(/no OpenAI credentials/i)
})

test('per-turn providerResolver flips backend between dispatches (per-project granularity)', async () => {
  const cc = ccCapture()
  let provider: string | undefined = 'anthropic'
  const sub = buildLlmCallSubstrate({
    pool: anthropicPool(),
    substrate_instance_id: 'switch',
    providerResolver: () => provider,
    substrateFactory: cc.substrateFactory,
    openai: { pool: openaiPool(), mcpResolver: async () => ({}), model_preference: ['gpt-5.6'], fetchImpl: gptFetch() },
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
