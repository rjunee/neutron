/**
 * The ACTIVITY-INSPECTOR TEE at the ONE drain (`DrainOptions.onEvent`).
 *
 * Before this seam existed, `drainToOutcome` was the end of the line for a chat
 * turn's event stream: `token` text was accumulated, `completion`/`error` were
 * terminal, and `status` / `thinking` / `tool_call` / `tool_result_ack` fell off the
 * bottom of the if-chain and were DISCARDED. Nothing in the process ever saw them,
 * so no client could answer "is this session alive?". These tests pin that the tee
 * now sees every event in arrival order — and, just as importantly, that it cannot
 * perturb the drain.
 *
 * Every case here FAILS without the `onEvent` change (the option would be ignored,
 * so `seen` stays empty).
 */

import { describe, expect, it } from 'bun:test'

import type { Event } from '../events.ts'
import type { SessionHandle } from '../session-handle.ts'
import { drainToOutcome } from '../substrate-text.ts'

/** A handle whose stream yields exactly `events`, then ends. */
function handleOf(events: Event[]): SessionHandle {
  return {
    events: (async function* () {
      for (const e of events) yield e
    })(),
    respondToTool: async () => {},
    cancel: async () => {},
    tool_resolution: 'internal',
  }
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 } as unknown as Extract<
  Event,
  { kind: 'completion' }
>['usage']

describe('drainToOutcome — onEvent tee', () => {
  it('tees the events the drain DISCARDS (status/thinking/tool_call/tool_result_ack)', async () => {
    const seen: Event[] = []
    const events: Event[] = [
      { kind: 'status', message: 'working' },
      { kind: 'thinking', text: 'hmm' },
      { kind: 'tool_call', tool_name: 'Read', args: {}, call_id: 'c1' },
      { kind: 'tool_result_ack', call_id: 'c1' },
      { kind: 'token', text: 'hi' },
      { kind: 'completion', usage: ZERO_USAGE, substrate_instance_id: 'i1' },
    ]
    const out = await drainToOutcome(handleOf(events), { onEvent: (e) => seen.push(e) })

    // The four informational kinds are exactly the ones that used to vanish.
    expect(seen.map((e) => e.kind)).toEqual([
      'status',
      'thinking',
      'tool_call',
      'tool_result_ack',
      'token',
      'completion',
    ])
    // ...and the drain's own outcome is untouched by teeing.
    expect(out.status).toBe('completed')
    expect(out.text).toBe('hi')
  })

  it('carries the `keepalive` marker through to the tee', async () => {
    // The two-clocks design depends on this flag surviving the drain: a keepalive
    // and a real notice are byte-identical apart from it.
    const seen: Event[] = []
    await drainToOutcome(
      handleOf([
        { kind: 'status', message: 'working', keepalive: true },
        { kind: 'status', message: 'recovered' },
        { kind: 'completion', usage: ZERO_USAGE, substrate_instance_id: 'i1' },
      ]),
      { onEvent: (e) => seen.push(e) },
    )
    const statuses = seen.filter((e): e is Extract<Event, { kind: 'status' }> => e.kind === 'status')
    expect(statuses[0]?.keepalive).toBe(true)
    expect(statuses[1]?.keepalive).toBeUndefined()
  })

  it('tees a terminal ERROR before the drain returns it', async () => {
    const seen: Event[] = []
    const out = await drainToOutcome(
      handleOf([
        { kind: 'status', message: 'working' },
        { kind: 'error', message: 'boom', retryable: false },
      ]),
      { onEvent: (e) => seen.push(e), errorPrefix: 'x: ' },
    )
    expect(seen.map((e) => e.kind)).toEqual(['status', 'error'])
    expect(out.status).toBe('error')
  })

  it('a THROWING tee cannot break token collection or the outcome', async () => {
    // Observe-only contract. A broken inspector must never cost the user a turn.
    const out = await drainToOutcome(
      handleOf([
        { kind: 'status', message: 'working' },
        { kind: 'token', text: 'alpha' },
        { kind: 'completion', usage: ZERO_USAGE, substrate_instance_id: 'i1' },
      ]),
      {
        onEvent: () => {
          throw new Error('inspector exploded')
        },
      },
    )
    expect(out.status).toBe('completed')
    expect(out.text).toBe('alpha')
  })

  it('is entirely absent when no tee is passed (unchanged behaviour)', async () => {
    const out = await drainToOutcome(
      handleOf([
        { kind: 'status', message: 'working' },
        { kind: 'token', text: 'z' },
        { kind: 'completion', usage: ZERO_USAGE, substrate_instance_id: 'i1' },
      ]),
    )
    expect(out.status).toBe('completed')
    expect(out.text).toBe('z')
  })
})
