/**
 * @neutronai/app — pure auth helpers (P5.0).
 *
 * Extracted from `lib/auth.ts` so they can be unit-tested under
 * `bun test` without pulling in the React Native bridge or the
 * Expo SDK modules that the runtime auth flow depends on
 * (`expo-web-browser`, `expo-crypto`, `expo-linking`).
 *
 * Anything in this file is:
 *   - Deterministic (no `Date.now`, no random)
 *   - Free of side effects
 *   - Free of platform-bound imports
 *
 * The runtime auth flow in `lib/auth.ts` wraps these helpers around
 * the platform calls (UUID generation, code-verifier randomness,
 * SHA-256, `openAuthSessionAsync`, `fetch`) it injects via the
 * `deps` parameter on `signInWithOauthProvider`.
 */

/**
 * Build the `oauth/<provider>/start` URL the WebBrowser session
 * opens. Mirror of the identity-service contract per § 4.4 of the
 * P5.0 brief. The identity service expects all six query params.
 */
export function buildStartUrl(input: {
  auth_base_url: string;
  provider: 'google' | 'apple';
  challenge: string;
  state: string;
  redirect_uri: string;
  platform: 'web' | 'native';
}): string {
  const base = `${input.auth_base_url.replace(/\/+$/, '')}/oauth/${input.provider}/start`;
  const params = new URLSearchParams({
    response_type: 'code',
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    redirect_uri: input.redirect_uri,
    platform: input.platform,
  });
  return `${base}?${params.toString()}`;
}

/**
 * Decide whether an auth-gated screen should redirect to `/login`.
 *
 * The session provider starts in `'hydrating'` (reading the persisted token
 * from storage) and flips to `'ready'` once that resolves. During hydration
 * `user` is transiently `null` even for a signed-in user, so a guard that
 * redirects on `user === null` ALONE bounces an authenticated user to /login
 * on a direct load / refresh / deep-link before the token finishes loading.
 *
 * Redirect ONLY once auth has RESOLVED to genuinely-unauthenticated, i.e.
 * `status === 'ready' && user === null`. This is the shared guard behind both
 * `app/settings.tsx` and `app/integrations.tsx` (Argus PR #13 BLOCKING).
 */
export function shouldRedirectToLogin(input: {
  status: 'hydrating' | 'ready';
  user: unknown;
}): boolean {
  return input.status === 'ready' && input.user === null;
}

/**
 * Parse the OAuth callback URL the identity service emits. The
 * landing page either deep-links to `neutron://oauth/callback?token=…&state=…`
 * (native) or hands the same query string to the in-page callback
 * handler (web). Either way the parser expects a `token` (or
 * `install_token`) param and a `state` param.
 */
export function parseOauthCallback(callbackUrl: string): {
  install_token: string;
  state: string;
} {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error('oauth_callback_url_invalid');
  }
  const install_token = url.searchParams.get('token') ?? url.searchParams.get('install_token');
  const state = url.searchParams.get('state');
  if (install_token === null || install_token.length === 0) {
    throw new Error('oauth_callback_missing_token');
  }
  if (state === null || state.length === 0) {
    throw new Error('oauth_callback_missing_state');
  }
  return { install_token, state };
}

/**
 * Decode the user id from a dev token. The login screen exposes a
 * dev-token paste-in lane (`/login` § 4.4) — the engineer pastes
 * either a `dev:<user_id>` opaque token or an HS256 JWT (signed by
 * the gateway's `NEUTRON_APP_WS_DEV_SECRET`); the gateway side
 * validates, the client side just extracts an id for display.
 *
 * The client does NOT verify the JWT signature — the gateway is
 * authoritative. We only peek at `payload.sub` for the displayName
 * fallback.
 */
export function parseDevTokenUserId(token: string): string {
  if (token.startsWith('dev:')) {
    return token.slice('dev:'.length);
  }
  if (token.split('.').length === 3) {
    try {
      const payload_b64 = token.split('.')[1] ?? '';
      const payload = JSON.parse(base64UrlDecode(payload_b64)) as { sub?: unknown };
      if (typeof payload.sub === 'string' && payload.sub.length > 0) {
        return payload.sub;
      }
    } catch {
      // ignore — fall through
    }
  }
  return token;
}

/** Encode a `Uint8Array` as URL-safe base64 (no padding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const b64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode URL-safe base64 to a binary string. */
export function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const b64 = padded + pad;
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('binary');
}

/** Convert hex (the encoding `expo-crypto` returns) to URL-safe base64. */
export function hexToBase64Url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return base64UrlEncode(bytes);
}
