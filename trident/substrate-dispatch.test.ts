/**
 * Tests for the `Substrate` → `TridentDispatch` adapter
 * (`buildSubstrateTridentDispatch`).
 *
 * As of Trident v2 this adapter no longer drives the trident INNER loop (that is
 * the CC Dynamic Workflow launched via `trident/inner-loop.ts`). It is RETAINED
 * because the agent-dispatch family (`agent-dispatch/service.ts`,
 * `agent-dispatch/substrate-turn.ts`) still uses it to run one named-specialist
 * turn to terminal text. These tests pin its adapter mechanics against a mocked
 * `Substrate` — token coalescing, status mapping (completion / error / timeout /
 * start-throw), the FALSE-COMPLETION discipline, per-call cwd, and that the
 * AgentSpec it builds is tool-less and carries the rendered prompt.
 */

import { describe, expect, test } from 'bun:test'
import type { AgentSpec, Substrate } from '../runtime/substrate.ts'
import type { SessionHandle } from '../runtime/session-handle.ts'
import type { Event } from '../runtime/events.ts'
import { buildSubstrateTridentDispatch } from './substrate-dispatch.ts'
import { type TridentDispatchInput } from './session.ts'

const completion = (id = 'mock'): Event => ({
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 },
  substrate_instance_id: id,
})

/** A mocked Substrate whose `start` replays a per-spec scripted event list and
 *  records the specs it was handed + whether `cancel()` was called. */
function recordingSubstrate(
  script: (spec: AgentSpec) => Event[],
  opts: { hang?: boolean; throwOnStart?: boolean } = {},
): { substrate: Substrate; specs: AgentSpec[]; cancelled: () => boolean } {
  const specs: AgentSpec[] = []
  let cancelled = false
  const substrate: Substrate = {
    start(spec: AgentSpec): SessionHandle {
      specs.push(spec)
      if (opts.throwOnStart === true) throw new Error('substrate cold-start failed')
      const events = script(spec)
      let cancelSignal: (() => void) | null = null
      const cancelled_p = new Promise<void>((resolve) => {
        cancelSignal = resolve
      })
      async function* gen(): AsyncGenerator<Event> {
        for (const ev of events) yield ev
        if (opts.hang === true) {
          // Never completes on its own — block until cancel() fires.
          await cancelled_p
        }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {
          throw new Error('mock substrate: no external tools')
        },
        async cancel(): Promise<void> {
          cancelled = true
          if (cancelSignal !== null) cancelSignal()
        },
        tool_resolution: 'internal',
      }
    },
  }
  return { substrate, specs, cancelled: () => cancelled }
}

const forgeInput = (over: Partial<TridentDispatchInput> = {}): TridentDispatchInput => ({
  kind: 'forge',
  phase: 'forge-init',
  system: 'forge',
  user_message: 'BUILD: add a feature flag',
  repo_path: '/repo',
  trident_run_id: 'run-1',
  model: 'claude-sonnet-4-6',
  timeout_ms: 30_000,
  ...over,
})

