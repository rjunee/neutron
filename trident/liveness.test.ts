/**
 * Tests for liveness timing constants. Verifies the ordering invariant:
 * warn < reap < ceiling.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_TIMEOUT_MS,
  STALLED_WARN_MS,
  NO_ADVANCE_HANG_MS,
  DEFAULT_MAX_INFLIGHT_MS,
  DEFAULT_SETTLE_TIMEOUT_MS,
} from './liveness.ts'

describe('liveness constants — ordering invariant', () => {
  test('STALLED_WARN_MS (warn threshold) < NO_ADVANCE_HANG_MS (reap threshold)', () => {
    expect(STALLED_WARN_MS).toBeLessThan(NO_ADVANCE_HANG_MS)
    // warn: 10m, reap: 25m
    expect(STALLED_WARN_MS).toBe(10 * 60_000)
    expect(NO_ADVANCE_HANG_MS).toBe(25 * 60_000)
  })

  test('NO_ADVANCE_HANG_MS (reap threshold) < DEFAULT_MAX_INFLIGHT_MS (ceiling)', () => {
    expect(NO_ADVANCE_HANG_MS).toBeLessThan(DEFAULT_MAX_INFLIGHT_MS)
    // reap: 25m, ceiling: 2h
    expect(NO_ADVANCE_HANG_MS).toBe(25 * 60_000)
    expect(DEFAULT_MAX_INFLIGHT_MS).toBe(2 * 60 * 60_000)
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

  test('DEFAULT_SETTLE_TIMEOUT_MS (launching turn settle) is defined', () => {
    // 3 minutes — generous for cold REPL spawn + Workflow fire + reply
    expect(DEFAULT_SETTLE_TIMEOUT_MS).toBe(3 * 60_000)
  })
})
