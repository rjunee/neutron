import { describe, expect, test } from 'bun:test'

import { guardedFire, SupervisedLoop, type SupervisedLoopOptions } from './index.ts'

/** A promise plus its resolver, for driving a tick body that blocks until released. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Construct a loop that never arms a real timer, so tests drive `runOnce()`. */
function manualLoop(
  opts: Partial<SupervisedLoopOptions> & { tick: () => Promise<void> },
): SupervisedLoop {
  return new SupervisedLoop({
    name: 'test',
    intervalMs: 60_000,
    setTimer: () => 0,
    clearTimer: () => {},
    ...opts,
  })
}

describe('SupervisedLoop', () => {
  test('runOnce runs the tick body and counts a success', async () => {
    let ran = 0
    const loop = manualLoop({ tick: async () => void ran++ })
    const res = await loop.runOnce()
    expect(res).toEqual({ ran: true, skipped: false })
    expect(ran).toBe(1)
    expect(loop.stats().ticks).toBe(1)
    expect(loop.stats().failures).toBe(0)
  })

  test('single-flight: an overlapping runOnce is SKIPPED and counted', async () => {
    const gate = deferred()
    const loop = manualLoop({ tick: () => gate.promise })
    const t1 = loop.runOnce() // in-flight, blocked on the gate
    const t2 = await loop.runOnce() // fires while t1 runs → skipped
    expect(t2).toEqual({ ran: false, skipped: true })
    expect(loop.stats().skipped).toBe(1)
    gate.resolve()
    await t1
    expect(loop.stats().ticks).toBe(1)
  })

  test('catch-all: a throwing tick is caught, counted, and the loop keeps going', async () => {
    let calls = 0
    const errors: unknown[] = []
    const loop = manualLoop({
      onError: (_n, e) => errors.push(e),
      tick: async () => {
        calls++
        if (calls === 1) throw new Error('boom')
      },
    })
    const r1 = await loop.runOnce()
    expect(r1).toEqual({ ran: false, skipped: false })
    expect(loop.stats().failures).toBe(1)
    expect(loop.stats().consecutiveFailures).toBe(1)
    expect(errors).toHaveLength(1)
    // A later successful tick resets the streak and does not throw.
    const r2 = await loop.runOnce()
    expect(r2).toEqual({ ran: true, skipped: false })
    expect(loop.stats().ticks).toBe(1)
    expect(loop.stats().consecutiveFailures).toBe(0)
  })

  test('escalation fires at the consecutive-failure threshold, once per threshold', async () => {
    const escalations: number[] = []
    const loop = manualLoop({
      escalateThreshold: 3,
      onEscalate: (info) => escalations.push(info.consecutiveFailures),
      onError: () => {},
      tick: async () => {
        throw new Error('always')
      },
    })
    for (let i = 0; i < 3; i++) await loop.runOnce()
    expect(escalations).toEqual([3]) // fired once, AT the threshold
    for (let i = 0; i < 3; i++) await loop.runOnce()
    expect(escalations).toEqual([3, 6]) // and again one threshold later
    // A success resets the streak so the NEXT failure does not re-escalate.
    let boom = true
    const loop2 = manualLoop({
      escalateThreshold: 2,
      onEscalate: (info) => escalations.push(info.consecutiveFailures),
      onError: () => {},
      tick: async () => {
        if (boom) throw new Error('x')
      },
    })
    await loop2.runOnce() // fail 1
    boom = false
    await loop2.runOnce() // success resets
    boom = true
    await loop2.runOnce() // fail 1 again — below threshold, no escalation
    expect(escalations).toEqual([3, 6])
  })

  test('stop() quiesces: it awaits the in-flight tick before resolving', async () => {
    const gate = deferred()
    let finished = false
    const loop = manualLoop({
      tick: async () => {
        await gate.promise
        finished = true
      },
    })
    const t = loop.runOnce() // in-flight
    let stopped = false
    const stopP = loop.stop().then(() => {
      stopped = true
    })
    // stop() must NOT resolve while the tick is still in flight.
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(finished).toBe(false)
    gate.resolve()
    await stopP
    await t
    expect(stopped).toBe(true)
    expect(finished).toBe(true)
  })

  test('start() is idempotent and immediate fires exactly one boot tick', async () => {
    let armed = 0
    let ticks = 0
    const gate = deferred()
    const loop = new SupervisedLoop({
      name: 'boot',
      intervalMs: 60_000,
      immediate: true,
      setTimer: () => {
        armed++
        return armed
      },
      clearTimer: () => {},
      tick: async () => {
        ticks++
        await gate.promise
      },
    })
    loop.start()
    loop.start() // idempotent — no second timer, no second immediate tick
    expect(armed).toBe(1)
    expect(ticks).toBe(1)
    gate.resolve()
    await loop.stop()
  })

  test('stop() is safe with no in-flight tick and before start()', async () => {
    const loop = manualLoop({ tick: async () => {} })
    await loop.stop() // never started
    await loop.runOnce()
    await loop.stop() // no in-flight tick
    expect(loop.stats().ticks).toBe(1)
  })
})

describe('guardedFire', () => {
  test('resolves true on success', async () => {
    expect(await guardedFire('x', Promise.resolve(1))).toBe(true)
  })

  test('resolves false and routes the error on rejection — never rejects', async () => {
    const errs: unknown[] = []
    const ok = await guardedFire('x', Promise.reject(new Error('nope')), (_n, e) => errs.push(e))
    expect(ok).toBe(false)
    expect(errs).toHaveLength(1)
  })
})
