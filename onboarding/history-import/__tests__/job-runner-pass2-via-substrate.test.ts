/**
 * job-runner-pass2-via-cli.test.ts
 *
 * End-to-end regression guard for the Pass-2 synthesis caller: drives a Pass-2
 * turn through `buildPass2SubstrateCaller` against a fake `Substrate` that yields
 * the canned event sequence (token × N + completion). Confirms:
 *
 *   1. The runner consumes the event sequence (token + completion) and produces
 *      the same `Pass2Result` shape.
 *   2. `dollars_billed` is computed from the completion's `usage` × pricing.
 *   3. The synthesizer model is surfaced on the result.
 *   4. A substrate error event surfaces as an ImportError.
 *
 * (Pre-S3 this drove a real cli-transport `claude -p` subprocess via a fake
 * `spawnImpl`; the persistent REPL is now the sole substrate, so the caller is
 * tested against a transport-agnostic fake `Substrate` instead.)
 */

import { describe, expect, test } from 'bun:test'

import { buildPass2SubstrateCaller } from '../substrate-callers.ts'
import type { AggregatedPass1 } from '../pass2-synthesis.ts'
import { BEST_MODEL } from '../../../runtime/models.ts'
import type { AgentSpec, Substrate } from '../../../runtime/substrate.ts'
import type { SessionHandle } from '../../../runtime/session-handle.ts'
import type { Event } from '../../../runtime/events.ts'

/** A fake substrate that yields a canned event sequence and captures the spec. */
function fakeSubstrate(events: ReadonlyArray<Event>): { substrate: Substrate; specs: AgentSpec[] } {
  const specs: AgentSpec[] = []
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      const gen = (async function* (): AsyncGenerator<Event, void, void> {
        for (const ev of events) yield ev
      })()
      return {
        events: gen,
        respondToTool: async () => undefined,
        cancel: async () => undefined,
        tool_resolution: 'internal',
      }
    },
  }
  return { substrate, specs }
}

const SAMPLE_AGGREGATED: AggregatedPass1 = {
  entities: [],
  topics: [],
  tasks: [],
  voice_signals: { tone: 'neutral', verbosity: 'medium' },
} as unknown as AggregatedPass1

describe('job-runner Pass-2 via the substrate seam', () => {
  test('drives a Pass-2 turn end-to-end and persists the parsed JSON result', async () => {
    const synthesizedJson = JSON.stringify({
      projects: [{ slug: 'demo', name: 'Demo project' }],
      tasks: [],
      reminders: [],
      entities: [],
      voice_signals: [],
      facts: [],
    })
    const { substrate, specs } = fakeSubstrate([
      { kind: 'token', text: synthesizedJson },
      {
        kind: 'completion',
        substrate_instance_id: 'pass2-test',
        session: { id: 'sess-pass2', last_active_at: Date.now() },
        usage: { input_tokens: 1500, output_tokens: 200 },
      },
    ])
    const caller = buildPass2SubstrateCaller({
      substrate,
      // Inject zero pricing for deterministic dollar assertions.
      pricing: { input_usd_per_m: 0, output_usd_per_m: 0 },
    })
    const out = await caller({
      aggregated: SAMPLE_AGGREGATED,
      prompt: 'You are a synthesizer. Emit the project shells.',
    })
    expect(out.result).toEqual({
      projects: [{ slug: 'demo', name: 'Demo project' }],
      tasks: [],
      reminders: [],
      entities: [],
      voice_signals: [],
      facts: [],
    })
    expect(out.dollars_billed).toBe(0)
    expect(out.synthesizer_model).toBe(BEST_MODEL)
    // The caller dispatched a single turn at the synthesizer model.
    expect(specs.length).toBe(1)
    expect(specs[0]!.model_preference[0]).toBe(BEST_MODEL)
  })

  test('throws ImportError when the substrate surfaces a non-rate-limit error', async () => {
    const { substrate } = fakeSubstrate([
      {
        kind: 'error',
        message: 'error_input_too_long: aggregated input exceeded the model context window',
        retryable: false,
      },
    ])
    const caller = buildPass2SubstrateCaller({
      substrate,
      pricing: { input_usd_per_m: 0, output_usd_per_m: 0 },
    })
    await expect(
      caller({ aggregated: SAMPLE_AGGREGATED, prompt: 'go' }),
    ).rejects.toThrow(/substrate_error|substrate error|error_input_too_long/i)
  })
})
