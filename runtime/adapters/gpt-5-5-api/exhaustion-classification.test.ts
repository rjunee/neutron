/**
 * gpt-5-5-api: model-rotation exhaustion must PRESERVE the upstream classification
 * (audit BLOCKER 2). When every model in `model_preference` 429s, the terminal
 * error the adapter emits must still carry the `HTTP 429` prefix + `retry_after_ms`
 * so the composer's credential-pool wrapper can cool the (rate-limited) credential.
 * Without this the exhaustion collapsed into a classification-free
 * "model_preference exhausted" string and the credential was never cooled.
 */

import { describe, expect, test } from 'bun:test'

import { createGptResponsesApiSubstrate } from './index.ts'
import { getOpenAiModelPreference } from '../../models-openai.ts'
import type { Event } from '../../events.ts'

function http429Fetch(retryAfterSec: number): typeof fetch {
  return (async () =>
    new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': String(retryAfterSec) },
    })) as unknown as typeof fetch
}

/** HTTP 200 SSE that streams a `response.error` of the given type/message. */
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

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('gpt-5-5-api exhaustion classification', () => {
  test('two-model 429 exhaustion → terminal error keeps HTTP 429 prefix + retry_after_ms', async () => {
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-x',
      mcpResolver: async () => ({}),
      fetchImpl: http429Fetch(4),
    })
    const events = await collect(
      gpt.start({ prompt: 'hi', tools: [], model_preference: ['gpt-5.6', 'gpt-5.5'] }).events,
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') {
      // HTTP status prefix preserved FIRST so parseHttpStatusFromMessage matches.
      expect(err.message).toMatch(/^HTTP 429:/)
      // The rotation-exhausted context is appended, not replacing the classification.
      expect(err.message).toMatch(/rotation exhausted/i)
      expect(err.retry_after_ms).toBe(4000)
    }
  })

  test('STREAMED rate_limit_exceeded (SSE response.error, no "429" in text) → HTTP 429 prefix + retry_after from message', async () => {
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-streamed',
      mcpResolver: async () => ({}),
      fetchImpl: streamedErrorFetch('rate_limit_exceeded', 'Rate limit reached. Please try again in 0.5s'),
    })
    const events = await collect(
      gpt.start({ prompt: 'hi', tools: [], model_preference: ['gpt-5.6', 'gpt-5.5'] }).events,
    )
    const err = events.find((e) => e.kind === 'error')
    if (err?.kind === 'error') {
      // The durable classification came from error.type, NOT the message text.
      expect(err.message).toMatch(/^HTTP 429:/)
      expect(err.retry_after_ms).toBe(500)
    } else {
      throw new Error('expected a terminal error event')
    }
  })

  test('STREAMED insufficient_quota → HTTP 402 prefix (non-retryable, surfaced directly)', async () => {
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-quota',
      mcpResolver: async () => ({}),
      fetchImpl: streamedErrorFetch('insufficient_quota', 'You exceeded your current quota'),
    })
    const events = await collect(
      gpt.start({ prompt: 'hi', tools: [], model_preference: ['gpt-5.6'] }).events,
    )
    const err = events.find((e) => e.kind === 'error')
    if (err?.kind === 'error') {
      expect(err.message).toMatch(/^HTTP 402:/)
    } else {
      throw new Error('expected a terminal error event')
    }
  })

  test('single-model 429 exhaustion also preserves the classification', async () => {
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-x',
      mcpResolver: async () => ({}),
      fetchImpl: http429Fetch(2),
    })
    const events = await collect(
      gpt.start({ prompt: 'hi', tools: [], model_preference: ['gpt-5.6'] }).events,
    )
    const err = events.find((e) => e.kind === 'error')
    if (err?.kind === 'error') {
      expect(err.message).toMatch(/^HTTP 429:/)
      expect(err.retry_after_ms).toBe(2000)
    } else {
      throw new Error('expected a terminal error event')
    }
  })
})

