/**
 * @neutronai/runtime — Pending-redirect structural types (Sprint B, 2026-05-20).
 *
 * Engine-facing types for the slug-rename WS-closed-during-rename
 * recovery path. Lifted out of the Managed provisioning module
 * (`onboarding-api/pending-redirect-store`) so the chat-bridge + the
 * landing-stack factory can hold the store as a DI seam without pulling
 * the Managed concrete `SqlitePendingRedirectStore` into the import graph.
 *
 * The Managed concrete implementation lives in the provisioning module's
 * `onboarding-api/pending-redirect-store` and structurally satisfies the
 * `PendingRedirectStore` interface here.
 *
 * Open self-hosted boxes never run the slug-rename flow, so they pass
 * `undefined` for this store and the chat-bridge skips the redirect
 * delivery path entirely.
 */

/**
 * Default 15-minute TTL for a persisted pending-redirect row — matches
 * the start-token TTL the slug-picker mints into `new_start_token`. The
 * window comfortably covers a real-world WS hiccup (sub-second to a few
 * seconds) or a user who closed the tab and reopened it; it is also
 * deliberately NOT longer than the embedded start-token's own JWT
 * expiry, since a redirect that outlives its token would just hand the
 * destination a dead `?start=` and force a re-OAuth round-trip anyway.
 *
 * Lifted here (from the Managed `pending-redirect-store.ts`) so the
 * chat-bridge writer path can stamp `expires_at_ms` without importing
 * the Managed concrete store. The store re-exports this constant for
 * back-compat with existing importers.
 */
export const PENDING_REDIRECT_TTL_MS = 15 * 60 * 1000

/** Stored row shape — both Open and Managed see this exact shape. */
export interface PendingRedirect {
  topic_id: string
  new_slug: string
  target_url: string
  new_start_token: string
  expires_at_ms: number
  created_at_ms: number
}

/** Outcome of `takeAndClaim`. */
export type TakeAndClaimResult =
  | { kind: 'no_redirect' }
  | { kind: 'claimed'; redirect: PendingRedirect }
  | { kind: 'replay'; redirect: PendingRedirect }

export interface TakeAndClaimInput {
  topic_id: string
  now_ms: number
  jti: string
  jti_expires_at_ms: number
  /**
   * 2026-06-05 (click-button, Argus #1 BLOCKER) — the host the WS that
   * is replaying this redirect is connected to. When supplied AND the
   * pending row's `target_url` host equals it, the redirect is a
   * destination-host self-redirect: the user already CLICKED the button
   * and arrived on the destination subdomain, so re-emitting the
   * `redirect` envelope back to the page they're already on (with the
   * about-to-be-burned token) would re-strand them. In that case
   * `takeAndClaim` consumes the row but returns `{ kind: 'no_redirect' }`
   * WITHOUT burning the jti, so the caller falls through to a normal
   * `engine.start` on the destination host. Mirrors the HTTP 302 path's
   * self-redirect guard (`gateway/index.ts:resolvePendingRedirect`).
   * Omitted by callers that can't resolve the request host (legacy
   * tests, non-web paths) — the guard then never fires and behaviour is
   * unchanged.
   */
  current_host?: string
}

/**
 * The store contract chat-bridge consumes. The Managed implementation
 * (`SqlitePendingRedirectStore`) structurally satisfies it; Open
 * passes `undefined` and the chat-bridge no-ops the delivery path.
 */
export interface PendingRedirectStore {
  put(redirect: PendingRedirect): Promise<void>
  get(topic_id: string, now_ms: number): Promise<PendingRedirect | null>
  delete(topic_id: string): Promise<void>
  take(topic_id: string, now_ms: number): Promise<PendingRedirect | null>
  takeAndClaim(input: TakeAndClaimInput): Promise<TakeAndClaimResult>
  pruneExpired(cutoff_ms: number): Promise<number>
}
