import { describe, expect, test } from 'bun:test'

import { NO_ADVANCE_HANG_MS } from './liveness.ts'
import { runDrivingVerdict } from './run-driving.ts'
import type { TridentRun } from './store.ts'

const T0 = Date.parse('2026-08-14T21:35:47Z')

function run(over: Partial<TridentRun> = {}): TridentRun {
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
    branch: 'trident/demo',
    pr: null,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    repo_path: '/repo',
    worktree: null,
    task: 'build a thing',
    chat_id: null,
    thread_id: null,
    channel_kind: 'app_socket',
    failure_reason: null,
    workflow_run_id: null,
    inner_checkpoint: null,
    inner_checkpoint_head: null,
    inner_checkpoint_findings: null,
    inner_verdict: null,
    inner_result: null,
    started_at: '2026-08-14T21:35:47Z',
    last_advanced_at: '2026-08-14T21:35:47Z',
    harvested_at: null,
    crash_recoveries: 0,
    reviewed_head: null,
    bound_pr: null,
    fenced_paths: null,
    ...over,
  }
}

describe('runDrivingVerdict', () => {
  test('a run that advanced moments ago is driving', () => {
    const v = runDrivingVerdict(run(), T0 + 60_000)
    expect(v).toEqual({ driving: true, reason: 'advancing', since_advance_ms: 60_000 })
  })

  test('a LONG-RUNNING but still-advancing build is driving right up to the threshold', () => {
    // The exact boundary: the reaper reaps STRICTLY past the threshold, and so
    // does this — one shared number, one shared comparison.
    const v = runDrivingVerdict(run(), T0 + NO_ADVANCE_HANG_MS)
    expect(v.driving).toBe(true)
    expect(v.reason).toBe('advancing')
  })

  test('a NON-TERMINAL run parked past the hang threshold is NOT driving', () => {
    // The live shape: phase never left `forge-init`, so the old
    // `!isTerminalPhase(phase)` test called this a driver forever.
    const v = runDrivingVerdict(run({ phase: 'forge-init' }), T0 + NO_ADVANCE_HANG_MS + 1)
    expect(v.driving).toBe(false)
    expect(v.reason).toBe('no-advance')
    expect(v.since_advance_ms).toBe(NO_ADVANCE_HANG_MS + 1)
  })

  test('every terminal phase is not driving, however recently it moved', () => {
    for (const phase of ['done', 'failed', 'stopped'] as const) {
      const v = runDrivingVerdict(run({ phase }), T0 + 1_000)
      expect(v.driving).toBe(false)
      expect(v.reason).toBe('terminal')
    }
  })

  test('an unparseable last_advanced_at reads as just-advanced, like the reaper', () => {
    // `orchestrator.ts:2380-2388` and `run-progress.ts:140-141` both fold a
    // corrupt stamp to 0 elapsed; disagreeing here would have the reaper and this
    // backstop draw opposite conclusions from one broken row.
    const v = runDrivingVerdict(run({ last_advanced_at: 'not-a-date' }), T0 + 10 * NO_ADVANCE_HANG_MS)
    expect(v).toEqual({ driving: true, reason: 'advancing', since_advance_ms: 0 })
  })

  test('a clock behind the stamp never yields a negative elapsed', () => {
    expect(runDrivingVerdict(run(), T0 - 60_000).since_advance_ms).toBe(0)
  })

  test('the threshold is injectable and is compared strictly', () => {
    expect(runDrivingVerdict(run(), T0 + 1_000, 1_000).driving).toBe(true)
    expect(runDrivingVerdict(run(), T0 + 1_001, 1_000).driving).toBe(false)
  })
})
