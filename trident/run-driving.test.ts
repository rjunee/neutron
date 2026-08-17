import { describe, expect, test } from 'bun:test'

import { DEFAULT_SETTLE_TIMEOUT_MS, NO_ADVANCE_HANG_MS } from './liveness.ts'
import {
  FUTURE_STAMP_TOLERANCE_MS,
  runDrivingVerdict,
  WAKEUP_REAP_MARGIN_MS,
  WAKEUP_STAND_DOWN_MS,
} from './run-driving.ts'
import type { TridentRun } from './store.ts'
import { makeTridentRun } from './testing/make-trident-run.ts'

const T0 = Date.parse('2026-08-14T21:35:47Z')

/** The trident sweep cadence the reap margin has to cover (`tick.ts:344`). */
const TICK_INTERVAL_MS = 90_000

function run(over: Partial<TridentRun> = {}): TridentRun {
  return makeTridentRun({
    id: 'run-1',
    slug: 'demo',
    project_slug: 'owner',
    branch: 'trident/demo',
    merge_mode: 'pr',
    // A LAUNCHED run is the realistic default: a clean fire writes both columns
    // in one update (`orchestrator.ts:2106-2114`). Tests that want the
    // not-yet-launched shape null them explicitly.
    subagent_run_id: 'wf-1',
    repo_path: '/repo',
    task: 'build a thing',
    channel_kind: 'app_socket',
    workflow_run_id: 'wf-1',
    started_at: '2026-08-14T21:35:47Z',
    last_advanced_at: '2026-08-14T21:35:47Z',
    ...over,
  })
}

describe('runDrivingVerdict — the threshold ordering that makes the timer safe', () => {
  test('the stand-down threshold is STRICTLY above the reaper, by more than a sweep', () => {
    // This is the safety property, asserted on the constants themselves rather
    // than only on behaviour: the reaper (`orchestrator.ts:2570`) must always get
    // to answer for a run it can reach before this timer is consulted, and it
    // notices on a 90 s sweep (`tick.ts:344`).
    expect(WAKEUP_STAND_DOWN_MS).toBeGreaterThan(NO_ADVANCE_HANG_MS)
    expect(WAKEUP_REAP_MARGIN_MS).toBeGreaterThan(TICK_INTERVAL_MS)
    expect(WAKEUP_STAND_DOWN_MS).toBe(NO_ADVANCE_HANG_MS + WAKEUP_REAP_MARGIN_MS)
  })

  test('PROPERTY 1 — a build the reaper can reach still SUPPRESSES the wakeup at the reaper threshold', () => {
    // The blocker the first cut shipped: at exactly `NO_ADVANCE_HANG_MS` a HEALTHY
    // long Forge step — `last_advanced_at` is stale by construction mid-phase
    // (`liveness.ts:46-59`) — was declared not-driving and the item was woken
    // while the build worked. It has a dispatch id, so the reaper owns this
    // moment; the wakeup must not.
    const live = run({ subagent_run_id: 'wf-1', subagent_status: 'running' })
    const v = runDrivingVerdict(live, T0 + NO_ADVANCE_HANG_MS + 1)
    expect(v.driving).toBe(true)
    expect(v.reason).toBe('advancing')
  })

  test('PROPERTY 1 — a launch still IN FLIGHT is never read as "no workflow exists"', () => {
    // The other blocker. `subagent_run_id`/`subagent_status` are written only
    // AFTER the fire settles (`orchestrator.ts:2106-2114`), and the settle timer
    // (3 min, `liveness.ts:115`) triggers a cancellation that is itself unbounded
    // — the fire keeps draining `handle.events` after `cancel()`
    // (`inner-loop.ts:774-786`). So a null/null row past the settle budget is
    // routinely a LIVE launch, and treating it as proof of no workflow invited a
    // second dispatch onto it. Nothing may stand this run down on those columns.
    const launching = run({ subagent_run_id: null, subagent_status: null })
    for (const t of [
      DEFAULT_SETTLE_TIMEOUT_MS,
      DEFAULT_SETTLE_TIMEOUT_MS + 1,
      DEFAULT_SETTLE_TIMEOUT_MS * 10,
      NO_ADVANCE_HANG_MS,
    ]) {
      const v = runDrivingVerdict(launching, T0 + t)
      expect(v.driving).toBe(true)
      expect(v.reason).toBe('advancing')
    }
  })

  test('PROPERTY 2 — a run that stopped advancing stops suppressing, so the item is never invisible forever', () => {
    // The reported incident: parked at `forge-init`, non-terminal, not moving.
    const parked = run({ phase: 'forge-init' })
    expect(runDrivingVerdict(parked, T0 + WAKEUP_STAND_DOWN_MS).driving).toBe(true)
    const v = runDrivingVerdict(parked, T0 + WAKEUP_STAND_DOWN_MS + 1)
    expect(v.driving).toBe(false)
    expect(v.reason).toBe('no-advance')
    expect(v.since_advance_ms).toBe(WAKEUP_STAND_DOWN_MS + 1)
  })

  test('PROPERTY 2 — a run the reaper CANNOT reach is still released by the timer', () => {
    // Both reap paths require a dispatch id or a crashed launcher
    // (`orchestrator.ts:2470`, `:2570`). A run that never obtained one is
    // reachable by neither, so this timer is the only thing that frees its item.
    const unreachable = run({ subagent_run_id: null, subagent_status: null })
    const v = runDrivingVerdict(unreachable, T0 + WAKEUP_STAND_DOWN_MS + 1)
    expect(v.driving).toBe(false)
    expect(v.reason).toBe('no-advance')
  })

  test('PROPERTY 2 — a reaper-REACHABLE `running` row is released too, past the threshold', () => {
    // THE ACCEPTED RESIDUE, ASSERTED RATHER THAN ONLY DESCRIBED. The module header
    // is explicit that the margin does NOT establish mutual exclusion: 90 s is the
    // reap sweep's cadence, not a bound on its latency, and a sweep wedged inside
    // `step` (`tick.ts:719-721`) can miss this run indefinitely. So a row that
    // still says `running` — the shape PROPERTY 1 protects at the reaper threshold
    // — does eventually flip to released, and a review reading only the
    // `NO_ADVANCE_HANG_MS + 1` case above could reasonably have believed otherwise.
    //
    // It is the same behaviour as the parked and unreachable cases and that is the
    // point: past the stand-down threshold the timer stops caring WHY the run went
    // quiet. What bounds the damage is that a live inner workflow re-stamps
    // `last_advanced_at` itself, out of process (`checkpoint.sh:196`), so a build
    // that reaches checkpoints at all never arrives here. What remains is a build
    // quieter than the threshold — the known heartbeat gap, ISSUES #534 — and the
    // prompt now names the parked run so the released turn reaps rather than races
    // it (`gateway/proactive/work-wakeup.ts` `buildWakeupPrompt`).
    const live = run({ subagent_run_id: 'wf-1', subagent_status: 'running' })
    expect(runDrivingVerdict(live, T0 + WAKEUP_STAND_DOWN_MS).driving).toBe(true)
    const v = runDrivingVerdict(live, T0 + WAKEUP_STAND_DOWN_MS + 1)
    expect(v.driving).toBe(false)
    expect(v.reason).toBe('no-advance')
  })
})

