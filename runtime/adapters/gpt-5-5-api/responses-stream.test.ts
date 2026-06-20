import { describe, expect, test } from 'bun:test'

import type { Event } from '../../events.ts'
import { startResponsesStream } from './responses-stream.ts'

function ssePayload(frames: ReadonlyArray<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n`).join('\n') + '\n'
}

function mockFetch(body: string, opts?: { status?: number }): typeof fetch {
  return (async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    })
    return new Response(stream, { status: opts?.status ?? 200 })
  }) as unknown as typeof fetch
}

async function collect(gen: AsyncGenerator<Event, void, void>): Promise<Event[]> {
  const out: Event[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('gpt-5-5-api responses-stream', () => {
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
