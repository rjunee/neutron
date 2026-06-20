/**
 * @neutronai/runtime — OAuth PKCE helpers (Sprint B, 2026-05-20).
 *
 * Pure cryptographic helpers lifted out of `identity/oauth/pkce.ts` so
 * core modules (notably `gateway/http/cores-oauth-surface.ts`) can
 * generate PKCE verifiers + OAuth state tokens without taking an
 * import edge on the Managed `identity/` tree.
 *
 * Same implementation as the legacy module; the legacy file now
 * re-exports from here so any other consumer keeps working unchanged.
 */

import { createHash, randomBytes } from 'node:crypto'

/**
 * Generate a PKCE verifier (random 32-byte base64url) + S256 challenge
 * per RFC 7636. Both Google and Apple require S256 — plain is rejected
 * by Apple and discouraged by Google.
 */
export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

/** Generate a short opaque OAuth `state` parameter — anti-CSRF token. */
export function generateOAuthState(): string {
  return randomBytes(24).toString('base64url')
}
