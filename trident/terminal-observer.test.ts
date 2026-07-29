/**
 * trident/terminal-observer.test.ts — delivery/observer isolation.
 *
 * Regression guard (Codex P2, 2026-06-26): the Skill Forge auto-skillify
 * observer must NOT be skipped when terminal-result delivery throws — the run
 * is already terminal, so the tick loop never re-fires the hook, and a delivery
 * outage would otherwise permanently drop the proposal for a completed run.
 */

import { describe, expect, test } from 'bun:test'

import { composeTerminalHook, withTerminalObserver } from './terminal-observer.ts'
import type { TridentRun } from './store.ts'
import type { TridentTerminalHook } from './tick.ts'

function run(): TridentRun {
  return {
    id: 'r1',
    slug: 'demo',
    project_slug: 'owner',
    phase: 'done',
    round: 1,
    max_rounds: 5,
    ralph: false,
    ralph_round: 0,
    max_ralph_rounds: 0,
    branch: null,
    pr: null,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/tmp/repo',
    worktree: null,
    task: 'demo task',
    chat_id: null,
    thread_id: null,
    channel_kind: 'telegram',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-06-26T00:00:00.000Z',
    last_advanced_at: '2026-06-26T00:01:00.000Z',
    harvested_at: null,
  }
}

function hook(onTerminal: (r: TridentRun) => Promise<void>): TridentTerminalHook {
  return { onTerminal }
}

describe('withTerminalObserver', () => {
  test('happy path: delivery then observer both run', async () => {
    const order: string[] = []
    const composed = withTerminalObserver(
      hook(async () => {
        order.push('delivery')
      }),
      async () => {
        order.push('observer')
      },
    )
    await composed.onTerminal(run())
    expect(order).toEqual(['delivery', 'observer'])
  })

  test('observer STILL runs when delivery throws (and the delivery error re-throws)', async () => {
    let observed = false
    const composed = withTerminalObserver(
      hook(async () => {
        throw new Error('channel send failed')
      }),
      async () => {
        observed = true
      },
    )
    await expect(composed.onTerminal(run())).rejects.toThrow('channel send failed')
    expect(observed).toBe(true)
  })

  test('observer error is swallowed (delivery still ran, no throw)', async () => {
    let delivered = false
    const composed = withTerminalObserver(
      hook(async () => {
        delivered = true
      }),
      async () => {
        throw new Error('audit blew up')
      },
    )
    await composed.onTerminal(run())
    expect(delivered).toBe(true)
  })
})

describe('composeTerminalHook — the shared delivery+observers assembly (§F6a)', () => {
  test('ordering: delivery runs FIRST, then each observer in registration order', async () => {
    const order: string[] = []
    const composed = composeTerminalHook(
      hook(async () => {
        order.push('delivery')
      }),
      [
        async () => {
          order.push('obs-a')
        },
        async () => {
          order.push('obs-b')
        },
      ],
    )
    await composed.onTerminal(run())
    expect(order).toEqual(['delivery', 'obs-a', 'obs-b'])
  })

  test('a delivery failure still runs EVERY observer (and the delivery error re-throws)', async () => {
    const ran: string[] = []
    const composed = composeTerminalHook(
      hook(async () => {
        throw new Error('channel send failed')
      }),
      [
        async () => {
          ran.push('obs-a')
        },
        async () => {
          ran.push('obs-b')
        },
      ],
    )
    // Delivery threw → the loop's on_terminal try/catch still sees the failure…
    await expect(composed.onTerminal(run())).rejects.toThrow('channel send failed')
    // …but both observers ran regardless (the run is terminal; the hook never re-fires).
    expect(ran).toEqual(['obs-a', 'obs-b'])
  })

  test('one observer failure does NOT suppress the later observers (each isolated)', async () => {
    const ran: string[] = []
    const composed = composeTerminalHook(
      hook(async () => {
        ran.push('delivery')
      }),
      [
        async () => {
          ran.push('obs-a')
        },
        async () => {
          throw new Error('obs-b blew up')
        },
        async () => {
          ran.push('obs-c')
        },
      ],
    )
    // obs-b throwing is swallowed → no throw, and obs-c still runs after it.
    await composed.onTerminal(run())
    expect(ran).toEqual(['delivery', 'obs-a', 'obs-c'])
  })

  test('zero observers preserves the delivery behaviour EXACTLY (returns delivery as-is)', async () => {
    // Success: delivery runs.
    let delivered = false
    const ok = composeTerminalHook(
      hook(async () => {
        delivered = true
      }),
      [],
    )
    await ok.onTerminal(run())
    expect(delivered).toBe(true)

    // Failure: with no observers, a delivery throw propagates unchanged (no
    // withTerminalObserver wrapper is added — it IS the delivery hook).
    const bad = composeTerminalHook(
      hook(async () => {
        throw new Error('bare delivery failure')
      }),
      [],
    )
    await expect(bad.onTerminal(run())).rejects.toThrow('bare delivery failure')
  })
})
