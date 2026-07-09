/**
 * @neutronai/agent-dispatch — cancellable substrate-turn tests.
 *
 * The fix for Codex's P1 ("stop didn't stop"): an abort signal must ACTUALLY
 * cancel the substrate `SessionHandle`, not just flip the registry record.
 */

import { describe, expect, test } from 'bun:test'

import type { Event } from '@neutronai/runtime/events.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import { buildCancellableDispatchTurn } from './index.ts'

/** A substrate whose event stream blocks until the test releases it, recording cancel(). */
function controllableSubstrate(state: {
  prompts: string[]
  cancelled: () => void
  release: { resolve: (ev: Event[]) => void; promise: Promise<Event[]> }
}): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      state.prompts.push(spec.prompt)
      async function* gen(): AsyncGenerator<Event> {
        const events = await state.release.promise
        for (const ev of events) yield ev
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {
          state.cancelled()
          // A real handle ends the stream on cancel — surface that to the loop.
          state.release.resolve([])
        },
        tool_resolution: 'internal',
      }
    },
  }
}

function deferred(): { resolve: (ev: Event[]) => void; promise: Promise<Event[]> } {
  let resolve: (ev: Event[]) => void = () => {}
  const promise = new Promise<Event[]>((r) => {
    resolve = r
  })
  return { resolve, promise }
}

const completion: Event = {
  kind: 'completion',
  usage: { input_tokens: 1, output_tokens: 1 },
  substrate_instance_id: 'mock',
}

describe('buildCancellableDispatchTurn', () => {
  test('runs a turn to completion, rooting the substrate at repo_path', async () => {
    const cwds: string[] = []
    const turn = buildCancellableDispatchTurn({
      build_substrate: (cwd) => {
        cwds.push(cwd)
        return {
          start(spec: AgentSpec): SessionHandle {
            async function* gen(): AsyncGenerator<Event> {
              yield { kind: 'token', text: `did: ${spec.prompt}` }
              yield completion
            }
            return {
              events: gen(),
              async respondToTool(): Promise<void> {},
              async cancel(): Promise<void> {},
              tool_resolution: 'internal',
            }
          },
        }
      },
    })
    const res = await turn({
      kind: 'atlas',
      system: 'atlas',
      user_message: 'task X',
      repo_path: '/work/here',
      trident_run_id: 'r1',
      model: 'm',
      timeout_ms: 0,
    })
    expect(res.status).toBe('completed')
    expect(res.result).toContain('task X')
    expect(cwds).toEqual(['/work/here'])
  })

  test('an abort signal cancels the live substrate and returns cancelled', async () => {
    let cancelCalls = 0
    const release = deferred()
    const turn = buildCancellableDispatchTurn({
      build_substrate: () =>
        controllableSubstrate({
          prompts: [],
          cancelled: () => {
            cancelCalls++
          },
          release,
        }),
    })
    const abort = new AbortController()
    const p = turn({
      kind: 'core',
      system: 'core',
      user_message: 'long task',
      repo_path: '/x',
      trident_run_id: 'r2',
      model: 'm',
      timeout_ms: 0,
      signal: abort.signal,
    })
    // The turn is blocked on the substrate stream; abort it.
    abort.abort()
    const res = await p
    expect(cancelCalls).toBe(1) // the subprocess was ACTUALLY cancelled
    expect(res.status).toBe('cancelled')
  })

  test('an already-aborted signal cancels immediately', async () => {
    let cancelCalls = 0
    const release = deferred()
    const turn = buildCancellableDispatchTurn({
      build_substrate: () =>
        controllableSubstrate({
          prompts: [],
          cancelled: () => {
            cancelCalls++
          },
          release,
        }),
    })
    const abort = new AbortController()
    abort.abort()
    const res = await turn({
      kind: 'core',
      system: 'core',
      user_message: 't',
      repo_path: '/x',
      trident_run_id: 'r3',
      model: 'm',
      timeout_ms: 0,
      signal: abort.signal,
    })
    expect(cancelCalls).toBe(1)
    expect(res.status).toBe('cancelled')
  })

  test('a build_substrate that throws is a failed turn', async () => {
    const turn = buildCancellableDispatchTurn({
      build_substrate: () => {
        throw new Error('empty pool')
      },
    })
    const res = await turn({
      kind: 'atlas',
      system: 'atlas',
      user_message: 't',
      repo_path: '/x',
      trident_run_id: 'r4',
      model: 'm',
      timeout_ms: 0,
    })
    expect(res.status).toBe('failed')
  })
})
