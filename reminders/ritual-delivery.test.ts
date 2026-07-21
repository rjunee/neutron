/**
 * @neutronai/reminders — ritual delivery pure-unit tests (plan task 5).
 *
 * The notice formatters (one line, ritual id + status/keyword + run id, no em
 * dashes) and the deterministic once-per-streak `shouldEscalate` truth table.
 */

import { describe, expect, test } from 'bun:test'

import {
  formatRitualBootReapNotice,
  formatRitualCompletionFallback,
  formatRitualEscalationNotice,
  formatRitualFailureNotice,
  shouldEscalate,
} from './ritual-delivery.ts'
import type { RitualRunStatus } from './ritual-runs.ts'

const row = (status: RitualRunStatus): { status: RitualRunStatus } => ({ status })

describe('ritual notice formatters', () => {
  test('failure notice: one line with id + status + run id, no em dash', () => {
    const s = formatRitualFailureNotice({ ritual_id: 'morning-brief', status: 'failed', run_id: 'r-1' })
    expect(s).toBe("Ritual 'morning-brief' failed (run r-1)")
    expect(s).not.toContain('\n')
    expect(s).not.toContain('—')
  })

  test('failure notice appends collapsed + capped reason', () => {
    const s = formatRitualFailureNotice({
      ritual_id: 'x',
      status: 'crashed',
      run_id: 'r-2',
      failure_reason: 'line one\n   line two\tand more',
    })
    expect(s).toBe("Ritual 'x' crashed (run r-2): line one line two and more")
    expect(s).not.toContain('\n')

    const long = formatRitualFailureNotice({
      ritual_id: 'x',
      status: 'failed',
      run_id: 'r-3',
      failure_reason: 'z'.repeat(500),
    })
    // base + ': ' + 160 reason chars
    expect(long.length).toBeLessThanOrEqual("Ritual 'x' failed (run r-3): ".length + 160)
  })

  test('empty/whitespace reason → no trailing colon', () => {
    expect(formatRitualFailureNotice({ ritual_id: 'x', status: 'failed', run_id: 'r', failure_reason: '   ' })).toBe(
      "Ritual 'x' failed (run r)",
    )
    expect(formatRitualFailureNotice({ ritual_id: 'x', status: 'failed', run_id: 'r', failure_reason: null })).toBe(
      "Ritual 'x' failed (run r)",
    )
  })

  test('completion fallback: one line with id + run id', () => {
    const s = formatRitualCompletionFallback({ ritual_id: 'morning-brief', run_id: 'r-9' })
    expect(s).toBe("Ritual 'morning-brief' finished (run r-9): no output.")
    expect(s).not.toContain('—')
  })

  test('escalation notice: one line naming 3 consecutive runs + run id', () => {
    const s = formatRitualEscalationNotice({ ritual_id: 'nightly', run_id: 'r-3' })
    expect(s).toContain('nightly')
    expect(s).toContain('r-3')
    expect(s).toMatch(/failed 3 consecutive runs/)
    expect(s).not.toContain('\n')
    expect(s).not.toContain('—')
  })

  test('boot-reap notice: one line, crashed + run id + restart phrasing', () => {
    const s = formatRitualBootReapNotice({ ritual_id: 'brief', run_id: 'r-5' })
    expect(s).toBe("Ritual 'brief' crashed (run r-5): the gateway restarted while it was running.")
    expect(s).not.toContain('—')
  })
})

describe('shouldEscalate truth table (rows newest-first)', () => {
  test('empty → false', () => {
    expect(shouldEscalate([])).toBe(false)
  })
  test('2 failures → false', () => {
    expect(shouldEscalate([row('failed'), row('timed_out')])).toBe(false)
  })
  test('exactly 3 failures (len 3) → true', () => {
    expect(shouldEscalate([row('failed'), row('timed_out'), row('crashed')])).toBe(true)
  })
  test('3 failures + 4th finished → true (streak crosses 3)', () => {
    expect(shouldEscalate([row('failed'), row('failed'), row('failed'), row('finished')])).toBe(true)
  })
  test('3 failures + 4th failed → false (already escalated last time)', () => {
    expect(shouldEscalate([row('failed'), row('failed'), row('failed'), row('failed')])).toBe(false)
  })
  test('mixed newest 3 (a success in the window) → false', () => {
    expect(shouldEscalate([row('failed'), row('finished'), row('failed')])).toBe(false)
    expect(shouldEscalate([row('finished'), row('failed'), row('failed')])).toBe(false)
  })
  test('an operator cancel in the window breaks the streak → false (Argus r1 minor)', () => {
    // 'cancelled' is terminal but not a merit failure — it must break a streak
    // exactly like a success, never count as one of the 3.
    expect(shouldEscalate([row('cancelled'), row('failed'), row('failed')])).toBe(false)
    expect(shouldEscalate([row('failed'), row('cancelled'), row('failed')])).toBe(false)
    // 3 real failures then a cancel as the 4th (older) row → a FRESH streak of
    // exactly 3 (the cancel broke the prior streak just like a success would), so
    // it escalates. Gating on `=== 'finished'` would wrongly suppress this and
    // never fire for the streak's entire life (Argus r2 blocker).
    expect(shouldEscalate([row('failed'), row('failed'), row('failed'), row('cancelled')])).toBe(true)
  })
})
