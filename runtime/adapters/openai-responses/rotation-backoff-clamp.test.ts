/**
 * A FINITE RETRY-AFTER ABOVE `0x7fff_ffff` ms MUST STILL PRODUCE A REAL WAIT.
 *
 * `positiveMs` (responses-stream.ts) rejects non-finite and non-positive hints but has
 * NO upper bound, so a finite `retry-after: 3000000` (~34 days) passes through intact
 * and reaches this adapter's own rotation back-off — `rotateDelay` → `await sleep(...)`
 * → `setTimeout`. Above `0x7fff_ffff` a `setTimeout` delay does not saturate, it
 * OVERFLOWS the 32-bit signed field and fires almost immediately, so the adapter
 * answered a provider's "wait weeks" with an instant retry: a HOT RETRY LOOP, the exact
 * opposite of the instruction and worse than having no retry-after handling at all.
 *
 * WHY THIS SURVIVED THE ROUNDS THAT HARDENED THE SAME FIELD: the credential pool's park
 * IS bounded (`MAX_PARK_MS`, 6 h), and the producer WAS guarded. But the field has TWO
 * consumers, and this one — the adapter's own sleep — never consults the pool. Guarding
 * the producer and bounding one consumer both looked complete while a second consumer
 * read the raw value.
 *
 * WHY THE TIMER IS STUBBED rather than awaited: `collect()` walks the generator through
 * `await sleep(rotateDelay)` for real — the sibling `exhaustion-classification.test.ts`
 * takes 4.6 s precisely because its `retry-after: 4` is a genuine 4-second sleep. A
 * correctly-clamped 24.8-day delay can therefore never be awaited in CI. So these tests
 * assert on the delay the timer is ARMED WITH, which is the load-bearing value, and
 * `describe('the 32-bit boundary is real in this runtime')` below independently proves
 * what the two sides of that boundary actually do.
 */

import { describe, expect, test } from 'bun:test'

import { clampTimerDelayMs, createGptResponsesApiSubstrate, MAX_TIMER_DELAY_MS } from './index.ts'
import type { Event } from '../../events.ts'

/** Always-429 fetch carrying a `retry-after` in SECONDS. */
function http429Fetch(retryAfterSec: number | string): typeof fetch {
  return (async () =>
    new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': String(retryAfterSec) },
    })) as unknown as typeof fetch
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of events) out.push(e)
  return out
}

/**
 * Drive a real two-model rotation with the timer replaced by a recorder that fires
 * immediately, and return every delay the adapter armed a timer with plus the terminal
 * error event. Nothing here waits: without the stub, a clamped delay would hang for
 * 24.8 days.
 */
async function armedDelaysFor(
  retryAfterSec: number | string,
): Promise<{ delays: number[]; err: Event | undefined }> {
  const realSetTimeout = globalThis.setTimeout
  const delays: number[] = []
  ;(globalThis as { setTimeout: unknown }).setTimeout = ((
    cb: (...a: unknown[]) => void,
    ms?: number,
  ) => {
    delays.push(Number(ms))
    queueMicrotask(() => cb())
    return 0 as unknown as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  try {
    const gpt = createGptResponsesApiSubstrate({
      env: { OPENAI_API_KEY: 'sk' },
      substrate_instance_id: 'gpt-clamp',
      mcpResolver: async () => ({}),
      fetchImpl: http429Fetch(retryAfterSec),
    })
    const events = await collect(
      gpt.start({ prompt: 'hi', tools: [], model_preference: ['gpt-5.6', 'gpt-5.5'] }).events,
    )
    return { delays, err: events.find((e) => e.kind === 'error') }
  } finally {
    ;(globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout
  }
}

/** Does a timer armed with `ms` fire within `windowMs`? */
async function firesWithin(ms: number, windowMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(true), ms)
    setTimeout(() => {
      clearTimeout(t)
      resolve(false)
    }, windowMs)
  })
}

