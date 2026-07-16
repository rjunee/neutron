/**
 * dead-repl-detector.ts — decide whether a persistent REPL the pool BELIEVES is
 * warm is silently wedged, and what to do about it (substrate-lift S2 § 2 row
 * #14 / § 6 acceptance #1).
 *
 * LIFTED from Nova `gateway/topic-wedge-detector.ts`. `decideWedgeAction` (the
 * 6 ordered gates) + the alert-text builders are ★ pure and lift VERBATIM. The
 * detection table `detectReplWedged` is ◆ ADAPTED: Nova probed `kill -0 <pid>`
 * + `lsof :<port>` live inside the function; here the read-source moves to the
 * watchdog tick (which awaits `PtyChild.hasExited()` + the dev-channel `/health`
 * fetch) and passes the already-resolved booleans in, keeping the decision a
 * pure table. The verdict shapes + the dead-child-first ordering are unchanged.
 *
 * Wedge: the substrate's pool holds a session it believes is serving, but the
 * child has exited (`pid-dead`) and/or the dev-channel `/health` is dead
 * (`no-port-listener`). Inbound turns would route to a dead REPL and the user
 * sees nothing — the exact S1 crash gap (brief § 0). On a confirmed wedge the
 * tick fires a `--resume` respawn (the equivalent of the operator hitting
 * `POST /admin/respawn-session`).
 */

/** Verdict on a REPL's wedge state. `wedged: false` means routable. */
export type WedgeVerdict =
  | { wedged: false }
  | {
      wedged: true
      reason: WedgeReason
      detail: string
    }

export type WedgeReason =
  /** A pooled session exists but its child has exited — strongest signal. */
  | 'pid-dead'
  /** Child looks alive but the dev-channel `/health` is dead. */
  | 'no-port-listener'
  /** No pooled child AND never reached ready AND `/health` dead — a stale
   *  registry row from a long-dead session (the cross-restart orphan case). */
  | 'no-pid-no-listener'

/** Pre-probed liveness inputs the watchdog tick resolves before deciding. All
 *  booleans so `detectReplWedged` stays a pure table (the async `/health` fetch
 *  + `hasExited()` happen in the tick). */
export interface ReplWedgeProbe {
  /** The pool holds a session (with an attached child) for this key. False for
   *  a registry-only row whose process died with a prior gateway. */
  hasChild: boolean
  /** The pooled child is alive (`!PtyChild.hasExited()` / `kill -0 pid`). Only
   *  meaningful when `hasChild`. */
  childAlive: boolean
  /** The dev-channel HTTP `/health` responded ok. */
  healthOk: boolean
  /** The registry believes this session reached `/health` at some point
   *  (`first_ready_at` set) — disambiguates "never came up" from "went silent". */
  ccReady: boolean
}

/**
 * Decide whether the REPL is wedged. Pure table — mirrors Nova's
 * `detectTopicWedged` decision table 1:1, with `pid` → pooled-child presence
 * and `lsof :port` → dev-channel `/health`.
 *
 *   hasChild  childAlive  healthOk  ccReady  verdict
 *   --------  ----------  --------  -------  --------------------------------
 *   yes       no          -         -        wedged: 'pid-dead'
 *   yes       yes         no        -        wedged: 'no-port-listener'
 *   yes       yes         yes       -        not wedged
 *   no        -           yes       -        not wedged (health is positive)
 *   no        -           no        yes      not wedged (ccReady positive)
 *   no        -           no        no       wedged: 'no-pid-no-listener'
 *
 * The dead-child branch runs first because it's the strongest signal — the
 * spawn produced no surviving process at all.
 */
export function detectReplWedged(probe: ReplWedgeProbe): WedgeVerdict {
  if (probe.hasChild) {
    if (!probe.childAlive) {
      return { wedged: true, reason: 'pid-dead', detail: 'pooled child exited' }
    }
    if (!probe.healthOk) {
      return {
        wedged: true,
        reason: 'no-port-listener',
        detail: 'child alive, dev-channel /health silent',
      }
    }
    return { wedged: false }
  }
  // No pooled child.
  if (probe.healthOk) return { wedged: false }
  if (probe.ccReady) return { wedged: false }
  return {
    wedged: true,
    reason: 'no-pid-no-listener',
    detail: 'no pooled child, /health silent, never-ready',
  }
}

/** Canonical alert body for a detected wedge. Lifted from Nova; the operator
 *  endpoint is `POST /admin/respawn-session?session=<key>`. */
export function buildWedgeAlertText(args: { sessionKey: string; reason: WedgeReason }): string {
  const symptom =
    args.reason === 'pid-dead'
      ? 'process dead'
      : args.reason === 'no-port-listener'
        ? 'dev-channel silent'
        : 'no live signals'
  return (
    `\u{26A0}\u{FE0F} REPL \`${args.sessionKey}\` appears wedged (${symptom} — ` +
    `spawn failed silently). Auto-recovery in progress... or send ` +
    `\`POST /admin/respawn-session?session=${encodeURIComponent(args.sessionKey)}\` to force-recover.`
  )
}

