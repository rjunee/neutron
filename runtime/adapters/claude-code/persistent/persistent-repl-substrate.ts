/**
 * persistent-repl-substrate.ts — THE BRIDGE (brief § 3 SPRINT 1 deliverable #4).
 *
 * `PersistentReplSubstrate implements Substrate`. It drives ONE persistent
 * interactive `claude` REPL per (instance, cwd) session key over the dev-channel,
 * and bridges the REPL's `reply`-tool output onto Neutron's locked
 * `Event`-stream `Substrate` contract — so every existing drain call site
 * (`collectTokensToString`, the 6 sibling drains) keeps working UNCHANGED.
 *
 * THE CRUX — why exactly-one-completion is clean:
 *   The `enforce-reply` Stop hook guarantees the REPL emits PRECISELY one
 *   `reply()` per channel turn. That maps 1:1 to one `completion` Event. The
 *   reply text is surfaced as a single `token` event immediately followed by
 *   the `completion`. The drain loop accumulates the token and returns on
 *   completion — identical to the retired per-turn `claude -p` path.
 *
 * Lifecycle per turn:
 *   start(spec) → ensure the session's REPL exists (spawn-or-reuse by key)
 *              → inject spec.prompt via dev-channel POST /message
 *              → return a SessionHandle whose events:
 *                   • {status} on inject (drives typing)
 *                   • {token}+{completion} when reply() fires for this turn
 *                   • {error, retryable} on process death / turn timeout
 *
 * tool_resolution = 'internal' (CC resolves its own MCP tools inside the REPL).
 * respondToTool throws (caller bug). cancel() aborts the in-flight turn and
 * leaves the REPL WARM (does not kill the child).
 *
 * Auth (brief § 1 #16): the PTY child inherits the caller's already-scrubbed
 * env (ANTHROPIC_* unset, CLAUDE_CODE_OAUTH_TOKEN set). No lift needed — the
 * interactive `claude` reads it natively.
 */

// D2 — Substrate banner split. This file is now the BARREL: the runtime driver
// was split along its section banners into 8 sibling modules. The public export
// surface below is UNCHANGED (same names, same type-only-ness). The shared
// per-process pool state lives in `pool-state.ts` (D1).

// Pass-through contract re-exports (external modules).
export type { RespawnTrigger, RespawnOutcome } from './session-respawn.ts'
export type { ReplToolBridge } from './pool-state.ts'

// Public surface, re-exported from the split modules.
export type { RateLimitBannerNotice, RecoveredReply, PersistentReplSubstrateOptions } from './types.ts'
export { setReplToolBridge, clearReplToolBridgeIf, getReplSinkInfo } from './repl-sink.ts'
export { httpHealth, type HttpHealthOptions } from './repl-session.ts'
export type { ReplSession } from './repl-session.ts'
export { drainPendingRespawns, type DrainPendingRespawnsOptions } from './pending-respawn.ts'
export {
  poolKeyFor,
  spawnEphemeralSession,
  createPersistentReplSubstrate,
  shutdownAllPersistentRepls,
} from './pool.ts'
export {
  registerSupervisedSubstrate,
  respawnSupervisedSession,
  makeReplRespawnDeps,
  respawnReplSession,
  runReplWatchdogTick,
  runCwdDriftWatchdogTick,
  startReplWatchdog,
  startModelUpdateWatchdogForInstance,
  peekModelUpdateWatchdogForTest,
  getReplRegistrySnapshot,
  poolHasSessionForTest,
  requestSessionCompact,
  peekSizeWatchdogForTest,
  type ReplWatchdogOptions,
  type ReplWatchdog,
} from './supervision.ts'
