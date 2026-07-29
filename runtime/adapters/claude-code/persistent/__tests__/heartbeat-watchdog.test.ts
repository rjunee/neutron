/**
 * heartbeat-watchdog.test.ts — ported from Nova `gateway/heartbeat-watchdog.test.ts`
 * (S2 § 6 acceptance #5). Boot touch, the utimes-FIRST ordering invariant (a
 * blocked loop still misses the heartbeat), write-once error, ENOENT creation,
 * and event-loop block detection. Fully DI-driven — no real clock waits.
 */

import { describe, it, expect } from 'bun:test'
import { startHeartbeatWatchdog, touchHeartbeatFile } from '../heartbeat-watchdog.ts'

describe('touchHeartbeatFile', () => {
  it('creates the file on ENOENT then retries the touch', () => {
    const touched: string[] = []
    let created = false
    let calls = 0
    touchHeartbeatFile('/x/.heartbeat', {
      utimes: (p) => {
        calls += 1
        if (calls === 1 && !created) {
          const err = new Error('nope') as Error & { code?: string }
          err.code = 'ENOENT'
          throw err
        }
        touched.push(p)
      },
      createIfMissing: () => {
        created = true
      },
    })
    expect(created).toBe(true)
    expect(touched).toEqual(['/x/.heartbeat'])
  })
})

describe('startHeartbeatWatchdog', () => {
  function harness() {
    let tickCb: (() => void) | undefined
    const touched: number[] = []
    let now = 0n
    const blocks: number[] = []
    const wd = startHeartbeatWatchdog({
      heartbeatFile: '/x/.heartbeat',
      intervalMs: 100,
      blockWarnMs: 500,
      setIntervalFn: (cb) => {
        tickCb = cb
        return 1
      },
      clearIntervalFn: () => {},
      nowNs: () => now,
      utimes: () => touched.push(Number(now)),
      createIfMissing: () => {},
      onBlock: (ms) => blocks.push(ms),
    })
    return {
      wd,
      tick: () => tickCb?.(),
      advance: (ms: number) => {
        now += BigInt(ms) * 1_000_000n
      },
      touched,
      blocks,
    }
  }

  it('primes the file at boot (one touch before any tick)', () => {
    const h = harness()
    expect(h.touched.length).toBe(1)
    h.wd.stop()
  })

  it('touches every tick', () => {
    const h = harness()
    h.advance(100)
    h.tick()
    h.advance(100)
    h.tick()
    expect(h.touched.length).toBe(3) // boot + 2 ticks
    h.wd.stop()
  })

  it('detects an event-loop block when tick-to-tick exceeds blockWarnMs', () => {
    const h = harness()
    h.advance(50)
    h.tick() // 50ms — under threshold
    expect(h.blocks.length).toBe(0)
    h.advance(900)
    h.tick() // 900ms — block
    expect(h.blocks.length).toBe(1)
    expect(h.blocks[0]).toBeGreaterThan(500)
    h.wd.stop()
  })

  it('utimes runs FIRST: a throwing onBlock still recorded the touch', () => {
    let tickCb: (() => void) | undefined
    let now = 0n
    const touched: number[] = []
    const wd = startHeartbeatWatchdog({
      heartbeatFile: '/x/.heartbeat',
      blockWarnMs: 100,
      setIntervalFn: (cb) => {
        tickCb = cb
        return 1
      },
      nowNs: () => now,
      utimes: () => touched.push(Number(now)),
      createIfMissing: () => {},
      onBlock: () => {
        throw new Error('block handler boom')
      },
    })
    const before = touched.length
    now += 999n * 1_000_000n
    expect(() => tickCb?.()).not.toThrow() // a throwing onBlock never escapes the tick
    expect(touched.length).toBe(before + 1) // the touch landed BEFORE onBlock threw
    wd.stop()
  })

  it('logs a write error only once (no 10×/s spam)', () => {
    let tickCb: (() => void) | undefined
    let now = 0n
    let errs = 0
    const wd = startHeartbeatWatchdog({
      heartbeatFile: '/x/.heartbeat',
      setIntervalFn: (cb) => {
        tickCb = cb
        return 1
      },
      nowNs: () => now,
      utimes: () => {
        throw new Error('EIO')
      },
      createIfMissing: () => {},
      onWriteError: () => {
        errs += 1
      },
    })
    // boot touch failed (1), then several ticks all fail but only log once more.
    now += 100n * 1_000_000n
    tickCb?.()
    now += 100n * 1_000_000n
    tickCb?.()
    expect(errs).toBe(2) // boot + first tick; subsequent swallowed
    wd.stop()
  })

  it('stop is idempotent', () => {
    const h = harness()
    h.wd.stop()
    expect(() => h.wd.stop()).not.toThrow()
  })
})
