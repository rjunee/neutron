/**
 * A FAILED FIRE MUST SAY WHAT FAILED.
 *
 * `buildSubstrateWorkflowFire` returned a fixed eleven-word sentence on any
 * `error` event and discarded `ev.message` and `ev.code` — which the producer
 * stamps precisely so a consumer does not have to regex prose.
 *
 * Measured on the instance 2026-09-14: four runs failed carrying that identical
 * string. The first spent 94 seconds between `fire-dispatched` and `failed`; the
 * fourth spent SEVENTEEN MILLISECONDS. Two plainly different faults wearing one
 * label, and the run row could not tell them apart — the only way to separate
 * them was to open the gateway journal at the matching timestamp.
 */
import { describe, expect, it } from 'bun:test'
import { buildSubstrateWorkflowFire } from '../inner-loop.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'

/** A substrate whose turn emits exactly the given events, then ends. */
function substrateEmitting(events: Event[]): Substrate {
  return {
    start: () => ({
      events: (async function* () {
        for (const ev of events) yield ev
      })(),
      cancel: async () => {},
    }),
  } as unknown as Substrate
}

const fireOnce = async (events: Event[]): Promise<{ status: string; error: string | null }> => {
  const fire = buildSubstrateWorkflowFire({ substrate: substrateEmitting(events) })
  const out = await fire({ prompt: 'p', cwd: '/repo', settle_timeout_ms: 0 })
  return { status: out.status, error: out.error }
}

describe('a failed fire carries the producer’s reason', () => {
  it('appends the substrate’s message and typed code', async () => {
    const out = await fireOnce([
      { kind: 'error', message: 'persistent-repl: turn timeout', retryable: false, code: 'repl_unreconciled' },
    ])
    expect(out.status).toBe('failed')
    // The PREFIX is unchanged — the orchestrator compares exact strings elsewhere,
    // so the detail is appended, never substituted.
    expect(out.error).toStartWith('fire turn raised an error before settling')
    expect(out.error).toContain('persistent-repl: turn timeout')
    expect(out.error).toContain('repl_unreconciled')
  })

  it('carries the message alone when the producer stamped no code', async () => {
    const out = await fireOnce([{ kind: 'error', message: 'no_credentials', retryable: false }])
    expect(out.error).toContain('no_credentials')
  })

  it('two DIFFERENT substrate faults are two different strings — the whole point', async () => {
    // On the instance these were indistinguishable, which is what cost an hour of
    // journal archaeology. A test that only checks one message would not notice.
    const a = await fireOnce([{ kind: 'error', message: 'turn timeout', retryable: false }])
    const b = await fireOnce([{ kind: 'error', message: 'spawn refused', retryable: false }])
    expect(a.error).not.toBe(b.error)
  })

  it('falls back to the bare sentence when the producer supplied nothing', async () => {
    // The non-vacuity control in the other direction: an empty message must not
    // produce a dangling separator, and must still be the string callers expect.
    const out = await fireOnce([{ kind: 'error', message: '', retryable: false }])
    expect(out.error).toBe('fire turn raised an error before settling')
  })

  it('a turn that COMPLETES is untouched by any of this', async () => {
    const out = await fireOnce([
      {
        kind: 'completion',
        usage: { input_tokens: 0, output_tokens: 0 },
        substrate_instance_id: 's',
      },
    ])
    expect(out.status).toBe('fired')
    expect(out.error).toBeNull()
  })
})
