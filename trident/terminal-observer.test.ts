/**
 * trident/terminal-observer.test.ts — delivery/observer isolation.
 *
 * Regression guard (Codex P2, 2026-06-26): the Skill Forge auto-skillify
 * observer must NOT be skipped when terminal-result delivery throws — the run
 * is already terminal, so the tick loop never re-fires the hook, and a delivery
 * outage would otherwise permanently drop the proposal for a completed run.
 */

import { describe, expect, test } from 'bun:test'

import { withTerminalObserver } from './terminal-observer.ts'
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
    started_at: '2026-06-26T00:00:00.000Z',
    last_advanced_at: '2026-06-26T00:01:00.000Z',
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
