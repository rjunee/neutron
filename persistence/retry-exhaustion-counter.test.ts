/**
 * @neutronai/persistence — busy-retry exhaustion counter (F4).
 *
 * The `db_lock_contention` watchdog detector reads this monotonic count to spot
 * SQLite write-path starvation. It must increment ONCE per `withBusyRetry` that
 * burns its full budget, and NEVER on a success or a non-busy throw (so the
 * detector's delta reflects real contention, not ordinary errors).
 */

import { describe, expect, test } from 'bun:test'
import { BusyRetryExhaustedError } from './errors.ts'
import { busyRetryExhaustionCount, withBusyRetry } from './retry.ts'

describe('busyRetryExhaustionCount (F4)', () => {
  test('increments exactly once when a busy operation exhausts its retry budget', async () => {
    const before = busyRetryExhaustionCount()
    await expect(
      withBusyRetry(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      }),
    ).rejects.toBeInstanceOf(BusyRetryExhaustedError)
    expect(busyRetryExhaustionCount()).toBe(before + 1)
  }, 15_000)

  test('does NOT increment on success', async () => {
    const before = busyRetryExhaustionCount()
    const out = await withBusyRetry(() => 42)
    expect(out).toBe(42)
    expect(busyRetryExhaustionCount()).toBe(before)
  })

  test('does NOT increment on a non-busy error (propagates immediately)', async () => {
    const before = busyRetryExhaustionCount()
    await expect(
      withBusyRetry(() => {
        throw new Error('some unrelated failure')
      }),
    ).rejects.toThrow('some unrelated failure')
    expect(busyRetryExhaustionCount()).toBe(before)
  })
})
