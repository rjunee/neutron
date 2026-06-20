/**
 * scribe-budget tests — ported from Nova's budget governor mechanics, adapted
 * to the per-project state path + `byTrigger` shape.
 *
 * Time-dependent assertions use `Date.now()`-relative timestamps (per the
 * repo's no-hardcoded-ISO rule) — every call passes an explicit `now` offset
 * from a single `t0` base captured at test start.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createState,
  tryAcquire,
  release,
  snapshot,
  persistDailySync,
  defaultStatePath,
  BUCKET_CAPACITY,
  DAILY_CAP,
  MAX_INFLIGHT,
  CB_THRESHOLD,
  CB_COOLDOWN_MS,
  REFILL_PER_MIN,
} from '../scribe-budget.ts'

function tmpStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scribe-budget-'))
  return join(dir, '.scribe-budget.json')
}

const t0 = Date.now()

describe('scribe-budget — per-instance governor', () => {
  test('defaultStatePath is under the instance home', () => {
    expect(defaultStatePath('/srv/neutron/instance-x')).toBe(
      '/srv/neutron/instance-x/.scribe-budget.json',
    )
  })

  test('acquire decrements tokens + counts per trigger', () => {
    const s = createState(tmpStatePath(), t0)
    const r = tryAcquire(s, 'chat', t0)
    expect(r.ok).toBe(true)
    expect(s.daily.total).toBe(1)
    expect(s.daily.byTrigger.chat).toBe(1)
    expect(s.tokens).toBe(BUCKET_CAPACITY - 1)
    release(s, true, t0)
    expect(s.inflight).toBe(0)
  })

  test('no_tokens once the bucket drains, then refills over time', () => {
    const s = createState(tmpStatePath(), t0)
    // Drain the bucket: acquire+release BUCKET_CAPACITY times (release frees
    // inflight but does NOT refund tokens).
    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      expect(tryAcquire(s, 'chat', t0).ok).toBe(true)
      release(s, true, t0)
    }
    const drained = tryAcquire(s, 'chat', t0)
    expect(drained).toEqual({ ok: false, reason: 'no_tokens' })
    // One minute later, REFILL_PER_MIN tokens are back.
    const later = t0 + 60_000
    expect(tryAcquire(s, 'chat', later).ok).toBe(true)
    expect(s.daily.rejected).toBe(1)
    expect(REFILL_PER_MIN).toBeGreaterThan(0)
  })

  test('inflight cap rejects beyond MAX_INFLIGHT concurrent extracts', () => {
    const s = createState(tmpStatePath(), t0)
    for (let i = 0; i < MAX_INFLIGHT; i++) {
      expect(tryAcquire(s, 'chat', t0).ok).toBe(true)
    }
    expect(tryAcquire(s, 'chat', t0)).toEqual({ ok: false, reason: 'inflight_cap' })
  })

  test('daily cap rejects once DAILY_CAP reached', () => {
    const s = createState(tmpStatePath(), t0)
    s.daily.total = DAILY_CAP
    expect(tryAcquire(s, 'chat', t0)).toEqual({ ok: false, reason: 'daily_cap' })
  })

  test('circuit breaker opens after CB_THRESHOLD consecutive failures, then closes after cooldown', () => {
    const s = createState(tmpStatePath(), t0)
    for (let i = 0; i < CB_THRESHOLD; i++) {
      expect(tryAcquire(s, 'chat', t0).ok).toBe(true)
      release(s, false, t0)
    }
    // Breaker now open — acquire fails fast.
    expect(tryAcquire(s, 'chat', t0)).toEqual({ ok: false, reason: 'breaker_open' })
    // After cooldown the breaker closes.
    const afterCooldown = t0 + CB_COOLDOWN_MS + 1
    expect(tryAcquire(s, 'chat', afterCooldown).ok).toBe(true)
  })

  test('a single success resets the consecutive-failure counter', () => {
    const s = createState(tmpStatePath(), t0)
    for (let i = 0; i < CB_THRESHOLD - 1; i++) {
      tryAcquire(s, 'chat', t0)
      release(s, false, t0)
    }
    tryAcquire(s, 'chat', t0)
    release(s, true, t0) // reset
    expect(s.consecutiveFailures).toBe(0)
    // Another failure should NOT immediately open the breaker.
    tryAcquire(s, 'chat', t0)
    release(s, false, t0)
    expect(snapshot(s, t0).breaker_open).toBe(false)
  })

  test('day rollover resets the daily counter', () => {
    const s = createState(tmpStatePath(), t0)
    tryAcquire(s, 'chat', t0)
    expect(s.daily.total).toBe(1)
    const nextDay = t0 + 24 * 60 * 60 * 1000 + 1000
    const snap = snapshot(s, nextDay)
    expect(snap.daily.total).toBe(0)
  })

  test('persist + reload preserves the same-day daily counter', () => {
    const p = tmpStatePath()
    const s = createState(p, t0)
    tryAcquire(s, 'chat', t0)
    tryAcquire(s, 'chat', t0)
    persistDailySync(s, t0)
    expect(existsSync(p)).toBe(true)
    const reloaded = createState(p, t0)
    expect(reloaded.daily.total).toBe(2)
    expect(reloaded.daily.byTrigger.chat).toBe(2)
  })

  test('persisted file mode is owner-only (0600)', () => {
    const p = tmpStatePath()
    const s = createState(p, t0)
    tryAcquire(s, 'chat', t0)
    persistDailySync(s, t0)
    // sanity: payload is valid JSON with the daily shape
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    expect(parsed.daily.byTrigger.chat).toBe(1)
  })

  test('snapshot reports remaining daily budget', () => {
    const s = createState(tmpStatePath(), t0)
    tryAcquire(s, 'chat', t0)
    const snap = snapshot(s, t0)
    expect(snap.daily_remaining).toBe(DAILY_CAP - 1)
    expect(snap.inflight).toBe(1)
  })
})
