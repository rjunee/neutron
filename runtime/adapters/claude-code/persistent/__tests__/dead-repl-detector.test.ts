/**
 * dead-repl-detector.test.ts — ported from Nova `gateway/topic-wedge-detector.test.ts`.
 * Detection table (adapted to pooled-child + dev-channel `/health`) + the 6
 * ordered decision gates + alert dedupe. The pure cores lift verbatim.
 */

import { describe, it, expect } from 'bun:test'
import {
  buildWedgeAlertText,
  buildWedgeCapHitAlertText,
  buildWedgeRecoveryInProgressText,
  decideWedgeAction,
  detectReplWedged,
  type ReplWedgeProbe,
  type WedgeActionContext,
} from '../dead-repl-detector.ts'

const base: ReplWedgeProbe = { hasChild: true, childAlive: true, healthOk: true, ccReady: true }

describe('detectReplWedged — detection table', () => {
  it('pooled child exited → pid-dead (strongest signal, checked first)', () => {
    const v = detectReplWedged({ ...base, childAlive: false, healthOk: false })
    expect(v).toMatchObject({ wedged: true, reason: 'pid-dead' })
  })

  it('child alive but /health silent → no-port-listener', () => {
    const v = detectReplWedged({ ...base, healthOk: false })
    expect(v).toMatchObject({ wedged: true, reason: 'no-port-listener' })
  })

  it('child alive + /health ok → not wedged', () => {
    expect(detectReplWedged(base)).toEqual({ wedged: false })
  })

  it('no pooled child but /health ok → not wedged (health is positive)', () => {
    expect(detectReplWedged({ hasChild: false, childAlive: false, healthOk: true, ccReady: false })).toEqual({
      wedged: false,
    })
  })

  it('no pooled child, /health silent, ccReady → not wedged (ccReady positive)', () => {
    expect(detectReplWedged({ hasChild: false, childAlive: false, healthOk: false, ccReady: true })).toEqual({
      wedged: false,
    })
  })

  it('no pooled child, /health silent, never-ready → no-pid-no-listener', () => {
    const v = detectReplWedged({ hasChild: false, childAlive: false, healthOk: false, ccReady: false })
    expect(v).toMatchObject({ wedged: true, reason: 'no-pid-no-listener' })
  })
})

const ctxBase: WedgeActionContext = {
  verdict: { wedged: true, reason: 'pid-dead', detail: 'x' },
  firstReadyAt: 1_000,
  cappedAt: undefined,
  respawnInFlight: false,
  lastWedgeAutoRespawnAt: undefined,
  lastWedgeAlertAt: undefined,
  now: 1_000_000,
}

describe('decideWedgeAction — 6 ordered gates', () => {
  it('gate 1: not wedged → ignore(not-wedged)', () => {
    expect(decideWedgeAction({ ...ctxBase, verdict: { wedged: false } })).toEqual({
      kind: 'ignore',
      reason: 'not-wedged',
    })
  })

  it('gate 2: never ready → ignore(never-ready)', () => {
    expect(decideWedgeAction({ ...ctxBase, firstReadyAt: undefined })).toEqual({
      kind: 'ignore',
      reason: 'never-ready',
    })
  })

  it('gate 3: inside boot-grace → ignore(boot-window)', () => {
    expect(decideWedgeAction({ ...ctxBase, firstReadyAt: ctxBase.now - 1_000 })).toEqual({
      kind: 'ignore',
      reason: 'boot-window',
    })
  })

  it('gate 4: cap tripped → cap-hit-alert (auto-recovery OFF)', () => {
    const a = decideWedgeAction({ ...ctxBase, cappedAt: 500 })
    expect(a.kind).toBe('cap-hit-alert')
  })

  it('gate 5a: respawn in-flight → alert-only', () => {
    const a = decideWedgeAction({ ...ctxBase, respawnInFlight: true })
    expect(a.kind).toBe('alert-only')
  })

  it('gate 5b: cooldown active → alert-only', () => {
    const a = decideWedgeAction({ ...ctxBase, lastWedgeAutoRespawnAt: ctxBase.now - 5_000 })
    expect(a.kind).toBe('alert-only')
  })

  it('gate 6: wedged, past grace, no cap/in-flight/cooldown → respawn-and-alert', () => {
    const a = decideWedgeAction(ctxBase)
    expect(a.kind).toBe('respawn-and-alert')
  })
})

describe('decideWedgeAction — alert dedupe', () => {
  it('suppresses the alert inside the dedupe window but still respawns', () => {
    const a = decideWedgeAction({ ...ctxBase, lastWedgeAlertAt: ctxBase.now - 5_000 })
    expect(a.kind).toBe('respawn-and-alert')
    if (a.kind === 'respawn-and-alert') expect(a.alert).toEqual({ send: false, reason: 'deduped' })
  })

  it('sends the alert once the dedupe window has passed', () => {
    const a = decideWedgeAction({ ...ctxBase, lastWedgeAlertAt: ctxBase.now - 60_000 })
    if (a.kind === 'respawn-and-alert') expect(a.alert).toEqual({ send: true })
  })
})

describe('alert-text builders — recovery URL escapes the sessionKey (Codex GPT-5 r4 IMPORTANT)', () => {
  // A real pool key is `${instance_id}\0${cwd}` — it contains a NUL byte and path
  // chars, so a raw `?session=<key>` query is invalid exactly when a wedge/cap
  // alert fires. The operator-recovery URL must encodeURIComponent the key so it
  // round-trips back to the original.
  const sessionKey = 'cc-import-abc123\x00/srv/neutron/projects/foo bar/code'

  /** Pull the `session=` query value out of the `?session=...` in the alert text. */
  const extractSessionParam = (text: string): string => {
    const m = text.match(/\?session=([^`]+)`/)
    expect(m).not.toBeNull()
    const param = m?.[1]
    expect(param).toBeDefined()
    return param as string
  }

  it('buildWedgeAlertText URL round-trips to the original sessionKey', () => {
    const text = buildWedgeAlertText({ sessionKey, reason: 'pid-dead' })
    const param = extractSessionParam(text)
    expect(param).not.toContain('\x00') // encoded, not raw
    expect(param).not.toContain(' ')
    expect(decodeURIComponent(param)).toBe(sessionKey)
  })

  it('buildWedgeCapHitAlertText URL round-trips to the original sessionKey', () => {
    const text = buildWedgeCapHitAlertText({ sessionKey, reason: 'no-port-listener' })
    const param = extractSessionParam(text)
    expect(param).not.toContain('\x00')
    expect(decodeURIComponent(param)).toBe(sessionKey)
  })

  it('buildWedgeRecoveryInProgressText URL round-trips to the original sessionKey', () => {
    const text = buildWedgeRecoveryInProgressText({ sessionKey })
    const param = extractSessionParam(text)
    expect(param).not.toContain('\x00')
    expect(decodeURIComponent(param)).toBe(sessionKey)
  })
})
