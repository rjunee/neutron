/**
 * respawn-strategy.ts — pure three-tier `--resume` strategy resolver.
 *
 * LIFTED VERBATIM from Nova `gateway/gateway-core.ts` `resolveRespawnStrategy`
 * (§ 1 #3, ★ CORE-PRESERVED-VERBATIM). Pure function over a registry row — no
 * host coupling at all. The respawn-is-always-resume invariant (Sprint 2) is
 * built on this: a respawn ALWAYS prefers a known session UUID, then a legacy
 * session name, and only falls back to a fresh spawn when neither exists.
 *
 * Port test (`resume-invariant.test.ts`) verifies the fallback chain.
 */

export type RespawnStrategy = 'session-id' | 'session-name' | 'fresh'

export interface RespawnResolutionInput {
  /** Stored session UUID, if previously captured + validated. */
  session_id?: string
  /** Whether the registry believes this session has a resumable conversation. */
  has_session: boolean
  /** Legacy display/session name (pre-UUID), if any. */
  session_name?: string
}

export interface RespawnResolution {
  strategy: RespawnStrategy
  /** Present only for the `session-id` strategy. */
  sessionId?: string
  /** True when the resolved strategy can `--resume`. */
  resumable: boolean
}

/**
 * Resolve how to respawn a session:
 *   1. stored UUID wins (most reliable),
 *   2. a freshly-scanned UUID wins next,
 *   3. legacy session name wins next,
 *   4. otherwise a fresh (non-resumable) spawn.
 */
export function resolveRespawnStrategy(
  input: RespawnResolutionInput,
  scannedSessionId?: string,
): RespawnResolution {
  if (input.session_id) {
    return { strategy: 'session-id', sessionId: input.session_id, resumable: true }
  }
  if (scannedSessionId) {
    return { strategy: 'session-id', sessionId: scannedSessionId, resumable: true }
  }
  if (input.has_session && input.session_name) {
    return { strategy: 'session-name', resumable: true }
  }
  return { strategy: 'fresh', resumable: false }
}
