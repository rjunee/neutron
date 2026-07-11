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
