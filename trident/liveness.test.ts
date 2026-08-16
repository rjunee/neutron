/**
 * Tests for liveness timing constants. Verifies the ordering invariant:
 * warn < reap < ceiling.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TIMEOUT_MS,
  LIVENESS_PROBE_INTERVAL_MS,
  STALLED_WARN_MS,
  NO_ADVANCE_HANG_MS,
  DEFAULT_MAX_INFLIGHT_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
} from './liveness.ts'

describe('liveness constants — ordering invariant', () => {
  test('STALLED_WARN_MS (warn threshold) < NO_ADVANCE_HANG_MS (reap threshold)', () => {
    expect(STALLED_WARN_MS).toBeLessThan(NO_ADVANCE_HANG_MS)
    // warn: 30m, reap: 90m — both RAISED 2026-08-11, see below.
    expect(STALLED_WARN_MS).toBe(30 * 60_000)
    expect(NO_ADVANCE_HANG_MS).toBe(90 * 60_000)
  })

  test('NO_ADVANCE_HANG_MS (reap threshold) < DEFAULT_MAX_INFLIGHT_MS (ceiling)', () => {
    expect(NO_ADVANCE_HANG_MS).toBeLessThan(DEFAULT_MAX_INFLIGHT_MS)
    expect(NO_ADVANCE_HANG_MS).toBe(90 * 60_000)
    expect(DEFAULT_MAX_INFLIGHT_MS).toBe(2 * 60 * 60_000)
  })

  // THE LESSON, NOT JUST THE NUMBERS. The pins above are a "did you mean this"
  // tripwire; this one encodes WHY they moved, so a future tuning pass cannot
  // quietly restore the failure.
  //
  // On 2026-08-11 the reap threshold was 25 min — fitted to an estimate that "a
  // large build can legitimately run 15–20 min" in a single Forge step. The
  // owner's real build ran 26 minutes and was reaped WHILE WORKING: transcript
  // 381 KB, 8 seconds old, correct files uncommitted in its worktree.
  //
  // The signal is the real defect (`last_advanced_at` only moves at checkpoint
  // boundaries, so it is stale by construction mid-phase — ISSUES #534). Until a
  // real heartbeat lands, the threshold must be OBVIOUSLY GENEROUS rather than
  // finely tuned, because a tuned number is exactly what failed.
  test('the reap threshold is generous, not fitted to an estimate of build duration', () => {
    expect(NO_ADVANCE_HANG_MS).toBeGreaterThanOrEqual(60 * 60_000)
  })

  test('a warning still precedes a reap by a wide margin, so a stall is visible before it is killed', () => {
    // Not merely "warn < reap": the gap must be big enough for the owner to SEE
    // the warning and intervene. A warn at 89m against a reap at 90m satisfies
    // ordering and is useless.
    expect(NO_ADVANCE_HANG_MS - STALLED_WARN_MS).toBeGreaterThanOrEqual(30 * 60_000)
  })

  test('full ordering: warn < reap < ceiling', () => {
    expect(STALLED_WARN_MS < NO_ADVANCE_HANG_MS && NO_ADVANCE_HANG_MS < DEFAULT_MAX_INFLIGHT_MS).toBe(
      true,
    )
  })

  test('DEFAULT_TIMEOUT_MS (conflict resolver timeout) is defined', () => {
    // 8 minutes — resolver's per-turn wall-clock ceiling
    expect(DEFAULT_TIMEOUT_MS).toBe(8 * 60_000)
  })

  // The EXTERNAL liveness probe polls far faster than any display or reap
  // threshold — that is the whole point: a hard death is named in seconds instead
  // of waiting out the 90-minute backstop. It is a POLL RATE, not a threshold: its
  // answer is binary process aliveness, so it can never reap a slow-but-alive run.
  test('LIVENESS_PROBE_INTERVAL_MS is a fast, finite cadence well under every threshold', () => {
    expect(Number.isFinite(LIVENESS_PROBE_INTERVAL_MS)).toBe(true)
    expect(LIVENESS_PROBE_INTERVAL_MS).toBeGreaterThan(0)
    expect(LIVENESS_PROBE_INTERVAL_MS).toBeLessThan(STALLED_WARN_MS)
  })

  test('DEFAULT_SETTLE_TIMEOUT_MS (launching turn settle) is defined', () => {
    // 3 minutes — generous for cold REPL spawn + Workflow fire + reply
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBe(3 * 60_000)
  })
})
