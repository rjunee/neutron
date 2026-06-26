/**
 * post-spawn-assertion.ts — verify a freshly-spawned REPL actually produced a
 * live child + a bound, MCP-handshaken dev-channel before the first inject.
 *
 * LIFTED from Nova `gateway/post-spawn-assertion.ts` (§ 1 #8,
 * ◆ ADAPTED-AT-BOUNDARY). The polled-budget, first-stage-to-fail-returns
 * structure is the Nova logic. THE CHECK SWAP (per the brief): the tmux
 * window/pane-pid stages are gone; the stage set is now
 *   1. child alive (`kill -0`)
 *   2. dev-channel transport attached (`/channel-ready` received)
 *   3. dev-channel HTTP `/health` responds
 *   4. dev-channel MCP HANDSHAKE complete (`/channel-bound` received) — claude
 *      actually sent the MCP `initialize`/`initialized` round-trip, so the
 *      `claude/channel` capability + `reply` tool are live. If it never arrives
 *      within the budget, fast-fail `channel-wedged` (the spawn LOOKS alive —
 *      /health 200 — but claude never wired the channel, so the agent can never
 *      `reply()`).
 * All probes are dep-injected so the function stays unit-testable.
 *
 * WHY A PROTOCOL SIGNAL, NOT A TUI STRING (P0 fix, 2026-06-26): the prior Stage 4
 * scanned the PTY ring for `no MCP server configured with that name` and fast-
 * failed if it persisted. But claude 2.1.186 ALWAYS renders that warning in the
 * dev-channel TUI header for an `--mcp-config`-provided channel server — even
 * when the channel is fully wired and `reply()` round-trips (verified live under
 * the real Bun PTY harness). The string is therefore a FALSE-POSITIVE wedge
 * signal that failed every spawn → bounded-respawn cap → every LLM turn died.
 * `/channel-bound` (the dev-channel's `mcp.oninitialized` hook) is the only
 * signal that proves the handshake actually completed, so we gate on it instead.
 */

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
  /** Child alive + transport attached + `/health` 200, BUT the dev-channel never
   *  POSTed `/channel-bound` within the budget — claude never completed the MCP
   *  `initialize`/`initialized` handshake, so it never wired the `claude/channel`
   *  capability and the agent can never `reply()` (port row #6). */
  | 'channel-wedged'

export interface SpawnAssertionDeps {
  /** True iff the spawned child is still alive (`kill -0` / `!hasExited`). */
  isChildAlive: () => boolean
  /** Return the channel port once the dev-channel POSTed `/channel-ready`
   *  (transport attached), else undefined. */
  getChannelPort: () => number | undefined
  /** True iff the dev-channel HTTP `/health` on `port` responds ok. */
  hasHttpHealth: (port: number) => Promise<boolean>
  /** True once the dev-channel POSTed `/channel-bound` — i.e. claude completed
   *  the MCP `initialize`/`initialized` handshake and wired the `claude/channel`
   *  capability (`mcp.oninitialized` fired). This is the TRUE readiness signal
   *  (NOT the always-present "no MCP server configured" TUI warning). OMIT to skip
   *  Stage 4 entirely (back-compat: the channel-wedged gate is off). */
  isChannelBound?: () => boolean
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
  /** Stage-4 budget: how long to wait for the dev-channel's `/channel-bound`
   *  signal (claude's MCP handshake) AFTER `/health` is up before fast-failing
   *  `channel-wedged`. The handshake normally lands within tens of ms of
   *  `/channel-ready`, but the interactive dev-channel disclaimer can defer it
   *  until the output scanner dismisses it, and spawn-time CPU/memory pressure
   *  widens the window — so this allows a generous margin. Default 15s. */
  channelBoundBudgetMs?: number
  /** Poll interval for the Stage-4 `/channel-bound` wait. Default 250ms. */
  channelBoundIntervalMs?: number
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
  const channelBoundBudget = config.channelBoundBudgetMs ?? 15_000
  const channelBoundInterval = config.channelBoundIntervalMs ?? 250

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

  // Stage 4: dev-channel MCP HANDSHAKE complete (port row #6). The spawn now
  // LOOKS alive (child up, transport attached, /health 200) — but a `/health` 200
  // only proves the dev-channel's loopback HTTP server is up; it does NOT prove
  // claude wired the MCP. The TRUE bind signal is `/channel-bound`, posted from
  // the dev-channel's `mcp.oninitialized` hook when claude completes the
  // `initialize`/`initialized` round-trip. We poll for it within a budget; if it
  // never arrives, claude never wired the channel and every `reply()` would fail
  // → fast-fail `channel-wedged` → (caller) bounded respawn. We do NOT scan the
  // PTY ring for "no MCP server configured with that name": claude 2.1.186 prints
  // that warning even for a fully-wired channel, so it is a false-positive (the
  // bug this fix removes). Stage 4 is skipped when no bind probe is wired
  // (back-compat).
  if (deps.isChannelBound !== undefined) {
    const boundDeadline = deps.now() + channelBoundBudget
    while (true) {
      if (!deps.isChildAlive()) {
        return { ok: false, reason: 'dead-child', detail: `pid=${args.pid}` }
      }
      if (deps.isChannelBound()) break // MCP handshake complete → channel wired OK
      if (deps.now() >= boundDeadline) {
        return {
          ok: false,
          reason: 'channel-wedged',
          detail: `pid=${args.pid} port=${channelPort}`,
        }
      }
      await deps.sleep(channelBoundInterval)
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
      return `[repl-spawn-fail] ${sessionKey}: dev-channel /health 200 but the channel MCP never bound — no /channel-bound (claude never completed the MCP handshake) (${result.detail ?? 'no detail'}).`
  }
}
