export interface AuthCompositionInput {
  /**
   * 2026-05-27 returning-user resume sprint — per-instance HTTP auth
   * gate. When supplied, the composed handler 302s a tokenless browser
   * GET of `/`, `/chat`, or `/api/app/*` to the identity service's
   * signin with `return_url` preserved, AND consumes a fresh
   * `?start=<token>` query param into a session cookie. Without this
   * field the gate is unmounted and the pre-sprint unauthenticated
   * behaviour for those paths is preserved (used by tests + dev /
   * smoke deploys without an identity service co-located).
   *
   * See `landing/auth-gate.ts:AuthGateOptions` for field semantics.
   */
  auth_gate?: {
    project_slug: string
    cookie_secret: string
    resolveKey: (kid: string) => Promise<import('jose').KeyLike | null>
    /**
     * C2 open-not-to-managed boundary — the gate takes the cryptographic
     * start-token verifier as an injected dep (the Open gate no longer
     * imports the Managed signup module statically). The Managed
     * production composer wires `signup/start-token.ts:
     * verifyStartTokenCryptographic`.
     */
    verifyStartToken: import('@neutronai/landing/auth-gate.ts').VerifyStartTokenGateFn
    identity_public_base_url: string
    now?: () => number
    /**
     * Argus r1 BLOCKER #1 (2026-05-27) — mint a fresh start_token bound
     * to this instance. The production composer wires this with the same
     * KeyManager + instance registry lookup that `/recover` uses. When
     * unwired, the gate falls through to `allow` for the cookie-only
     * `/chat` case (dev / smoke deploys without identity DB).
     */
    mintStartToken?: () => Promise<string | null>
    /**
     * 2026-06-03 — pending-redirect HTTP 302 fallback. The production
     * composer wires this against the per-instance `SqlitePendingRedirectStore`
     * + the `owner_user_id`. Lets the gate 302 a plain page
     * reload after a slug rename (whose live WS envelope was dropped)
     * straight to the new subdomain. See
     * `landing/auth-gate.ts:AuthGateOptions.resolvePendingRedirect`.
     */
    resolvePendingRedirect?: (current_host: string) => Promise<string | null>
    /**
     * 2026-06-05 slug-rename AUTH-LOOP fix — give the HTTP auth-gate the
     * SAME no-restart-rename + slug-history token acceptance the WS-upgrade
     * path (`validateStartToken`) already has, so a NEW-slug `?start` token
     * (the "Open your agent →" handoff button minted by a rename) is
     * accepted by a gateway that hasn't restarted to its new slug yet —
     * instead of 302→OAuth looping. See
     * `landing/auth-gate.ts:AuthGateOptions` for field semantics.
     */
    internal_handle?: string
    ownerRegistry?: {
      getCurrentUrlSlugByInternalHandle(internal_handle: string): string | null
    }
    slugHistoryStore?: {
      lookup(input: {
        old_slug: string
        internal_handle: string
        now_ms: number
      }): Promise<{ expires_at_ms: number } | null>
    }
  }
}