describe('gpt-5-5-api model-not-found + operator override', () => {
  test('404 on the primary model → LOUD actionable terminal error naming the model + override env (not a silent exit)', async () => {
    const notFoundFetch = (async () =>
      new Response('{"error":{"message":"The model does not exist"}}', {
        status: 404,
      })) as unknown as typeof fetch
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-404',
      mcpResolver: async () => ({}),
      fetchImpl: notFoundFetch,
    })
    const events = await collect(gpt.start({ prompt: 'hi', tools: [], model_preference: ['gpt-5.6'] }).events)
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') {
      // Names the rejected model AND the override env — actionable, not silent.
      expect(err.message).toMatch(/gpt-5\.6/)
      expect(err.message).toMatch(/NEUTRON_OPENAI_MODEL/)
      expect(err.retryable).toBe(false)
    } else {
      throw new Error('expected a terminal error event')
    }
  })

  test('the env override id is what gets SENT as the request model', async () => {
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
    // The composer resolves model_preference via getOpenAiModelPreference(env); an
    // operator override flows straight to the wire.
    const pref = getOpenAiModelPreference({ NEUTRON_OPENAI_MODEL: 'gpt-5.6-ga' } as unknown as NodeJS.ProcessEnv)
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-override',
      mcpResolver: async () => ({}),
      fetchImpl: recordingFetch,
    })
    await collect(gpt.start({ prompt: 'hi', tools: [], model_preference: pref }).events)
    expect(sentModel).toBe('gpt-5.6-ga')
  })
})

describe('gpt-5-5-api expired-session replay', () => {
  test('previous_response_id rejected as expired → adapter REPLAYS full history WITHOUT it and SUCCEEDS (no lost history)', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let call = 0
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      call++
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (call === 1) {
        // The upstream rejects our previous_response_id as expired/not-found.
        return new Response(
          '{"error":{"message":"Previous response with id resp_old not found"}}',
          { status: 404 },
        )
      }
      // The replay (no previous_response_id) succeeds.
      const sse =
        [
          { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_new' } } },
          { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'ok' } },
          { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_new', usage: { input_tokens: 1, output_tokens: 1 } } } },
        ]
          .map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`)
          .join('\n') + '\n'
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch

    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-expired',
      mcpResolver: async () => ({}),
      fetchImpl,
    })
    const events = await collect(
      gpt.start({
        prompt: 'and now',
        tools: [],
        model_preference: ['gpt-5.6'],
        session: { id: 'resp_old', last_active_at: Date.now() },
        messages: [
          { role: 'user', content: 'earlier-u1' },
          { role: 'assistant', content: 'earlier-a1' },
        ],
      }).events,
    )
    // Call 1 tried to resume the expired id; call 2 replayed WITHOUT it + WITH history.
    expect(bodies).toHaveLength(2)
    expect(bodies[0]!['previous_response_id']).toBe('resp_old')
    expect(bodies[1]!['previous_response_id']).toBeUndefined()
    const replayInput = bodies[1]!['input'] as Array<{ role: string; content: string }>
    expect(replayInput.map((m) => m.content)).toContain('earlier-u1') // full history replayed
    // The turn SUCCEEDS — no lost history, no failed turn.
    const comp = events.find((e) => e.kind === 'completion')
    expect(comp?.kind).toBe('completion')
    if (comp?.kind === 'completion') expect(comp.session?.id).toBe('resp_new') // fresh id to store
  })

  test('a NON-resume turn does NOT trigger expiry replay on a plain 404 (model-not-found path preserved)', async () => {
    const notFoundFetch = (async () =>
      new Response('{"error":{"message":"The model does not exist"}}', { status: 404 })) as unknown as typeof fetch
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-404-model',
      mcpResolver: async () => ({}),
      fetchImpl: notFoundFetch,
    })
    const events = await collect(gpt.start({ prompt: 'hi', tools: [], model_preference: ['gpt-5.6'] }).events)
    const err = events.find((e) => e.kind === 'error')
    // No previous_response_id was sent → this is model-not-found, not expiry.
    if (err?.kind === 'error') expect(err.message).toMatch(/does not recognize model/)
    else throw new Error('expected a terminal error event')
  })
})
