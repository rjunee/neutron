/**
 * channel-wedge-respawn.ts — P1: bounded respawn for the channel-MCP-unwired
 * wedge (port row #6).
 *
 * § Terminal-detection port, master-table row #6 + cross-cutting invariant §6
 * (bounded respawn caps with a hard-stop + ONE operator alert). When the
 * post-spawn assertion fast-fails a spawn as `channel-wedged` (dev-channel
 * `/health` 200 but the MCP never bound — see `channel-unwired-detector.ts`),
 * the root cause is transient memory/CPU pressure, so a respawn usually clears
 * it. But a re-arming cause would loop forever without a cap — so this is a
 * HARD-CAPPED bounded respawn: `MAX_FLEET_RESPAWNS` retries, then exactly one
 * operator alert and give up (no infinite loop).
 *
 * The driver is a pure, exception-free, dep-injected loop so the cap behaviour
 * is unit-testable without a live PTY / spawn.
 */

/**
 * Hard cap on channel-wedged respawns before auto-recovery stops and the
 * operator is alerted. Carried verbatim from Vajra's `MAX_FLEET_RESPAWNS = 2`.
 */
export const MAX_FLEET_RESPAWNS = 2

/** Outcome of one spawn-and-assert attempt, modelled as a discriminator (not an
 *  exception) so the loop stays pure + total. `wedged` distinguishes a
 *  channel-MCP-unwired wedge (retryable here) from any OTHER spawn failure
 *  (propagated immediately — this loop only owns the channel-wedged class). */
export type ChannelWedgeAttemptResult<T> =
  | { ok: true; value: T }
  | { ok: false; wedged: boolean; error: unknown }

export interface BoundedChannelWedgeRespawnDeps<T> {
  /** Run spawn+assert attempt `n` (0 = the initial spawn; 1..cap = respawns). */
  attempt: (n: number) => Promise<ChannelWedgeAttemptResult<T>>
  /** Fire the ONE operator alert. Called exactly once, only when the cap trips
   *  with the wedge still present. */
  alert: () => void
}

export type BoundedChannelWedgeRespawnResult<T> =
  /** A spawn came up clean. `respawns` = how many respawns it took (0 = first). */
  | { kind: 'ok'; value: T; respawns: number }
  /** Still channel-wedged after `cap` respawns → alert fired, auto-recovery off. */
  | { kind: 'capped'; respawns: number; error: unknown }
  /** A non-wedged spawn failure (dead-child / no-health / …) — NOT retried here;
   *  propagated to the caller's existing failure handling. */
  | { kind: 'failed'; error: unknown }

/**
 * Run the bounded channel-wedged respawn loop. Attempts the initial spawn, then
 * up to `cap` respawns while the attempt fast-fails as `channel-wedged`. The
 * FIRST clean attempt returns `ok`; a NON-wedged failure returns `failed`
 * immediately (this loop owns only the channel-wedged class); the wedge still up
 * after `cap` respawns fires ONE operator alert and returns `capped`.
 *
 * With `cap = 2`: attempt 0 (initial), 1 (respawn 1), 2 (respawn 2); if attempt
 * 2 is still wedged the cap trips → alert + `capped` (respawns: 2). So at most 2
 * respawns fire, then auto-recovery stops — never an infinite loop.
 */
export async function runBoundedChannelWedgeRespawn<T>(
  deps: BoundedChannelWedgeRespawnDeps<T>,
  cap: number = MAX_FLEET_RESPAWNS,
): Promise<BoundedChannelWedgeRespawnResult<T>> {
  let lastError: unknown
  for (let n = 0; n <= cap; n++) {
    const r = await deps.attempt(n)
    if (r.ok) return { kind: 'ok', value: r.value, respawns: n }
    if (!r.wedged) return { kind: 'failed', error: r.error }
    lastError = r.error
    if (n >= cap) {
      // Initial + `cap` respawns all wedged → ONE alert, auto-recovery stops.
      deps.alert()
      return { kind: 'capped', respawns: n, error: r.error }
    }
    // else: loop → respawn n+1.
  }
  // Unreachable (the n >= cap branch returns), but keeps the function total.
  return { kind: 'capped', respawns: cap, error: lastError }
}

/**
 * Typed error a spawn throws when the post-spawn assertion fast-fails it as
 * `channel-wedged`. The bounded-respawn wrapper catches THIS specifically so a
 * dead-child / no-health failure is never mistaken for a retryable wedge.
 */
export class ChannelWedgedSpawnError extends Error {
  readonly sessionKey: string
  constructor(sessionKey: string, detail?: string) {
    super(`persistent-repl: spawn failed (channel-wedged; ${detail ?? ''})`)
    this.name = 'ChannelWedgedSpawnError'
    this.sessionKey = sessionKey
  }
}

/** Canonical ONE-shot operator alert when the channel-wedged respawn cap trips. */
export function buildChannelWedgeCapAlertText(args: { sessionKey: string }): string {
  return (
    `\u{1F6A8} REPL \`${args.sessionKey}\` still channel-MCP-unwired after ` +
    `${MAX_FLEET_RESPAWNS} bounded respawns (dev-channel /health 200 but the MCP ` +
    `never bound — "no MCP server configured with that name"). Auto-recovery ` +
    `DISABLED; force-recover via ` +
    `\`POST /admin/respawn-session?session=${encodeURIComponent(args.sessionKey)}\`.`
  )
}
