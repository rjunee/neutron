/**
 * channel-unbound-respawn.test.ts — the bounded channel-wedged respawn loop (port
 * row #6, cross-cutting invariant §6). Asserts: a clean retry recovers; the
 * wedge persisting past the cap fires EXACTLY ONE operator alert and stops
 * (capped at MAX_FLEET_RESPAWNS = 2, then alert-only — no infinite loop); and a
 * NON-wedged failure propagates immediately without a retry or an alert.
 */

import { describe, it, expect } from 'bun:test'
import {
  runBoundedChannelWedgeRespawn,
  MAX_FLEET_RESPAWNS,
  type ChannelWedgeAttemptResult,
} from '../channel-unbound-respawn.ts'

const wedged = (): ChannelWedgeAttemptResult<string> => ({
  ok: false,
  wedged: true,
  error: new Error('channel-wedged'),
})

describe('runBoundedChannelWedgeRespawn', () => {
  it('returns ok on the first clean attempt (no respawn, no alert)', async () => {
    let attempts = 0
    let alerts = 0
    const r = await runBoundedChannelWedgeRespawn<string>({
      attempt: async () => {
        attempts += 1
        return { ok: true, value: 'session' }
      },
      alert: () => {
        alerts += 1
      },
    })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.value).toBe('session')
      expect(r.respawns).toBe(0)
    }
    expect(attempts).toBe(1)
    expect(alerts).toBe(0)
  })

  it('recovers when a respawn clears the wedge', async () => {
    let alerts = 0
    const r = await runBoundedChannelWedgeRespawn<string>({
      attempt: async (n) => (n === 0 ? wedged() : { ok: true, value: 'session' }),
      alert: () => {
        alerts += 1
      },
    })
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.respawns).toBe(1)
    expect(alerts).toBe(0)
  })

  it('caps at 2 respawns then alerts exactly once (alert-only, no infinite loop)', async () => {
    const attemptNs: number[] = []
    let alerts = 0
    const r = await runBoundedChannelWedgeRespawn<string>({
      attempt: async (n) => {
        attemptNs.push(n)
        return wedged() // always wedged
      },
      alert: () => {
        alerts += 1
      },
    })
    expect(r.kind).toBe('capped')
    if (r.kind === 'capped') expect(r.respawns).toBe(MAX_FLEET_RESPAWNS)
    // Initial (0) + 2 respawns (1, 2) = 3 attempts, then stop — NOT unbounded.
    expect(attemptNs).toEqual([0, 1, 2])
    expect(alerts).toBe(1)
  })

  it('propagates a NON-wedged failure immediately — no retry, no alert', async () => {
    const err = new Error('dead-child')
    let attempts = 0
    let alerts = 0
    const r = await runBoundedChannelWedgeRespawn<string>({
      attempt: async () => {
        attempts += 1
        return { ok: false, wedged: false, error: err }
      },
      alert: () => {
        alerts += 1
      },
    })
    expect(r.kind).toBe('failed')
    if (r.kind === 'failed') expect(r.error).toBe(err)
    expect(attempts).toBe(1)
    expect(alerts).toBe(0)
  })
})
