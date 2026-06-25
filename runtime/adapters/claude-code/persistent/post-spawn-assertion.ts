/**
 * post-spawn-assertion.ts — verify a freshly-spawned REPL actually produced a
 * live child + a bound, MCP-handshaken dev-channel before the first inject.
 *
 * LIFTED from Nova `gateway/post-spawn-assertion.ts` (§ 1 #8,
 * ◆ ADAPTED-AT-BOUNDARY). The polled-budget, first-stage-to-fail-returns
 * structure is the Nova logic. THE CHECK SWAP (per the brief): the tmux
 * window/pane-pid stages are gone; the stage set is now
 *   1. child alive (`kill -0`)
 *   2. dev-channel handshake seen (`/channel-ready` received)
 *   3. dev-channel HTTP `/health` responds
 *   4. channel-MCP-unwired wedge (port row #6) — re-read the ring FRESH AFTER
 *      /health is up; if "no MCP server configured with that name" persists past
 *      a short confirm grace, fast-fail `channel-wedged` (the spawn LOOKS alive
 *      — /health 200 — but the agent can never `reply()`).
 * All probes are dep-injected so the function stays unit-testable.
 *
 * RE-READ-AFTER-HEALTH ORDERING (cross-cutting invariant §7, LOAD-BEARING):
 * Stage 4 re-captures the ring ONLY after Stage 3's /health gate flips. A stale
 * pre-health snapshot could read `!unwired` and let a same-tick-unwired channel
 * through — so the unwired re-read MUST happen after health, never before.
 */

import { channelUnwiredSignaturePresent } from './channel-unwired-detector.ts'

export type SpawnAssertionResult =
  | { ok: true; pid: number; channelPort: number }
  | { ok: false; reason: SpawnAssertionFailureReason; detail?: string }

export type SpawnAssertionFailureReason =
  /** The child process is not alive (`kill -0` failed / it already exited). */
  | 'dead-child'
  /** The dev-channel never POSTed `/channel-ready` within the budget — the MCP
   *  server never finished booting / handshaking. */
  | 'no-channel-ready'
  /** Child + handshake look alive but the dev-channel HTTP `/health` never
   *  responded — a wedged spawn that never finished binding. */
  | 'no-http-health'
  /** Child alive + handshake seen + `/health` 200, BUT a fresh re-read of the
   *  ring AFTER health-up shows the channel-MCP-unwired signature ("no MCP
   *  server configured with that name") persisting past the confirm grace — the
   *  REPL never bound the channel MCP and can never `reply()` (port row #6). */
  | 'channel-wedged'

export interface SpawnAssertionDeps {
  /** True iff the spawned child is still alive (`kill -0` / `!hasExited`). */
  isChildAlive: () => boolean
  /** Return the channel port once the dev-channel POSTed `/channel-ready`,
   *  else undefined (handshake not seen yet). */
  getChannelPort: () => number | undefined
  /** True iff the dev-channel HTTP `/health` on `port` responds ok. */
  hasHttpHealth: (port: number) => Promise<boolean>
  /** Re-read the PTY ring FRESH (raw text), or `null` on a failed capture. Called
   *  ONLY in Stage 4, AFTER `/health` is up (invariant §7) — so a stale pre-health
   *  snapshot can never gate the unwired check. A `null` capture counts as
   *  NOT-unwired (a capture glitch must not fast-fail a healthy spawn). OMIT to
   *  skip Stage 4 entirely (back-compat: the channel-wedged gate is off). */
  readRingFresh?: () => string | null
  /** Sleep `ms` between retries. */
  sleep: (ms: number) => Promise<void>
  /** Clock. */
  now: () => number
}

export interface SpawnAssertionConfig {
  /** Budget for the child-alive + channel-ready stages. Default 30s. */
  readyBudgetMs?: number
  /** Poll interval for the ready stages. Default 250ms. */
  readyIntervalMs?: number
  /** Budget for the HTTP /health stage. Default 10s. */
  healthBudgetMs?: number
  /** Poll interval for the health stage. Default 500ms. */
  healthIntervalMs?: number
  /** Stage-4 confirm grace: how long the channel-MCP-unwired signature must
   *  PERSIST (re-read fresh each poll, AFTER health-up) before we fast-fail
   *  `channel-wedged`. A transient mid-render frame mustn't fast-fail a spawn
   *  that's about to bind, so the signature has to survive this window. This is
   *  a short SPAWN-PATH confirm window — NOT the 60s topic-readiness grace the
   *  wedge-detector owns. Default 2s. */
  channelWedgeGraceMs?: number
  /** Poll interval for the Stage-4 unwired re-read. Default 250ms. */
  channelWedgeIntervalMs?: number
}

/**
 * Run the post-spawn liveness assertion in stages. Each stage retries within
 * its own budget; the first stage to fail returns immediately so the caller
 * can branch on the specific reason. Never throws.
 */
