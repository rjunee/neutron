/**
 * KeyedMutex unit tests (2026-05-22, ISSUE #33).
 *
 * Pins the chained-promise semantics directly so the
 * admin-personality-surface-race test doesn't have to re-derive them.
 */

import { describe, expect, it } from 'bun:test'

import { createKeyedMutex } from '../keyed-mutex.ts'

describe('createKeyedMutex', () => {
  it('serializes acquires on the same key in FIFO order', async () => {
    const m = createKeyedMutex()
    const order: string[] = []

    // Start three acquires on the same key back-to-back. The chained
    // promise tail forces FIFO drain.
    const r1Promise = m.acquire('t1')
    const r2Promise = m.acquire('t1')
    const r3Promise = m.acquire('t1')

    const r1 = await r1Promise
    order.push('1-acquired')
    // r2 and r3 should be blocked until we release r1.
    const r2Settled = settled(r2Promise)
    const r3Settled = settled(r3Promise)
    await tick()
    expect(r2Settled.done).toBe(false)
    expect(r3Settled.done).toBe(false)

    r1()
    const r2 = await r2Promise
    order.push('2-acquired')
    await tick()
    expect(r3Settled.done).toBe(false)

    r2()
    const r3 = await r3Promise
    order.push('3-acquired')

    r3()
    expect(order).toEqual(['1-acquired', '2-acquired', '3-acquired'])
  })

  it('does NOT serialize acquires on different keys (cross-project parallelism)', async () => {
    const m = createKeyedMutex()

    // Hold key 'a' indefinitely. An acquire on key 'b' must NOT block.
    const releaseA = await m.acquire('a')
    const bAcquired = settled(m.acquire('b'))
    await tick()
    expect(bAcquired.done).toBe(true)
    if (bAcquired.done && bAcquired.value) bAcquired.value()
    releaseA()
  })

  it('drops the map entry once a key drains (no leak across many releases)', async () => {
    const m = createKeyedMutex()
    expect(m.activeKeys()).toBe(0)

    const r1 = await m.acquire('a')
    expect(m.activeKeys()).toBe(1)
    r1()
    // The drain happens synchronously inside release() — the next
    // microtask should already see activeKeys() === 0.
    await tick()
    expect(m.activeKeys()).toBe(0)

    // Quick burst — many sequential acquires on the same key drain
    // back to 0 between cycles.
    for (let i = 0; i < 5; i++) {
      const r = await m.acquire('a')
      r()
      await tick()
    }
    expect(m.activeKeys()).toBe(0)
  })

  it('keeps the map entry alive while later callers are queued', async () => {
    const m = createKeyedMutex()
    const r1 = await m.acquire('a')
    expect(m.activeKeys()).toBe(1)
    const r2Promise = m.acquire('a')
    await tick()
    // r1 still holds; r2 is queued — entry must still be in the map.
    expect(m.activeKeys()).toBe(1)
    r1()
    const r2 = await r2Promise
    expect(m.activeKeys()).toBe(1)
    r2()
    await tick()
    expect(m.activeKeys()).toBe(0)
  })

  it('release() is idempotent — calling twice does not free the next acquirer twice', async () => {
    const m = createKeyedMutex()
    const r1 = await m.acquire('a')
    const r2Promise = m.acquire('a')
    const r2Settled = settled(r2Promise)
    await tick()
    expect(r2Settled.done).toBe(false)
    r1()
    r1() // second release — should be a no-op
    const r2 = await r2Promise
    expect(r2Settled.done).toBe(true)
    r2()
    await tick()
    expect(m.activeKeys()).toBe(0)
  })

  it('withLock() runs fn under the lock and releases on success', async () => {
    const m = createKeyedMutex()
    let inside = false
    const result = await m.withLock('a', async () => {
      inside = true
      return 42
    })
    expect(inside).toBe(true)
    expect(result).toBe(42)
    await tick()
    expect(m.activeKeys()).toBe(0)
  })

  it('withLock() releases the lock when fn throws', async () => {
    const m = createKeyedMutex()
    await expect(
      m.withLock('a', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await tick()
    expect(m.activeKeys()).toBe(0)
    // After the throw the lock is free — a fresh acquire resolves
    // immediately.
    const r = await m.acquire('a')
    r()
  })

  it('withLock() serializes back-to-back work on the same key', async () => {
    const m = createKeyedMutex()
    const order: string[] = []
    const slow = m.withLock('a', async () => {
      await Bun.sleep(20)
      order.push('slow-done')
    })
    const fast = m.withLock('a', async () => {
      order.push('fast-done')
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(['slow-done', 'fast-done'])
  })
})

interface Settled<T> {
  done: boolean
  value: T | undefined
}

function settled<T>(p: Promise<T>): Settled<T> {
  const out: Settled<T> = { done: false, value: undefined }
  p.then((v) => {
    out.done = true
    out.value = v
  }).catch(() => {
    out.done = true
  })
  return out
}

async function tick(): Promise<void> {
  // A few microtask flushes — enough for chained `.then` callbacks
  // inside the mutex to settle without depending on wall-clock.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