describe('buildSubstrateTridentDispatch — adapter mechanics', () => {
  test('coalesces token events into terminal text and maps completion → completed', async () => {
    const rec = recordingSubstrate(() => [
      { kind: 'token', text: 'PR_NUMBER=42\n' },
      { kind: 'token', text: 'BRANCH=feat-x\n' },
      { kind: 'token', text: 'WORKTREE=/repo' },
      completion(),
    ])
    const dispatch = buildSubstrateTridentDispatch({ substrate: rec.substrate })
    const out = await dispatch(forgeInput())

    expect(out.status).toBe('completed')
    expect(out.result).toBe('PR_NUMBER=42\nBRANCH=feat-x\nWORKTREE=/repo')
  })

  test('builds a TOOL-LESS AgentSpec carrying the rendered user_message + model', async () => {
    const rec = recordingSubstrate(() => [{ kind: 'token', text: 'ok' }, completion()])
    const dispatch = buildSubstrateTridentDispatch({ substrate: rec.substrate })
    await dispatch(forgeInput({ user_message: 'render this turn', model: 'claude-opus-4-8' }))

    expect(rec.specs).toHaveLength(1)
    const spec = rec.specs[0]!
    expect(spec.prompt).toBe('render this turn')
    expect(spec.tools).toEqual([])
    expect(spec.model_preference).toEqual(['claude-opus-4-8'])
  })

  test('an error event maps to failed (a crashed sub-agent) and cancels', async () => {
    const rec = recordingSubstrate(() => [
      { kind: 'token', text: 'partial' },
      { kind: 'error', message: 'model overloaded', retryable: true },
    ])
    const dispatch = buildSubstrateTridentDispatch({ substrate: rec.substrate })
    const out = await dispatch(forgeInput())

    expect(out.status).toBe('failed')
    expect(out.result).toBe('partial')
    expect(rec.cancelled()).toBe(true)
  })

  test('a stream that ENDS WITHOUT a terminal completion event maps to failed, NOT a silent completion (paused ≠ finished)', async () => {
    // The persistent-REPL substrate always settles a real turn with a
    // `completion` or `error` event before closing its channel. A stream that
    // ends with neither — a paused / abnormally-closed turn (e.g. a Stop hook
    // held the turn, or it yielded to await an out-of-band review that never
    // resumes it) — must NOT be classified as `completed`, or the build would
    // be silently advanced as if it succeeded (the FALSE-COMPLETION race;
    // Vajra fleet-premature-completion reconciliation #160/#164).
    const rec = recordingSubstrate(() => [
      { kind: 'token', text: 'did some work…' },
      // No completion(), no error — the generator just returns (channel close).
    ])
    const dispatch = buildSubstrateTridentDispatch({ substrate: rec.substrate })
    const out = await dispatch(forgeInput())

    expect(out.status).toBe('failed')
    expect(out.result).toBe('did some work…')
  })

  test('a start() throw maps to failed without surfacing the raw error', async () => {
    const rec = recordingSubstrate(() => [], { throwOnStart: true })
    const dispatch = buildSubstrateTridentDispatch({ substrate: rec.substrate })
    const out = await dispatch(forgeInput())

    expect(out.status).toBe('failed')
    expect(out.result).toBe('')
  })

  test('build_substrate is invoked PER dispatch with the run worktree as cwd', async () => {
    const cwds: string[] = []
    const rec = recordingSubstrate(() => [{ kind: 'token', text: 'ok' }, completion()])
    const dispatch = buildSubstrateTridentDispatch({
      build_substrate: (cwd: string) => {
        cwds.push(cwd)
        return rec.substrate
      },
    })

    await dispatch(forgeInput({ repo_path: '/worktrees/run-a' }))
    await dispatch(forgeInput({ repo_path: '/worktrees/run-b' }))

    // A FRESH substrate is requested per turn, each rooted at THAT run's
    // worktree — never a single fixed (owner_home) cwd.
    expect(cwds).toEqual(['/worktrees/run-a', '/worktrees/run-b'])
  })

  test('a build_substrate that throws maps to failed (a crashed sub-agent)', async () => {
    const dispatch = buildSubstrateTridentDispatch({
      build_substrate: () => {
        throw new Error('empty credential pool')
      },
    })
    const out = await dispatch(forgeInput())

    expect(out.status).toBe('failed')
    expect(out.result).toBe('')
  })

  test('throws at construction when neither substrate nor build_substrate is supplied', () => {
    expect(() => buildSubstrateTridentDispatch({})).toThrow(/exactly one of/)
  })

  test('a turn that never completes is cancelled at timeout_ms → timed_out', async () => {
    const rec = recordingSubstrate(() => [{ kind: 'token', text: 'thinking…' }], { hang: true })
    // Inject a synchronous timer so the timeout fires deterministically.
    let fire: (() => void) | null = null
    const dispatch = buildSubstrateTridentDispatch({
      substrate: rec.substrate,
      set_timer: (fn) => {
        fire = fn
        return 1
      },
      clear_timer: () => {},
    })
    const p = dispatch(forgeInput({ timeout_ms: 5 }))
    // Let the iterator yield its one token + reach the hang, then trip timeout.
    await Promise.resolve()
    expect(fire).not.toBeNull()
    fire!()
    const out = await p

    expect(out.status).toBe('timed_out')
    expect(rec.cancelled()).toBe(true)
  })
})
