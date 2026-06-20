/**
 * wedge-respawn-dispatch.ts — thin orchestrator that runs the
 * `planRespawn → executeRespawn → markInFlight` sequence for the
 * `respawn-and-alert` branch of the REPL wedge detector.
 *
 * LIFTED VERBATIM from Nova `gateway/wedge-respawn-dispatch.ts` (substrate-lift
 * S2 § 2 row #10, ★ CORE-PRESERVED-VERBATIM). Structurally-typed leaf module —
 * no dependency on session-respawn.ts (avoids an import cycle). Only the
 * injected `plan`/`execute`/`markInFlight` closures change at the boundary.
 *
 * The hard contract this module exists to enforce: `markInFlight` is stamped
 * EXACTLY when an actual respawn fired (`plan.ok && execute.ok`). Every refusal
 * / throw path leaves the in-flight marker untouched so the next tick can retry
 * — the original inline version stamped in-flight BEFORE plan/execute and
 * ignored their results, so a refused plan/execute locked the key into
 * `alert-only` for the whole in-flight window with no recovery actually running.
 */

/** Minimal shape of `planRespawn`'s result that the dispatcher needs. Matches
 *  `RespawnPlan` from session-respawn.ts but kept structurally typed here so
 *  this module stays a leaf. */
export interface WedgeRespawnPlanLike {
  ok: boolean
  reason?: string
}

/** Minimal shape of `executeRespawn`'s result that the dispatcher needs. */
export interface WedgeRespawnExecuteOutcomeLike {
  ok: boolean
  reason?: string
}

export type WedgeRespawnDispatchOutcome =
  | { kind: 'fired' }
  | { kind: 'plan-refused'; reason: string }
  | { kind: 'execute-refused'; reason: string }
  | { kind: 'threw'; error: unknown }

/** Caller-supplied dependencies. The plan + execute functions are passed in so
 *  the unit test can drive each refusal shape deterministically without
 *  touching session-respawn's PTY-kill / pool-eviction side effects. */
export interface WedgeRespawnDispatchDeps<
  P extends WedgeRespawnPlanLike = WedgeRespawnPlanLike,
> {
  plan: () => P
  execute: (planResult: P) => WedgeRespawnExecuteOutcomeLike
  /** Called exactly when the dispatch result is `fired`. The production wire
   *  stamps the respawn-in-flight marker on the registry record. */
  markInFlight: () => void
}

/** Run the dispatch and return what happened. `markInFlight` is invoked exactly
 *  when an actual executeRespawn(..)→ok=true dispatch landed. All refusal /
 *  throw paths leave the in-flight marker untouched so the next tick can retry. */
export function dispatchWedgeRespawn<P extends WedgeRespawnPlanLike>(
  deps: WedgeRespawnDispatchDeps<P>,
): WedgeRespawnDispatchOutcome {
  let planResult: P
  try {
    planResult = deps.plan()
  } catch (e) {
    return { kind: 'threw', error: e }
  }
  if (!planResult.ok) {
    return {
      kind: 'plan-refused',
      reason: planResult.reason ?? 'unknown',
    }
  }
  let outcome: WedgeRespawnExecuteOutcomeLike
  try {
    outcome = deps.execute(planResult)
  } catch (e) {
    return { kind: 'threw', error: e }
  }
  if (!outcome.ok) {
    return {
      kind: 'execute-refused',
      reason: outcome.reason ?? 'unknown',
    }
  }
  deps.markInFlight()
  return { kind: 'fired' }
}