/** Cap-hit variant: wedged AND the respawn cap tripped → auto-recovery OFF. */
export function buildWedgeCapHitAlertText(args: { sessionKey: string; reason: WedgeReason }): string {
  const symptom =
    args.reason === 'pid-dead'
      ? 'process dead'
      : args.reason === 'no-port-listener'
        ? 'dev-channel silent'
        : 'no live signals'
  return (
    `\u{1F6A8} REPL \`${args.sessionKey}\` wedged (${symptom}) AND respawn cap-hit ` +
    `— auto-recovery DISABLED. Force-recover via ` +
    `\`POST /admin/respawn-session?session=${encodeURIComponent(args.sessionKey)}\`.`
  )
}

/** Recovery-in-progress variant: deduped while a respawn is already in flight. */
export function buildWedgeRecoveryInProgressText(args: { sessionKey: string }): string {
  return (
    `\u{26A0}\u{FE0F} REPL \`${args.sessionKey}\` still wedged — recovery already in ` +
    `progress, please wait. If this persists send ` +
    `\`POST /admin/respawn-session?session=${encodeURIComponent(args.sessionKey)}\` to force-recover.`
  )
}

/** Decision returned by `decideWedgeAction` — the caller branches on `kind`. */
export type WedgeAction =
  | { kind: 'ignore'; reason: WedgeIgnoreReason }
  | { kind: 'cap-hit-alert'; verdict: Extract<WedgeVerdict, { wedged: true }>; alert: WedgeAlertDecision }
  | { kind: 'alert-only'; verdict: Extract<WedgeVerdict, { wedged: true }>; alert: WedgeAlertDecision }
  | { kind: 'respawn-and-alert'; verdict: Extract<WedgeVerdict, { wedged: true }>; alert: WedgeAlertDecision }

export type WedgeIgnoreReason =
  | 'not-wedged'
  /** Never reached ready — cold start; the normal spawn flow owns recovery. */
  | 'never-ready'
  /** Became ready < `firstReadyGraceMs` ago — boot window, cached state in flux. */
  | 'boot-window'

/** Whether the caller should actually post the alert (folds the dedupe in). */
export type WedgeAlertDecision = { send: true } | { send: false; reason: 'deduped' }

/** Input state the action decider needs. All passed in so the function stays
 *  pure (testable without a live substrate). */
export interface WedgeActionContext {
  verdict: WedgeVerdict
  /** Registry `first_ready_at` — undefined when never ready. */
  firstReadyAt: number | undefined
  /** Registry `capped_at` — undefined when the respawn cap is not tripped. */
  cappedAt: number | undefined
  /** A respawn is already in flight (in-flight stamp set / process gate held). */
  respawnInFlight: boolean
  /** Registry `last_respawn_at` — cooldown gate input. */
  lastWedgeAutoRespawnAt: number | undefined
  /** Last alert timestamp (in-memory dedupe). */
  lastWedgeAlertAt: number | undefined
  now: number
  /** Override gate constants (tests). Production passes defaults. */
  firstReadyGraceMs?: number
  respawnCooldownMs?: number
  alertDedupeMs?: number
}

/**
 * Decide what the caller does with a wedge verdict — pure, total function.
 * Order of gates (LIFTED VERBATIM from Nova `decideWedgeAction`):
 *   1. not wedged → ignore (`not-wedged`)
 *   2. never ready → ignore (`never-ready`) — cold-start inbound; normal flow
 *      owns recovery; firing here could refuse `no-session-to-resume`.
 *   3. inside boot-grace → ignore (`boot-window`)
 *   4. cap tripped → `cap-hit-alert` (auto-recovery OFF; operator must clear)
 *   5. respawn in flight OR cooldown active → `alert-only` (deduped)
 *   6. otherwise → `respawn-and-alert`
 */
export function decideWedgeAction(ctx: WedgeActionContext): WedgeAction {
  if (!ctx.verdict.wedged) {
    return { kind: 'ignore', reason: 'not-wedged' }
  }
  const verdict = ctx.verdict
  const graceMs = ctx.firstReadyGraceMs ?? 60_000
  const cooldownMs = ctx.respawnCooldownMs ?? 30_000
  const dedupeMs = ctx.alertDedupeMs ?? 30_000

  if (ctx.firstReadyAt === undefined) {
    return { kind: 'ignore', reason: 'never-ready' }
  }
  if (ctx.now - ctx.firstReadyAt < graceMs) {
    return { kind: 'ignore', reason: 'boot-window' }
  }

  const alert: WedgeAlertDecision =
    ctx.lastWedgeAlertAt !== undefined && ctx.now - ctx.lastWedgeAlertAt < dedupeMs
      ? { send: false, reason: 'deduped' }
      : { send: true }

  if (ctx.cappedAt !== undefined) {
    return { kind: 'cap-hit-alert', verdict, alert }
  }

  const cooldownActive =
    ctx.lastWedgeAutoRespawnAt !== undefined &&
    ctx.now - ctx.lastWedgeAutoRespawnAt < cooldownMs
  if (ctx.respawnInFlight || cooldownActive) {
    return { kind: 'alert-only', verdict, alert }
  }

  return { kind: 'respawn-and-alert', verdict, alert }
}
