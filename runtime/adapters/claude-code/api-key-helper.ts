/**
 * @neutronai/runtime — Max OAuth subscription loader.
 *
 * Pre-2026-05-26 this file housed the full `apiKeyHelper` script-spawn
 * cache + 6-tier credential chain consumed by the now-removed HTTP path
 * (`transport-stream.ts`). The Claude Code substrate (the persistent
 * interactive REPL) delegates auth entirely to the `claude` binary — which reads
 * `~/.claude/.credentials.json` itself — so the script-spawn helper
 * machinery is no longer wired through the adapter.
 *
 * What survives in this file is `makeMaxOAuthSubscriptionLoader`: it surfaces a
 * `{access_token, expires_at}` shape from the owner's secrets store,
 * independently of the CC substrate. Its sole consumer was the Code-Gen Core's
 * gateway wrapper (`gateway/cores/code-gen-factory.ts`), RETIRED in the
 * Trident-port close-out (2026-06-24) — `/code` now runs on foundational
 * Trident over the CC-subprocess substrate. The export (and its test) are kept
 * so a future OAuth-loader need has a ready helper rather than a re-impl.
 *
 * With the wrapper gone this file can be deleted once nothing else needs the
 * loader. Until then, keep this slim — it is NOT the credential resolver for the CC
 * adapter anymore.
 */

/**
 * Slack window — return a "fresh enough" cached token when its
 * `expires_at` is at least this far in the future. Avoids refreshing on
 * every request when a token has 30 s left, while still proactively
 * refreshing before the upstream rejects with 401.
 */
const SUBSCRIPTION_TOKEN_SLACK_MS = 30_000

/**
 * The loader function shape — synchronous-returning a Promise of the
 * cached/refreshed access token + expiry, or `null` when there is no
 * credential to serve.
 */
export type MaxOAuthSubscriptionLoader = () => Promise<{
  access_token: string
  expires_at: number
} | null>

export interface MakeMaxOAuthSubscriptionLoaderInput {
  /** Owner whose secrets we read. */
  instance_slug: string
  /** Sub label; defaults to 'default' for single-sub. */
  sub_label?: string
  /**
   * Reads the cached access token + expiry from the secrets store.
   * Returns null when no token has been issued yet — caller decides
   * whether to return null up the chain or to refresh first.
   */
  loadCached: () => Promise<{ access_token: string; expires_at: number } | null>
  /** Refresh path — invoked when the cached access token is stale or absent. */
  refresh: () => Promise<{ access_token: string; expires_at: number }>
  /** Clock override for tests. */
  now?: () => number
}

/**
 * Build a `MaxOAuthSubscriptionLoader`. The returned function reads the
 * cached token, refreshes when the cached entry is within the slack
 * window or empty, and returns `null` when a refresh produces an empty
 * access_token (treated as an unrecoverable refresh failure — callers
 * surface a user-visible error).
 */
export function makeMaxOAuthSubscriptionLoader(
  input: MakeMaxOAuthSubscriptionLoaderInput,
): MaxOAuthSubscriptionLoader {
  const now = input.now ?? ((): number => Date.now())
  return async () => {
    const cached = await input.loadCached()
    // Guard against an empty cached access_token (corrupted secrets
    // row, partial write, etc.). Without this check the caller could
    // surface an `Authorization: Bearer ` header and never refresh
    // until the cached expiry elapsed.
    if (
      cached !== null &&
      cached.access_token.length > 0 &&
      cached.expires_at - SUBSCRIPTION_TOKEN_SLACK_MS > now()
    ) {
      return cached
    }
    const refreshed = await input.refresh()
    if (typeof refreshed.access_token !== 'string' || refreshed.access_token.length === 0) {
      return null
    }
    return refreshed
  }
}
