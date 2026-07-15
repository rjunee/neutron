/**
 * trident/terminate.test.ts — the §F6a terminal-write CHOKEPOINT.
 *
 * Proves `buildTridentTerminator` is the ONE terminal-write path for the
 * out-of-band callers (`/code stop`, board X-cancel/delete):
 *   • it WRITES the terminal phase (+ optional reason) through the store,
 *   • it RUNS the observer chain by default (the X-cancel/delete fix),
 *   • it RECORDS why it didn't (`caller_notifies` for `/code stop`, `no_observer`,
 *     `run_not_found`, `not_terminal_phase`),
 *   • an observer failure is caught + logged, never propagated (best-effort).
 *
 * MUTATION-VERIFY: the `runObservers:false` / no-observer cases assert the spy
 * stays UNCALLED — bypassing the chokepoint (calling `store.update` directly)
 * would fire no observer and red the `observed` assertions in the callers' tests.
 */

import { describe, expect, test } from 'bun:test'

import { buildTridentTerminator, type TridentTerminateStore } from './terminate.ts'
import type { TridentPhase, TridentRun } from './store.ts'
import type { TridentTerminalHook } from './tick.ts'

function fakeRun(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'run-1',
    slug: 'demo',
    project_slug: 'owner',
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 20,
    branch: null,
    pr: null,
    merge_mode: 'local',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/tmp/repo',
    worktree: null,
    task: 'demo task',
    chat_id: null,
    thread_id: null,
    channel_kind: 'app_socket',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-07-14T00:00:00.000Z',
    last_advanced_at: '2026-07-14T00:00:00.000Z',
    ...over,
  }
}

const TERMINAL = new Set<TridentPhase>(['done', 'failed', 'stopped'])

/**
 * A store spy modelling the ATOMIC conditional transition: it holds the current
 * row and wins (`won:true`, applying the patch) ONLY when that row is non-terminal
 * — exactly the `WHERE phase NOT IN (terminal)` guard the real store runs. A write
 * against an already-terminal seed loses (`won:false`) and leaves the row intact,
 * so the chokepoint's no-clobber / no-re-observe contract is verifiable here.
 */
function fakeStore(seed: TridentRun | null = fakeRun()): {
  store: TridentTerminateStore
  writes: Array<{ id: string; phase: TridentPhase; failure_reason?: string | null }>
} {
  const writes: Array<{ id: string; phase: TridentPhase; failure_reason?: string | null }> = []
  let current = seed
  return {
    store: {
      terminalTransition: async (id, patch) => {
        writes.push({ id, ...patch })
        if (current === null) return { run: null, won: false }
        if (TERMINAL.has(current.phase)) return { run: current, won: false }
        current = {
          ...current,
          phase: patch.phase,
          ...(patch.failure_reason !== undefined ? { failure_reason: patch.failure_reason } : {}),
        }
        return { run: current, won: true }
      },
    },
    writes,
  }
}

/** An observer spy in the tick loop's `TridentTerminalHook` shape. */
function spyObserver(): { hook: TridentTerminalHook; fired: TridentRun[] } {
  const fired: TridentRun[] = []
  return {
    hook: {
      onTerminal: async (run) => {
        fired.push(run)
      },
    },
    fired,
  }
}

