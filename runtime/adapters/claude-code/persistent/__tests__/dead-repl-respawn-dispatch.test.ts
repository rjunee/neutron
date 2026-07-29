/**
 * dead-repl-respawn-dispatch.test.ts — ported VERBATIM from Nova
 * `gateway/wedge-respawn-dispatch.test.ts`. The load-bearing contract:
 * `markInFlight` fires EXACTLY when plan.ok && execute.ok; every refusal/throw
 * path leaves it untouched so the next tick can retry.
 */

import { describe, it, expect } from 'bun:test'
import { dispatchWedgeRespawn } from '../dead-repl-respawn-dispatch.ts'

describe('dispatchWedgeRespawn', () => {
  it('fires execute + markInFlight when plan and execute both ok', () => {
    let marked = 0
    let executed = 0
    const out = dispatchWedgeRespawn({
      plan: () => ({ ok: true }),
      execute: () => {
        executed += 1
        return { ok: true }
      },
      markInFlight: () => {
        marked += 1
      },
    })
    expect(out).toEqual({ kind: 'fired' })
    expect(executed).toBe(1)
    expect(marked).toBe(1)
  })

  it('plan-refused: never executes, never marks in-flight', () => {
    let executed = 0
    let marked = 0
    const out = dispatchWedgeRespawn({
      plan: () => ({ ok: false, reason: 'no-session-to-resume' }),
      execute: () => {
        executed += 1
        return { ok: true }
      },
      markInFlight: () => {
        marked += 1
      },
    })
    expect(out).toEqual({ kind: 'plan-refused', reason: 'no-session-to-resume' })
    expect(executed).toBe(0)
    expect(marked).toBe(0)
  })

  it('execute-refused: does NOT mark in-flight (the retry path stays open)', () => {
    let marked = 0
    const out = dispatchWedgeRespawn({
      plan: () => ({ ok: true }),
      execute: () => ({ ok: false, reason: 'spawn-failed' }),
      markInFlight: () => {
        marked += 1
      },
    })
    expect(out).toEqual({ kind: 'execute-refused', reason: 'spawn-failed' })
    expect(marked).toBe(0)
  })

  it('threw (from plan): captured as kind:threw, no mark', () => {
    let marked = 0
    const boom = new Error('plan boom')
    const out = dispatchWedgeRespawn({
      plan: () => {
        throw boom
      },
      execute: () => ({ ok: true }),
      markInFlight: () => {
        marked += 1
      },
    })
    expect(out.kind).toBe('threw')
    if (out.kind === 'threw') expect(out.error).toBe(boom)
    expect(marked).toBe(0)
  })

  it('threw (from execute): captured as kind:threw, no mark', () => {
    let marked = 0
    const boom = new Error('execute boom')
    const out = dispatchWedgeRespawn({
      plan: () => ({ ok: true }),
      execute: () => {
        throw boom
      },
      markInFlight: () => {
        marked += 1
      },
    })
    expect(out.kind).toBe('threw')
    if (out.kind === 'threw') expect(out.error).toBe(boom)
    expect(marked).toBe(0)
  })

  it('refusal reasons default to "unknown" when absent', () => {
    expect(dispatchWedgeRespawn({ plan: () => ({ ok: false }), execute: () => ({ ok: true }), markInFlight: () => {} })).toEqual({
      kind: 'plan-refused',
      reason: 'unknown',
    })
    expect(dispatchWedgeRespawn({ plan: () => ({ ok: true }), execute: () => ({ ok: false }), markInFlight: () => {} })).toEqual({
      kind: 'execute-refused',
      reason: 'unknown',
    })
  })
})