describe('runDrivingVerdict', () => {
  test('a run that advanced moments ago is driving', () => {
    const v = runDrivingVerdict(run(), T0 + 60_000)
    expect(v).toEqual({ driving: true, reason: 'advancing', since_advance_ms: 60_000 })
  })

  test('every terminal phase is not driving, however recently it moved', () => {
    for (const phase of ['done', 'failed', 'stopped'] as const) {
      const v = runDrivingVerdict(run({ phase }), T0 + 1_000)
      expect(v.driving).toBe(false)
      expect(v.reason).toBe('terminal')
    }
  })

  test('a terminal phase wins even past the stand-down threshold — a fact beats a timer', () => {
    // This is the ordering paying off: by the time the timer would speak, a
    // reaper-reachable run has already been flipped, and THIS is the branch that
    // answers for it.
    const reaped = run({ phase: 'failed' })
    const v = runDrivingVerdict(reaped, T0 + WAKEUP_STAND_DOWN_MS + 1)
    expect(v.reason).toBe('terminal')
  })

  test('an unparseable last_advanced_at is NOT a reading, so the run stands down', () => {
    // Failing the other way (treating it as just-advanced, for symmetry with the
    // reaper) hides the item forever: the reaper reads the same 0 and never
    // recovers it either. No reading is not a good reading.
    const v = runDrivingVerdict(run({ last_advanced_at: 'not-a-date' }), T0 + 60_000)
    expect(v).toEqual({ driving: false, reason: 'unknown-advance', since_advance_ms: 0 })
  })

  test('a stamp from the FUTURE beyond tolerance is not a reading either', () => {
    const v = runDrivingVerdict(run(), T0 - FUTURE_STAMP_TOLERANCE_MS - 1)
    expect(v.driving).toBe(false)
    expect(v.reason).toBe('unknown-advance')
  })

  test('jitter inside the future tolerance is still a healthy advancing run', () => {
    const v = runDrivingVerdict(run(), T0 - FUTURE_STAMP_TOLERANCE_MS)
    expect(v).toEqual({ driving: true, reason: 'advancing', since_advance_ms: 0 })
  })

  test('a CRASHED launcher keeps the conservative timer — its build may still be detached', () => {
    // `orchestrator.ts:2250-2257`: a dead launcher is not a dead build.
    const crashed = run({ subagent_run_id: null, subagent_status: 'crashed' })
    expect(runDrivingVerdict(crashed, T0 + NO_ADVANCE_HANG_MS + 1).driving).toBe(true)
    expect(runDrivingVerdict(crashed, T0 + WAKEUP_STAND_DOWN_MS + 1).reason).toBe('no-advance')
  })

  test('a clock behind the stamp never yields a negative elapsed', () => {
    expect(runDrivingVerdict(run(), T0 - 60_000).since_advance_ms).toBe(0)
  })

  test('the threshold is injectable and is compared strictly', () => {
    expect(runDrivingVerdict(run(), T0 + 1_000, 1_000).driving).toBe(true)
    expect(runDrivingVerdict(run(), T0 + 1_001, 1_000).driving).toBe(false)
  })
})
