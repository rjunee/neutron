import { describe, expect, test } from 'bun:test'

import type { Event } from '../../events.ts'
import { shimToInternal } from './mcp-shim.ts'

async function* fromArray(events: Event[]): AsyncGenerator<Event, void, void> {
  for (const e of events) yield e
}

async function collect(gen: AsyncGenerator<Event, void, void>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('mcp-shim', () => {
  test('passes through a clean stream with no tool calls', async () => {
    const upstream: Event[] = [
      { kind: 'token', text: 'hi' },
      {
        kind: 'completion',
        usage: { input_tokens: 1, output_tokens: 1 },
        substrate_instance_id: 'gpt-1',
        session: { id: 'r1', last_active_at: 0 },
      },
    ]
    const out = await collect(
      shimToInternal(fromArray(upstream), {
        resolver: async () => 'should not be called',
        continueStream: () => fromArray([]),
      }),
    )
    expect(out.length).toBe(2)
    expect(out[1]?.kind).toBe('completion')
  })

  test('resolves a tool call by calling resolver and continuing the stream', async () => {
    const upstream: Event[] = [
      { kind: 'tool_call', tool_name: 'search', args: { q: 'hi' }, call_id: 'fc-1' },
      {
        kind: 'completion',
        usage: { input_tokens: 1, output_tokens: 0 },
        substrate_instance_id: 'gpt-1',
        session: { id: 'r1', last_active_at: 0 },
      },
    ]
    const continuation: Event[] = [
      { kind: 'token', text: 'answered' },
      {
        kind: 'completion',
        usage: { input_tokens: 2, output_tokens: 5 },
        substrate_instance_id: 'gpt-1',
        session: { id: 'r2', last_active_at: 0 },
      },
    ]
    let continuationCalled = 0
    const resolverCalls: Array<{ call_id: string }> = []
    const out = await collect(
      shimToInternal(fromArray(upstream), {
        resolver: async (c) => {
          resolverCalls.push({ call_id: c.call_id })
          return { ok: true }
        },
        continueStream: ({ previous_response_id, outputs }) => {
          continuationCalled++
          expect(previous_response_id).toBe('r1')
          expect(outputs[0]?.call_id).toBe('fc-1')
          return fromArray(continuation)
        },
      }),
    )
    expect(continuationCalled).toBe(1)
    expect(resolverCalls).toEqual([{ call_id: 'fc-1' }])
    // Caller sees the tool_call (informational) + the continuation tokens + the final completion.
    const kinds = out.map((e) => e.kind)
    expect(kinds).toEqual(['tool_call', 'token', 'completion'])
  })

  test('resolver throw → error event terminates the stream', async () => {
    const upstream: Event[] = [
      { kind: 'tool_call', tool_name: 'search', args: {}, call_id: 'fc-1' },
      {
        kind: 'completion',
        usage: { input_tokens: 0, output_tokens: 0 },
        substrate_instance_id: 'gpt-1',
        session: { id: 'r1', last_active_at: 0 },
      },
    ]
    const out = await collect(
      shimToInternal(fromArray(upstream), {
        resolver: async () => {
          throw new Error('mcp down')
        },
        continueStream: () => fromArray([]),
      }),
    )
    const err = out.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.message).toMatch(/mcp_shim_tool_resolution_failed.*mcp down/)
  })

  test('exceeding max_rounds yields an error', async () => {
    const upstream: Event[] = [
      { kind: 'tool_call', tool_name: 'echo', args: {}, call_id: 'a' },
      {
        kind: 'completion',
        usage: { input_tokens: 0, output_tokens: 0 },
        substrate_instance_id: 'gpt-1',
        session: { id: 'r1', last_active_at: 0 },
      },
    ]
    const continuation = (i: number): Event[] => [
      { kind: 'tool_call', tool_name: 'echo', args: {}, call_id: `c-${i}` },
      {
        kind: 'completion',
        usage: { input_tokens: 0, output_tokens: 0 },
        substrate_instance_id: 'gpt-1',
        session: { id: `r-${i}`, last_active_at: 0 },
      },
    ]
    let i = 0
    const out = await collect(
      shimToInternal(fromArray(upstream), {
        resolver: async () => 'ok',
        continueStream: () => fromArray(continuation(++i)),
        max_rounds: 2,
      }),
    )
    const err = out.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.message).toMatch(/loop exceeded max_rounds=2/)
  })

  test('upstream completion lacking session.id yields an error', async () => {
    const upstream: Event[] = [
      { kind: 'tool_call', tool_name: 'x', args: {}, call_id: 'fc-1' },
      {
        kind: 'completion',
        usage: { input_tokens: 0, output_tokens: 0 },
        substrate_instance_id: 'gpt-1',
        // no session field
      },
    ]
    const out = await collect(
      shimToInternal(fromArray(upstream), {
        resolver: async () => 'ok',
        continueStream: () => fromArray([]),
      }),
    )
    const err = out.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.message).toMatch(/upstream completion lacked response.id/)
  })
})