describe('buildTridentTerminator', () => {
  test('writes the terminal phase AND runs the observer chain by default (X-cancel/delete fix)', async () => {
    const { store, writes } = fakeStore()
    const { hook, fired } = spyObserver()
    const term = buildTridentTerminator({ store, observer: hook })

    const res = await term.terminate('run-1', 'stopped')

    expect(writes).toEqual([{ id: 'run-1', phase: 'stopped' }])
    expect(res.won).toBe(true)
    expect(res.observed).toBe(true)
    expect(res.skipped_reason).toBeUndefined()
    expect(fired.map((r) => r.phase)).toEqual(['stopped'])
    // The observer sees the WRITTEN (terminal) row, not the pre-write one.
    expect(fired[0]?.id).toBe('run-1')
  })

  test('persists a failure_reason when supplied', async () => {
    const { store, writes } = fakeStore()
    const { hook, fired } = spyObserver()
    const term = buildTridentTerminator({ store, observer: hook })

    await term.terminate('run-1', 'failed', { reason: 'suspected hang' })

    expect(writes).toEqual([{ id: 'run-1', phase: 'failed', failure_reason: 'suspected hang' }])
    expect(fired[0]?.failure_reason).toBe('suspected hang')
  })

  test('runObservers:false writes but SKIPS the chain (the `/code stop` synchronous-reply case)', async () => {
    const { store, writes } = fakeStore()
    const { hook, fired } = spyObserver()
    const term = buildTridentTerminator({ store, observer: hook })

    const res = await term.terminate('run-1', 'stopped', { runObservers: false })

    // Still the ONE write path — but no double-notify (the command replies itself).
    expect(writes).toEqual([{ id: 'run-1', phase: 'stopped' }])
    expect(res.observed).toBe(false)
    expect(res.skipped_reason).toBe('caller_notifies')
    expect(fired).toEqual([]) // <- reds if stop ever fired delivery (double-notify)
  })

  test('no observer wired → writes, records `no_observer`', async () => {
    const { store, writes } = fakeStore()
    const term = buildTridentTerminator({ store })

    const res = await term.terminate('run-1', 'stopped')

    expect(writes).toEqual([{ id: 'run-1', phase: 'stopped' }])
    expect(res.observed).toBe(false)
    expect(res.skipped_reason).toBe('no_observer')
  })

  test('run not found → no observer, records `run_not_found`', async () => {
    const { store } = fakeStore(null)
    const { hook, fired } = spyObserver()
    const term = buildTridentTerminator({ store, observer: hook })

    const res = await term.terminate('gone', 'stopped')

    expect(res.run).toBeNull()
    expect(res.observed).toBe(false)
    expect(res.skipped_reason).toBe('run_not_found')
    expect(fired).toEqual([])
  })

  test('a concurrently-terminalized run is NOT overwritten and NOT re-observed (race lost)', async () => {
    // The tick loop already persisted a real `done` result and delivered success.
    // A board delete then races to cancel the SAME run: the atomic transition must
    // LOSE — no clobber of `done`→`stopped`, and crucially no second observer fire
    // (which would double-notify with a bogus "stopped" outcome).
    const { store } = fakeStore(fakeRun({ phase: 'done' }))
    const { hook, fired } = spyObserver()
    const term = buildTridentTerminator({ store, observer: hook })

    const res = await term.terminate('run-1', 'stopped')

    expect(res.won).toBe(false) // <- the atomic transition lost
    expect(res.observed).toBe(false)
    expect(res.skipped_reason).toBe('already_terminal')
    expect(res.run?.phase).toBe('done') // <- reds if the loser clobbers the result
    expect(fired).toEqual([]) // <- reds on the double-notify this fix prevents
  })

  test('refuses a non-terminal phase (defensive) — no write, no observer', async () => {
    const { store, writes } = fakeStore()
    const { hook, fired } = spyObserver()
    const term = buildTridentTerminator({ store, observer: hook })

    const res = await term.terminate('run-1', 'argus')

    expect(writes).toEqual([])
    expect(res.observed).toBe(false)
    expect(res.skipped_reason).toBe('not_terminal_phase')
    expect(fired).toEqual([])
  })

  test('an observer failure is caught + recorded, never propagated (best-effort)', async () => {
    const { store } = fakeStore()
    const term = buildTridentTerminator({
      store,
      observer: {
        onTerminal: async () => {
          throw new Error('delivery outage')
        },
      },
    })

    const res = await term.terminate('run-1', 'stopped')

    // The write LANDED; the observer threw but the caller is not blocked.
    expect(res.run?.phase).toBe('stopped')
    expect(res.observed).toBe(false)
    expect(res.skipped_reason).toBe('observer_error')
  })
})
