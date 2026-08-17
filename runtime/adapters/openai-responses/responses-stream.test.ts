import { describe, expect, test } from 'bun:test'

import type { Event } from '../../events.ts'
import { startResponsesStream } from './responses-stream.ts'

function ssePayload(frames: ReadonlyArray<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`).join('\n') + '\n'
}

function mockFetch(body: string, opts?: { status?: number; headers?: Record<string, string> }): typeof fetch {
  return (async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    return new Response(stream, {
      status: opts?.status ?? 200,
      ...(opts?.headers !== undefined ? { headers: opts.headers } : {}),
    })
  }) as unknown as typeof fetch
}

async function collect(gen: AsyncGenerator<Event, void, void>): Promise<Event[]> {
  const out: Event[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('openai-responses responses-stream', () => {
  test('output_text deltas → token, response.completed → completion with response.id as session.id', async () => {
    const body = ssePayload([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1' } } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'hello' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: ' world' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 5, output_tokens: 8 } } } },
    ])
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: { authorization: 'Bearer sk-test' },
        body: { model: 'gpt-5-5' },
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-instance-1',
        fetchImpl: mockFetch(body),
      }),
    )
    const tokens = events.filter((e) => e.kind === 'token').map((e) => (e as { text: string }).text)
    expect(tokens.join('')).toBe('hello world')
    const completion = events.find((e) => e.kind === 'completion')
    expect(completion?.kind).toBe('completion')
    if (completion?.kind === 'completion') {
      expect(completion.session?.id).toBe('resp_1')
      expect(completion.usage.input_tokens).toBe(5)
      expect(completion.substrate_instance_id).toBe('gpt-instance-1')
    }
  })

  test('function call deltas + completed → tool_call event', async () => {
    const body = ssePayload([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r2' } } },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', call_id: 'fc-1', name: 'search', delta: '{"q":' },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: { type: 'response.function_call_arguments.delta', call_id: 'fc-1', delta: '"hi"}' },
      },
      {
        event: 'response.function_call_arguments.done',
        data: { type: 'response.function_call_arguments.done', call_id: 'fc-1' },
      },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r2' } } },
    ])
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch(body),
      }),
    )
    const tc = events.find((e) => e.kind === 'tool_call')
    expect(tc?.kind).toBe('tool_call')
    if (tc?.kind === 'tool_call') {
      expect(tc.tool_name).toBe('search')
      expect(tc.call_id).toBe('fc-1')
      expect(tc.args).toEqual({ q: 'hi' })
    }
  })

  test('5xx response yields an error event with retryable=true', async () => {
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch('upstream', { status: 503 }),
      }),
    )
    expect(events.length).toBe(1)
    const e = events[0]!
    expect(e.kind).toBe('error')
    if (e.kind === 'error') expect(e.retryable).toBe(true)
  })

  test('in-stream error does NOT yield a synthetic completion (Codex r1 P1 fix)', async () => {
    const body = ssePayload([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      { event: 'response.error', data: { type: 'response.error', error: { type: 'rate_limit_exceeded', message: 'limit' } } },
    ])
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch(body),
      }),
    )
    const errors = events.filter((e) => e.kind === 'error')
    const completions = events.filter((e) => e.kind === 'completion')
    expect(errors.length).toBe(1)
    expect(completions.length).toBe(0)
    // O3 — a STREAMED 429 must carry the same typed class the non-OK HTTP path
    // stamps, so `collectTokensToString` surfaces `rate_limited`, not `unknown`.
    expect(errors[0]!.kind === 'error' && errors[0]!.code).toBe('rate_limited')
  })

  test('O3 — a STREAMED non-429 error stamps code=http_status (parity with the non-OK HTTP path)', async () => {
    const body = ssePayload([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      { event: 'response.error', data: { type: 'response.error', error: { type: 'insufficient_quota', message: 'boom' } } },
    ])
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch(body),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.code).toBe('http_status')
    // The `HTTP <status>:` prefix still carries the numeric status for the cooldown map.
    expect(err!.kind === 'error' && err!.message.startsWith('HTTP 402:')).toBe(true)
  })

  test('O3 — a STREAMED 429 with a retry hint stamps code=rate_limited AND carries retry_after_ms', async () => {
    const body = ssePayload([
      { event: 'response.created', data: { type: 'response.created', response: { id: 'r1' } } },
      {
        event: 'response.error',
        data: { type: 'response.error', error: { type: 'rate_limit_exceeded', message: 'Please try again in 2s' } },
      },
    ])
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch(body),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.code).toBe('rate_limited')
    expect(err!.kind === 'error' && err!.retry_after_ms).toBe(2000)
  })

  // WHERE `Infinity` USED TO COME FROM. The header parser checked
  // `Number.isFinite` on the SECONDS and then multiplied by 1000, so
  // `retry-after: 1e308` produced `Infinity` — and the credential pool stored
  // that as a cooldown nothing could shorten (`>=` rejects every finite
  // replacement) and nothing could clear (a parked credential is never selected,
  // so no success is ever reported). One upstream header, one box dark until
  // restart. The pool now clamps too (`MAX_PARK_MS`); this pins the source.
  test('an OVERFLOWING retry-after header yields NO retry hint rather than Infinity', async () => {
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch('slow down', { status: 429, headers: { 'retry-after': '1e308' } }),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.code).toBe('rate_limited')
    // Absent, so the pool falls back to its own 429 window. Before the fix this
    // read `Infinity` and every reader of `cooldown_until` believed it.
    expect(err!.kind === 'error' && err!.retry_after_ms).toBeUndefined()
  })

  test('CONTROL — an ordinary retry-after header is still honoured to the millisecond', async () => {
    // The mutation-control for the test above: if the finiteness check had been
    // written to reject the whole numeric branch, this is what would have gone
    // red, and provider back-pressure would be silently ignored.
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch('slow down', { status: 429, headers: { 'retry-after': '90' } }),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.retry_after_ms).toBe(90_000)
  })

  // FLOORING A NEGATIVE AT ZERO WAS THE BUG, NOT THE FIX, and this test used to
  // assert the bug (`toBe(0)`). A defined `0` is not a short park, it is an ABSENT
  // one that the pool could not tell apart from a real hint: `reportFailure`
  // accepted it (`>= 0`), parked until `now`, and every reader of `cooldown_until`
  // counts `<= now` as AVAILABLE — so a 429 whose header said `-30` bought no
  // cooldown at all and we retried immediately into the rate limit. Same for any
  // past HTTP-date, which plain clock skew produces. `undefined` routes the pool to
  // its own 429 window instead, which is the only honest reading of a header that
  // told us nothing usable.
  test('a NEGATIVE retry-after header yields NO hint, not a zero the pool cannot distinguish', async () => {
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch('slow down', { status: 429, headers: { 'retry-after': '-30' } }),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.retry_after_ms).toBeUndefined()
  })

  test('an HTTP-DATE already in the past yields no hint either — clock skew is not a park', async () => {
    const past = new Date(Date.now() - 30_000).toUTCString()
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch('slow down', { status: 429, headers: { 'retry-after': past } }),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.retry_after_ms).toBeUndefined()
  })

  test('CONTROL — an HTTP-DATE in the FUTURE is still honoured as a real delta', async () => {
    // Without this, rejecting the whole date branch would pass every assertion
    // above while discarding a legitimate provider window.
    const future = new Date(Date.now() + 120_000).toUTCString()
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch('slow down', { status: 429, headers: { 'retry-after': future } }),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    const hint = err!.kind === 'error' ? err!.retry_after_ms : undefined
    expect(hint).toBeGreaterThan(100_000)
    expect(hint).toBeLessThanOrEqual(120_000)
  })

  // THE MESSAGE PARSER HAD THE IDENTICAL POST-MULTIPLY OVERFLOW the header parser
  // above was fixed for, and it survived that fix because the two carried separate
  // copies of the check. A streamed 429 carries no header, so this is the only path
  // that reads the hint out of the prose — and its `Infinity` goes somewhere worse
  // than the pool: `openaiResponsesSubstrate` sleeps `retry_after_ms` before
  // rotating, and `setTimeout(Infinity)` resolves in about 14 ms, so the back-off
  // is SKIPPED entirely and we retry at once against the provider that just
  // limited us. Both parsers now share one boundary (`positiveMs`).
  test('an OVERFLOWING retry hint in a STREAMED error message yields no hint either', async () => {
    const huge = `Rate limit reached. Please try again in 2${'0'.repeat(305)}s`
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch(
          ssePayload([
            { event: 'error', data: { error: { type: 'rate_limit_exceeded', message: huge } } },
          ]),
        ),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.code).toBe('rate_limited')
    expect(err!.kind === 'error' && err!.retry_after_ms).toBeUndefined()
  })

  test('CONTROL — an ordinary streamed retry hint is still parsed to the millisecond', async () => {
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch(
          ssePayload([
            {
              event: 'error',
              data: {
                error: { type: 'rate_limit_exceeded', message: 'Please try again in 1.2s' },
              },
            },
          ]),
        ),
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err!.kind === 'error' && err!.retry_after_ms).toBe(1200)
  })

  test('reasoning deltas → thinking', async () => {
    const body = ssePayload([
      { event: 'response.reasoning_summary.delta', data: { type: 'response.reasoning_summary.delta', delta: 'thinking…' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: 'r3' } } },
    ])
    const events = await collect(
      startResponsesStream({
        endpoint: 'http://test/responses',
        authHeaders: {},
        body: {},
        signal: new AbortController().signal,
        substrate_instance_id: 'gpt-1',
        fetchImpl: mockFetch(body),
      }),
    )
    const t = events.find((e) => e.kind === 'thinking')
    expect(t?.kind).toBe('thinking')
    if (t?.kind === 'thinking') expect(t.text).toBe('thinking…')
  })
})
