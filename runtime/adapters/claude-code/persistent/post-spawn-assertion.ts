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
 * All probes are dep-injected so the function stays unit-testable.
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

export interface SpawnAssertionDeps {
  /** True iff the spawned child is still alive (`kill -0` / `!hasExited`). */
  isChildAlive: () => boolean
  /** Return the channel port once the dev-channel POSTed `/channel-ready`,
   *  else undefined (handshake not seen yet). */
  getChannelPort: () => number | undefined
  /** True iff the dev-channel HTTP `/health` on `port` responds ok. */
  hasHttpHealth: (port: number) => Promise<boolean>
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
    if (await deps.hasHttpHealth(channelPort)) {
      return { ok: true, pid: args.pid, channelPort }
    }
    if (deps.now() >= healthDeadline) {
      return { ok: false, reason: 'no-http-health', detail: `pid=${args.pid} port=${channelPort}` }
    }
    await deps.sleep(healthInterval)
  }
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
  }
}
