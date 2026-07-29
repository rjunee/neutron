/**
 * @neutronai/app — the SELF-HOST sign-in lane + the shared `AuthUser` shape.
 *
 * WHAT LIVES HERE (and what does not). Central-identity sign-in — provider
 * (Google/Apple) and email+password — plus instance discovery all live in
 * `lib/identity-client.ts`. This file keeps only the lane that needs NO
 * identity service at all: pasting the access token the harness prints on
 * `neutron start` (`bin/neutron:82`), which the gateway accepts directly.
 *
 * That lane is REQUIRED, not a convenience: a self-hoster runs no identity
 * service, so there is nothing for them to sign in against and manual entry can
 * never be removed. It exits through the same `setUser(...)` path the identity
 * lanes do, so everything downstream sees one session shape.
 *
 * WHAT WAS DELETED (2026-07-25). An earlier OAuth implementation lived here,
 * built against `<auth-base>/oauth/<p>/start` + `/api/v1/install-token/exchange`
 * — paths no identity service serves — and had ZERO call sites. Two OAuth
 * implementations, one of them pointing nowhere, is the dual-code-path trap:
 * the live one is `signInWithOauth` in `lib/identity-client.ts` and it is the
 * only one.
 *
 * Pure helpers (callback parsing, base64-url, JWT `sub` peeking, dev-token
 * parsing) live in `lib/auth-helpers.ts` — free of `react-native` and Expo SDK
 * imports so unit tests exercise them under `bun test`.
 */

import { parseDevTokenUserId } from './auth-helpers';

/**
 * Which lane produced this session. `'google'` / `'apple'` / `'password'` are
 * the LOGIN-FIRST lanes: the owner signs in at central identity and the app then
 * DISCOVERS its own instance address via `/v1/route` (`lib/identity-client.ts`).
 * `'dev'` is the self-host lane — paste the token the gateway printed.
 */
export type AuthProvider = 'google' | 'apple' | 'dev' | 'password';

/**
 * Human-facing label used when no real display name is known. Deliberately not
 * derived from the token or user id — see `signInWithDevToken` (ISSUES #395).
 */
export const OWNER_FALLBACK_DISPLAY_NAME = 'Owner';

export interface AuthUser {
  /**
   * The identity the instance sees this device as — the `sub` of `token`. NOT
   * an instance slug: local state and the `app:<user>` topic carried on ZIP
   * imports are keyed off this, so a non-identity value here misroutes them.
   */
  id: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  /**
   * Bearer token used by every authenticated client surface. Self-hosting, a
   * `dev:<user_id>` opaque token or a pasted HS256 JWT; via central identity,
   * the instance-scoped RS256 JWT `/v1/route` minted, which the gateway
   * verifies against the identity service's published JWKS.
   */
  token: string;
}

/** Public API — the self-host dev-token paste-in lane. */

export async function signInWithDevToken(input: {
  token: string;
  display_name?: string;
}): Promise<AuthUser> {
  const trimmed = input.token.trim();
  if (trimmed.length === 0) {
    throw new Error('dev token is required');
  }
  const user_id = parseDevTokenUserId(trimmed);
  return {
    id: user_id,
    email: `${user_id}@dev.localhost`,
    // NEVER fall back to `user_id` here (ISSUES #395). For an opaque owner
    // bearer, `parseDevTokenUserId` returns the TOKEN ITSELF, so this field —
    // rendered as the account name in the Projects header — displayed the live
    // credential on screen. It reached a chat log that way, which is how the
    // bug was found. A neutral label is always safe; a credential-derived one
    // never is.
    displayName: input.display_name ?? OWNER_FALLBACK_DISPLAY_NAME,
    provider: 'dev',
    token: trimmed,
  };
}

export async function signOut(): Promise<void> {
  // The persisted blobs are wiped via `AuthSessionProvider.clear()`;
  // this is left in the public API for callers that want an explicit
  // server-side revocation hook later. P5.0 leaves it as a no-op.
}

// Re-exported so callers that imported it from `./auth` keep compiling.
export { parseDevTokenUserId };
