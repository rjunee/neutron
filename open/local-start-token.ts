/**
 * @neutronai/open — single-owner local start-token (Sprint D).
 *
 * A self-contained HMAC start-token for the Open self-hosted single-owner
 * boot shell. It exists for ONE reason: to drive the chat-bridge's
 * `startSession` → `engine.start` path so a FRESH owner sees the first
 * onboarding prompt the instant the chat WebSocket connects (the same
 * first-prompt-on-connect product behaviour Managed gets from the identity
 * service's JWT start-token).
 *
 * This is NOT the Managed multi-instance JWT. There is:
 *   - no JWKS / jose / asymmetric signing (a single owner, one process,
 *     one shared secret — symmetric HMAC is sufficient and dependency-free),
 *   - no per-instance routing, no cross-instance claim, no slug-history shim.
 *
 * The token rides the existing `VerifyStartTokenFn` / `ClaimStartTokenJtiFn`
 * dependency-injection seam that `build-landing-stack.ts` already threads
 * from `platform.verifyStartToken` / `platform.claimStartTokenJti` into
 * `buildWebChatBridge`. The Open composer attaches the impls below to the
 * `LocalPlatformAdapter` so the bridge accepts our locally-minted token and
 * rejects everything else.
 *
 * Wire format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payload))>`.
 * The payload is the `ConsumedStartToken` shape the bridge consumes verbatim.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type {
  ClaimStartTokenJtiFn,
  ConsumedStartToken,
  VerifyStartTokenFn,
} from '../runtime/start-token-types.ts'

/** Single-owner start-token TTL — 15 min, mirrors the Managed JWT TTL. */
export const LOCAL_START_TOKEN_TTL_MS = 15 * 60 * 1000

export interface LocalStartTokenAuth {
  /** Mint a fresh one-shot start-token for the single owner. */
  mint(input: { project_slug: string; user_id: string }): string
  /** DI verifier — bound onto the platform adapter for the chat-bridge. */
  verifyStartToken: VerifyStartTokenFn
  /** DI atomic single-use claimer — bound onto the platform adapter. */
  claimStartTokenJti: ClaimStartTokenJtiFn
}

/**
 * Build the single-owner local start-token auth pair. `secret` is the same
 * `NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET` the session cookie uses — the box
 * has exactly one shared secret and one owner, so there is no benefit to a
 * second key.
 */
export function buildLocalStartTokenAuth(
  secret: string,
  now: () => number = (): number => Date.now(),
): LocalStartTokenAuth {
  function sign(body: string): string {
    return createHmac('sha256', secret).update(body).digest('base64url')
  }

  return {
    mint({ project_slug, user_id }): string {
      const payload: ConsumedStartToken = {
        // Single-owner: instance_slug === project_slug (frozen at boot).
        instance_slug: project_slug,
        project_slug,
        user_id,
        signup_via: 'web',
        jti: randomBytes(16).toString('hex'),
        expires_at_ms: now() + LOCAL_START_TOKEN_TTL_MS,
      }
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
      return `${body}.${sign(body)}`
    },

    async verifyStartToken({ token }): Promise<ConsumedStartToken> {
      const dot = token.lastIndexOf('.')
      if (dot <= 0) throw new Error('local start-token: malformed (no signature)')
      const body = token.slice(0, dot)
      const sig = token.slice(dot + 1)
      const expected = sign(body)
      const a = Buffer.from(sig)
      const b = Buffer.from(expected)
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new Error('local start-token: bad signature')
      }
      let payload: ConsumedStartToken
      try {
        payload = JSON.parse(
          Buffer.from(body, 'base64url').toString('utf8'),
        ) as ConsumedStartToken
      } catch {
        throw new Error('local start-token: unparseable payload')
      }
      if (
        typeof payload.expires_at_ms !== 'number' ||
        payload.expires_at_ms < now()
      ) {
        throw new Error('local start-token: expired')
      }
      if (payload.signup_via !== 'web') {
        throw new Error('local start-token: non-web channel')
      }
      return payload
    },

    // The bridge passes its own `consumedTokens` store in the input; we just
    // run the atomic claim against it. A second claim of the same jti throws,
    // which the bridge treats as a spent-token race (the cookie-resume net
    // recovers it).
    claimStartTokenJti: async ({ jti, expires_at_ms, consumedTokens }): Promise<void> => {
      const ok = await consumedTokens.claim(jti, expires_at_ms)
      if (!ok) throw new Error('local start-token: jti already consumed')
    },
  }
}
