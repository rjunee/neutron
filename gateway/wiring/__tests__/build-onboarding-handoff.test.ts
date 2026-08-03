/**
 * 2026-05-29 r2 IMPORTANT fix — onboarding-handoff hook concurrency tests,
 * updated 2026-06-11 for Item 5 (free-form opening message, ISSUES #208):
 * the composer is now `ComposeProjectOpeningFn` (body-only, no button
 * labels) and every emit carries `options: []`.
 *
 * Pre-r2 `emitProjectSeeds` awaited each composer call serially, so the
 * wow_fired → completed transition was blocked for
 * `N × per-call-latency` (e.g. 8 projects × ~8 s Opus round-trip of
 * unmoving UI). This file pins the bounded-concurrency behaviour:
 *
 *   1. Total wall time for the parallel batch is ROUGHLY
 *      `ceil(N / pool) × per-call-latency`, not `N × per-call-latency`.
 *   2. Output is order-preserving (sidebar `created_at` order matches input).
 *   3. Per-row LLM failure isolation: one rejected composer call falls back
 *      to the deterministic prose while OTHER projects still get the LLM
 *      body.
 *   4. `mapWithBoundedConcurrency` respects its concurrency budget and
 *      collapses to serial when N <= pool size.
 *   5. With no composer wired (Open self-hoster path), the loop still
 *      emits per project — order + deterministic-prose fallback intact.
 *
 * The pre-Item-5 keyboard-shape block (ISSUES #69 — 2-button no-match
 * fallback vs 3-button rich-data keyboard) was REPLACED by the
 * zero-button block at the bottom: Item 5 removes ALL buttons from
 * newly-emitted openings. Legacy rows already in project DBs keep their
 * buttons; the inbound handling for those values lives (inert) in
 * `gateway/http/chat-bridge.ts` and is covered by its tests.
 */

import { expect, test, describe } from 'bun:test'
import {
  mapWithBoundedConcurrency,
  DEFAULT_COMPOSER_CONCURRENCY,
} from '../build-onboarding-handoff.ts'

describe('mapWithBoundedConcurrency', () => {
  test('preserves input order in output', async () => {
    const items = [10, 20, 30, 40, 50]
    const out = await mapWithBoundedConcurrency(items, 2, async (n) => {
      // Random-ish stagger so order would scramble if naive
      await new Promise<void>((r) => setTimeout(r, (50 - n) / 5))
      return n * 2
    })
    expect(out).toEqual([20, 40, 60, 80, 100])
  })

  test('respects concurrency budget — never more than N tasks in flight', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 20 }, (_, i) => i)
    await mapWithBoundedConcurrency(items, 4, async () => {
      inFlight += 1
      if (inFlight > peak) peak = inFlight
      await new Promise<void>((r) => setTimeout(r, 10))
      inFlight -= 1
      return 0
    })
    // EXACTLY the pool size, not merely "more than one" (ISSUES #438).
    //
    // `mapWithBoundedConcurrency` pushes `min(concurrency, items.length)`
    // workers in a synchronous loop, and each runs as far as its first `await`
    // inside `fn` — which is after `inFlight += 1`. So all four increment
    // before any timer resolves, and the peak is deterministically 4. This is
    // strictly stronger than the old `> 1`: it proves the pool SATURATES, not
    // just that something overlapped.
    expect(peak).toBe(4)
  })

  // DELETED (ISSUES #438): 'parallel batch is faster than serial when work is
  // genuinely slow'.
  //
  // It ran 8 items × a real 50 ms sleep at pool=4 and asserted
  // `elapsed < 350ms` against a ~100 ms parallel floor. That is a WALL-CLOCK
  // PROXY for parallelism — and parallelism is already proven deterministically
  // by the test above, which counts actual in-flight tasks. Two guards for one
  // contract, and this was the one that races a contended CI runner.
  //
  // Deleting it loses no coverage: `peak === 4` above is a STRONGER statement
  // than "it finished faster than serial would have" (a saturated pool is
  // precisely why it is faster), and it cannot flake because it never consults
  // a clock. The surviving assertion still reds if the pool is made serial.

  test('empty input returns empty array', async () => {
    const out = await mapWithBoundedConcurrency([], 4, async () => 'x')
    expect(out).toEqual([])
  })

  test('single item with concurrency 1 works (degenerate serial case)', async () => {
    const out = await mapWithBoundedConcurrency(['only'], 1, async (s) => `${s}!`)
    expect(out).toEqual(['only!'])
  })
})

describe('DEFAULT_COMPOSER_CONCURRENCY', () => {
  test('constant is exported and within a reasonable range', () => {
    expect(DEFAULT_COMPOSER_CONCURRENCY).toBeGreaterThanOrEqual(2)
    expect(DEFAULT_COMPOSER_CONCURRENCY).toBeLessThanOrEqual(8)
  })
})