describe('the 32-bit boundary is real in this runtime', () => {
  // This block is the control for the whole file: it measures, rather than assumes,
  // that the two sides of `0x7fff_ffff` behave differently — so the clamp below is
  // fixing something and the assertions on armed delays mean what they claim.
  //
  // THE TWO WINDOWS ARE DELIBERATELY ASYMMETRIC. An overflowed timer is rearmed at
  // 1 ms, so proving it fires needs only a window long enough to survive a contended
  // CI event loop — generous, and it still returns in about a millisecond. Proving the
  // other two DON'T fire needs no generosity at all: those delays are 30 seconds and
  // 24.8 days, so any short window settles it, and a short one keeps the file fast.
  test('a delay ONE ms above the bound fires almost immediately (the defect)', async () => {
    expect(await firesWithin(MAX_TIMER_DELAY_MS + 1, 5_000)).toBe(true)
  })

  test('a delay AT the bound is a real wait — so the clamp target is a genuine back-off', async () => {
    expect(await firesWithin(MAX_TIMER_DELAY_MS, 150)).toBe(false)
  })

  test('an ordinary 30 s hint is also a real wait (nothing about this is special-cased)', async () => {
    expect(await firesWithin(30_000, 150)).toBe(false)
  })
})

describe('clampTimerDelayMs', () => {
  test('bounds a finite hint above the 32-bit ceiling', () => {
    expect(clampTimerDelayMs(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS)
    expect(clampTimerDelayMs(1e12)).toBe(MAX_TIMER_DELAY_MS)
  })

  test('leaves the bound itself and every ordinary delay EXACTLY alone', () => {
    // The control that proves the fix is a clamp and not a blanket cap.
    expect(clampTimerDelayMs(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS)
    expect(clampTimerDelayMs(30_000)).toBe(30_000)
    expect(clampTimerDelayMs(1)).toBe(1)
  })
})

describe("the adapter's rotation back-off is bounded end to end", () => {
  test('retry-after 3000000 s arms the timer at the ceiling, NOT at the overflowing value', async () => {
    const { delays } = await armedDelaysFor(3_000_000)
    // 3e6 s → 3e9 ms, comfortably past 0x7fff_ffff.
    expect(delays).toContain(MAX_TIMER_DELAY_MS)
    expect(delays).not.toContain(3_000_000_000)
    // Every armed delay is expressible — none can overflow into an instant retry.
    for (const d of delays) expect(d).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
  })

  test("the PRODUCER still reports the provider's raw hint — the pool keeps its own ceiling", async () => {
    // The property this fix deliberately preserves: only the adapter's timer is
    // clamped. `reportFailure` still receives the untouched number and applies
    // `MAX_PARK_MS` itself, so bounding one consumer did not rewrite the other's input.
    const { err } = await armedDelaysFor(3_000_000)
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.retry_after_ms).toBe(3_000_000_000)
  })

  test('an ordinary 30 s hint reaches the timer UNCHANGED', async () => {
    // The control that proves the end-to-end path did not simply cap everything.
    const { delays, err } = await armedDelaysFor(30)
    expect(delays).toContain(30_000)
    expect(delays).not.toContain(MAX_TIMER_DELAY_MS)
    if (err?.kind === 'error') expect(err.retry_after_ms).toBe(30_000)
  })
})

describe('the rejections this lane already hardened still hold', () => {
  // Guarding against a FALSE NEGATIVE in the guard: an upper bound must not turn a
  // hint that should be rejected outright into an accepted one.
  test('a NEGATIVE retry-after is still no hint at all, and arms no back-off', async () => {
    const { delays, err } = await armedDelaysFor(-30)
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.retry_after_ms).toBeUndefined()
    // `sleep` is only reached when the hint is defined and > 0.
    expect(delays).not.toContain(MAX_TIMER_DELAY_MS)
    expect(delays).toHaveLength(0)
  })

  test('a NON-FINITE retry-after is still no hint at all, and arms no back-off', async () => {
    // `1e308 * 1000` is `Infinity` — the value that used to reach `setTimeout` and
    // resolve in ~14 ms. It must be rejected, not clamped to the ceiling.
    const { delays, err } = await armedDelaysFor('1e308')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') expect(err.retry_after_ms).toBeUndefined()
    expect(delays).toHaveLength(0)
  })

  test('a SUB-MILLISECOND hint is still no hint at all (rounds to 0, not to the ceiling)', async () => {
    const { delays, err } = await armedDelaysFor(0.0001)
    if (err?.kind === 'error') expect(err.retry_after_ms).toBeUndefined()
    expect(delays).toHaveLength(0)
  })
})
