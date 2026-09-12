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
    expect(v).toMatchObject({ wedged: true, reason: 'pid-dead', detail: 'pooled child exited' })
  })

  // ─── #518: a deploy is not a crash, and the pair below is what says so ───────

  it('child exited AND the registry says a gateway shutdown killed it → pid-dead-gateway-shutdown', () => {
    // RED-mutation: delete the `killedByGatewayShutdown` branch. The verdict falls
    // back to `pid-dead` / "pooled child exited" and the deploy is reported as a
    // crash — the defect the spec item names.
    const v = detectReplWedged({ ...base, childAlive: false, healthOk: false, shutdownObserved: 'alive-and-killed' as const })
    expect(v).toMatchObject({ wedged: true, reason: 'pid-dead-gateway-shutdown' })
    expect(v).toMatchObject({ wedged: true })
    if (v.wedged) {
      expect(v.detail).toContain('deploy')
      expect(v.detail).not.toContain('pooled child exited')
    }
  })

  it('THE COMPLEMENT — child exited with NO shutdown marker stays pid-dead / "pooled child exited"', () => {
    // A change that reported EVERY death as a deploy would satisfy the case above and
    // be worthless. This is the case that makes it mean something, and it is the
    // acceptance criterion stated negatively: the 08-10 23:30 and 08-11 06:04 crashes
    // have no checkout near them and must NOT be attributed to a deploy.
    //
    // RED-mutation: make the branch unconditional (`if (true)`) — this reddens while
    // the deploy case above still passes.
    const notReached = detectReplWedged({ ...base, childAlive: false, healthOk: false })
    expect(notReached).toMatchObject({ wedged: true, reason: 'pid-dead', detail: 'pooled child exited' })
    // ABSENT, not merely false: a probe built before #518 (or one whose registry read
    // could not answer) must land on the crash arm, never the deploy arm.
    const fieldAbsent = detectReplWedged({ ...base, childAlive: false, healthOk: false })
    expect(fieldAbsent).toMatchObject({ wedged: true, reason: 'pid-dead', detail: 'pooled child exited' })
  })

  it('child exited and the shutdown reached it WITHOUT killing it → pid-dead-cause-undetermined', () => {
    // THE THIRD STATE. Two values could not hold three, so `undetermined` shared
    // `pid-dead` with an ordinary crash and the retry reported a fault nobody observed.
    // RED-mutation: delete this arm — the verdict falls back to `pid-dead` /
    // "pooled child exited", and the deploy case above still passes.
    for (const observed of ['already-gone', 'could-not-sample'] as const) {
      const v = detectReplWedged({ ...base, childAlive: false, healthOk: false, shutdownObserved: observed })
      expect(v).toMatchObject({ wedged: true, reason: 'pid-dead-cause-undetermined' })
      if (v.wedged) {
        expect(v.detail).toContain('UNDETERMINED')
        // Neither confident sentence is available for this state.
        expect(v.detail).not.toContain('a service restart or a deploy')
        expect(v.detail).not.toBe('pooled child exited')
      }
    }
    // The two sub-states say WHICH: an observation is not a failure to observe.
    const gone = detectReplWedged({ ...base, childAlive: false, healthOk: false, shutdownObserved: 'already-gone' })
    const blind = detectReplWedged({
      ...base,
      childAlive: false,
      healthOk: false,
      shutdownObserved: 'could-not-sample',
    })
    expect(gone.wedged && blind.wedged && gone.detail !== blind.detail).toBe(true)
    expect(buildWedgeAlertText({ sessionKey: 'k', reason: 'pid-dead-cause-undetermined' })).toContain(
      'cause not established',
    )
  })

  it('a shutdown marker on a LIVE child manufactures nothing', () => {
    // The marker EXPLAINS a death; it may never create one. RED-mutation: hoist the
    // `killedByGatewayShutdown` check above the `childAlive` test.
    expect(detectReplWedged({ ...base, shutdownObserved: 'alive-and-killed' as const })).toEqual({ wedged: false })
    // ...and a marked, alive-but-silent child is still the dev-channel verdict.
    expect(
      detectReplWedged({ ...base, healthOk: false, shutdownObserved: 'alive-and-killed' as const }),
    ).toMatchObject({ wedged: true, reason: 'no-port-listener' })
  })

  it('the operator alert names the restart rather than a silent spawn failure', () => {
    const text = buildWedgeAlertText({ sessionKey: 'k', reason: 'pid-dead-gateway-shutdown' })
    expect(text).toContain('process terminated by a gateway restart/deploy')
    // The plain crash symptom is unchanged — the two sentences must stay distinct.
    expect(buildWedgeAlertText({ sessionKey: 'k', reason: 'pid-dead' })).toContain('process dead')
    expect(buildWedgeCapHitAlertText({ sessionKey: 'k', reason: 'pid-dead-gateway-shutdown' })).toContain(
      'process terminated by a gateway restart/deploy',
    )
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