export async function assertReplAlive(
  args: { pid: number },
  deps: SpawnAssertionDeps,
  config: SpawnAssertionConfig = {},
): Promise<SpawnAssertionResult> {
  const readyBudget = config.readyBudgetMs ?? 30_000
  const readyInterval = config.readyIntervalMs ?? 250
  const healthBudget = config.healthBudgetMs ?? 10_000
  const healthInterval = config.healthIntervalMs ?? 500
  const channelWedgeGrace = config.channelWedgeGraceMs ?? 2_000
  const channelWedgeInterval = config.channelWedgeIntervalMs ?? 250

  // Stage 1 + 2: child alive AND dev-channel handshake seen, within one
  // budget. We re-check child-alive every poll so a crash during boot fails
  // fast with `dead-child` rather than waiting out the channel-ready budget.
  const readyDeadline = deps.now() + readyBudget
  let channelPort: number | undefined
  while (true) {
    if (!deps.isChildAlive()) {
      return { ok: false, reason: 'dead-child', detail: `pid=${args.pid}` }
    }
    channelPort = deps.getChannelPort()
    if (channelPort !== undefined && channelPort > 0) break
    if (deps.now() >= readyDeadline) {
      return { ok: false, reason: 'no-channel-ready', detail: `pid=${args.pid}` }
    }
    await deps.sleep(readyInterval)
  }

  // Stage 3: dev-channel HTTP /health. Confirms the loopback bridge is
  // actually serving before we POST the first /message.
  const healthDeadline = deps.now() + healthBudget
  while (true) {
    if (!deps.isChildAlive()) {
      return { ok: false, reason: 'dead-child', detail: `pid=${args.pid}` }
    }
    if (await deps.hasHttpHealth(channelPort)) break // health is up → run Stage 4
    if (deps.now() >= healthDeadline) {
      return { ok: false, reason: 'no-http-health', detail: `pid=${args.pid} port=${channelPort}` }
    }
    await deps.sleep(healthInterval)
  }

  // Stage 4: channel-MCP-unwired wedge (port row #6). The spawn now LOOKS alive
  // (child up, handshake seen, /health 200) — but under spawn-time memory/CPU
  // pressure the REPL can finish booting WITHOUT binding the channel MCP, so
  // every `reply()` prints "no MCP server configured with that name" and the
  // turn never delivers. We re-read the ring FRESH — strictly AFTER the /health
  // gate above (invariant §7: a stale pre-health snapshot could read !unwired and
  // let a same-tick-unwired channel through) — and require the signature to
  // PERSIST across the confirm grace before fast-failing (a transient mid-render
  // frame mustn't fast-fail a spawn that's about to bind). A `null`/failed
  // capture counts as NOT-unwired so a capture glitch can't fast-fail a healthy
  // spawn. NO keystroke — detect → fast-fail → (caller) bounded respawn only.
  // Stage 4 is skipped entirely when no ring reader is wired (back-compat).
  if (deps.readRingFresh !== undefined) {
    const wedgeDeadline = deps.now() + channelWedgeGrace
    while (true) {
      if (!deps.isChildAlive()) {
        return { ok: false, reason: 'dead-child', detail: `pid=${args.pid}` }
      }
      const ring = deps.readRingFresh()
      const unwired = ring !== null && channelUnwiredSignaturePresent(ring, deps.now())
      if (!unwired) break // signature cleared (or never present) → channel bound OK
      if (deps.now() >= wedgeDeadline) {
        return {
          ok: false,
          reason: 'channel-wedged',
          detail: `pid=${args.pid} port=${channelPort}`,
        }
      }
      await deps.sleep(channelWedgeInterval)
    }
  }

  return { ok: true, pid: args.pid, channelPort }
}

/** Human-readable summary of a failed assertion (stable wording for greps). */
export function describeReplAssertionFailure(
  sessionKey: string,
  result: Extract<SpawnAssertionResult, { ok: false }>,
): string {
  switch (result.reason) {
    case 'dead-child':
      return `[repl-spawn-fail] ${sessionKey}: child exited during bootstrap (${result.detail ?? 'no detail'}).`
    case 'no-channel-ready':
      return `[repl-spawn-fail] ${sessionKey}: dev-channel never handshaked (${result.detail ?? 'no detail'}) — MCP server boot failed.`
    case 'no-http-health':
      return `[repl-spawn-fail] ${sessionKey}: dev-channel HTTP /health never responded (${result.detail ?? 'no detail'}).`
    case 'channel-wedged':
      return `[repl-spawn-fail] ${sessionKey}: dev-channel /health 200 but the channel MCP never bound — "no MCP server configured with that name" persisted (${result.detail ?? 'no detail'}).`
  }
}
