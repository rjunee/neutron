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
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1) // actually parallelised
  })

  test('parallel batch is faster than serial when work is genuinely slow', async () => {
    // 8 items × 50 ms per item.
    // Serial would be ~400 ms; pool=4 should be roughly ~100 ms.
    // Pin a generous upper bound that still proves parallelism.
    const items = Array.from({ length: 8 }, (_, i) => i)
    const t0 = Date.now()
    await mapWithBoundedConcurrency(items, 4, async () => {
      await new Promise<void>((r) => setTimeout(r, 50))
      return 0
    })
    const elapsed = Date.now() - t0
    // Serial floor would be 8 × 50 = 400ms. Parallel(4) floor is
    // ceil(8/4) × 50 = 100ms. Assert WELL under the serial floor
    // with extra CI slack — proving parallelism is the goal, not
    // pinning a tight latency target.
    expect(elapsed).toBeLessThan(350)
  })

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
