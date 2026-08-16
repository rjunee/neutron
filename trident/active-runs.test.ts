/**
 * The live-build COUNT that divides this box's test budget — behavioural.
 *
 * Round 3 shipped this rule as a closure inside the gateway composer, covered only by
 * assertions on the composer's SOURCE TEXT: they proved the line existed and never once
 * exercised the number it produces. The rule moved to `trident/active-runs.ts` so it can
 * be driven with real rows, which is what this file does.
 */
import { describe, expect, it } from 'bun:test'

import { ACTIVE_BUILD_RUN_SCAN_LIMIT, countActiveBuildRuns } from './active-runs.ts'

/** A store whose only job is to hand back the rows a case is about. */
function storeOf(phases: readonly string[]): { listNonTerminal(limit: number): { phase: string }[] } {
  return {
    listNonTerminal(limit: number) {
      return phases.slice(0, limit).map((phase) => ({ phase }))
    },
  }
}

describe('countActiveBuildRuns', () => {
  it('counts nothing on an idle instance', () => {
    expect(countActiveBuildRuns(storeOf([]))).toBe(0)
  })

  it("counts the single launching build — its own row is IN the count", () => {
    // The divisor is "builds sharing these cores", and the one asking is one of them.
    expect(countActiveBuildRuns(storeOf(['forge-init']))).toBe(1)
  })

  it("counts four concurrent builds — the card's worked example", () => {
    expect(countActiveBuildRuns(storeOf(['forge-init', 'forge-fix', 'forge-init', 'forge-fix']))).toBe(4)
  })

  it('does NOT count runs parked in planning, review or delivery', () => {
    // These burn tokens, not cores. Counting them would raise the divisor and starve the
    // build that IS running a suite.
    const parked = ['ralph-plan', 'ralph-task', 'argus', 'publishing', 'delivering', 'merged', 'failed']
    expect(countActiveBuildRuns(storeOf(parked))).toBe(0)
    expect(countActiveBuildRuns(storeOf([...parked, 'forge-init']))).toBe(1)
  })

  it('reads a generous number of rows — a clipped scan would pin every budget at its floor', () => {
    expect(ACTIVE_BUILD_RUN_SCAN_LIMIT).toBe(200)
    const many = Array.from({ length: 500 }, () => 'forge-init')
    expect(countActiveBuildRuns(storeOf(many))).toBe(ACTIVE_BUILD_RUN_SCAN_LIMIT)
  })

  it('propagates a store failure to the orchestrator, which is where the fallback lives', () => {
    // Deliberately NOT swallowed here: `orchestrator.launch()` catches it and falls back
    // to `active = 1`, which still divides by the constant fan-out. Catching it in two
    // places would mean neither obviously owns the degradation.
    const broken = {
      listNonTerminal(): { phase: string }[] {
        throw new Error('database is locked')
      },
    }
    expect(() => countActiveBuildRuns(broken)).toThrow('database is locked')
  })

  it('the over-count is real and its direction is SAFE — a parked pr-mode run still counts', () => {
    // A pr-mode run stays `forge-init` through publish and review, so this reads high.
    // High means a LARGER divisor, i.e. FEWER jobs — toward the runner's own sequential
    // default, never toward oversubscription. The budget is documented as bounding the
    // aggregate, and an over-count cannot break that bound.
    const oneBuildingSixParkedInPublish = Array.from({ length: 7 }, () => 'forge-init')
    expect(countActiveBuildRuns(storeOf(oneBuildingSixParkedInPublish))).toBe(7)
  })
})
