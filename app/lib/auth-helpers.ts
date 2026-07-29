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
 * The runtime flows wrap these helpers around the platform calls they
 * inject: `lib/identity-client.ts` takes `fetch` + the browser-session
 * opener as parameters, and `app/app/login.tsx` supplies the Expo ones.
 */

/**
 * Guard an identity-service base URL before it is concatenated into a
 * request target (ISSUES #385).
 *
 * `auth_base_url` resolves to `''` whenever no identity service is
 * configured — it is OPTIONAL, and the gateway base being present is
 * what `loadAppConfig().configured` reports
 * (`app/lib/server-url.ts:resolveServerBases`). An empty base used to
 * silently produce a SCHEMELESS RELATIVE URL (`'/oauth/google/start?…'`,
 * `'/api/v1/install-token/exchange'`), which on web resolves against the
 * app's own origin and on native throws deep inside `fetch` with an
 * opaque message. Throw a named error at the boundary instead, so the
 * caller can say "no identity service configured".
 */
export function requireAuthBaseUrl(auth_base_url: string): string {
  const base = auth_base_url.trim().replace(/\/+$/, '');
  if (base.length === 0 || !/^https?:\/\//i.test(base)) {
    throw new Error('auth_base_url_not_configured');
  }
  return base;
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
 * Should the root entry hold the owner on `/login` instead of entering the app?
 *
 * THE LOGIN-FIRST INVARIANT, AS A VALUE. This is the whole of the decision
 * `app/app/index.tsx` makes on every launch, extracted so it can be ASSERTED
 * rather than described. It previously lived inline in that component, where the
 * only available coverage was matching the source line as a string — a test that
 * a prettier re-wrap breaks and that an INVERTED redirect still passes. The
 * component cannot be mounted in the test harness (it owns router and session
 * hooks), so the predicate moves out to where the harness can reach it. Same
 * remedy this branch already applied to the retry logic in `lib/login-stage.ts`.
 *
 * TWO INDEPENDENT REASONS TO HOLD, and the `!configured` one comes first:
 *
 *   1. `configured === false` — this install does not yet know WHERE its Neutron
 *      is. Until login-first, an unconfigured install never reached the router at
 *      all; `_layout.tsx` rendered a typed-URL gate instead of the `<Stack>`
 *      (ISSUES #385). That gate is gone, so this is now the thing keeping the
 *      #385 invariant: no screen that issues gateway requests may mount while
 *      unconfigured. `/login` issues none, which is why it is the safe hold.
 *   2. `shouldRedirectToLogin` — auth has RESOLVED to signed-out. Never a bare
 *      `user === null`: that is true mid-hydration for a signed-IN install and
 *      would flash /login on every cold start.
 *
 * Signed in but unconfigured still holds. A persisted session says who the owner
 * is, not where their instance lives, and entering with a session but no gateway
 * base is exactly the state that produced #385's loopback dial.
 */
export function shouldHoldOnLogin(input: {
  configured: boolean;
  status: 'hydrating' | 'ready';
  user: unknown;
}): boolean {
  if (!input.configured) return true;
  return shouldRedirectToLogin(input);
}

/**
 * Parse the OAuth redirect the PROVIDER sends back to this app.
 *
 * The app opens the identity service's `authorizeUrl` in a browser session
 * with its own `redirect_uri`, so the URL that ends the session is a standard
 * authorization-code redirect: `neutron://oauth/callback?code=…&state=…` on
 * native, the same query string in-page on web. The `code` is then spent on
 * `POST {auth_base}/v1/oauth/<provider>/exchange`.
 *
 * A provider that refuses consent redirects with `error=…` instead of `code`;
 * that is reported as its own named failure rather than "missing code", so the
 * login screen can say what actually happened.
 */
export function parseOauthCallback(callbackUrl: string): {
  code: string;
  state: string;
} {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error('oauth_callback_url_invalid');
  }
  const providerError = url.searchParams.get('error');
  if (providerError !== null && providerError.length > 0) {
    throw new Error(`oauth_callback_provider_error:${providerError}`);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code === null || code.length === 0) {
    throw new Error('oauth_callback_missing_code');
  }
  if (state === null || state.length === 0) {
    throw new Error('oauth_callback_missing_state');
  }
  return { code, state };
}

/**
 * Read `sub` out of a JWT payload WITHOUT verifying the signature.
 *
 * The server is authoritative on validity — this is only used to learn which
 * identity a token the app was just handed belongs to, so the app can key its
 * own local state on the same value the token asserts. Returns `null` for
 * anything that isn't a three-part token with a string `sub`; callers must
 * handle that rather than substituting a guess.
 */
export function decodeJwtSub(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1] ?? '')) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * The stable identity for the single owner of a Neutron install. Matches the
 * `user_id` the gateway reports in its app-ws `session_ready` frame, so the
 * client's derived topic (`app:${OWNER_IDENTITY}`) equals the server's.
 */
export const OWNER_IDENTITY = 'owner';

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
 *
 * AN OPAQUE BEARER IS NOT AN IDENTITY (ISSUES #398, and #395 before it).
 * This used to `return token` when the value was neither `dev:<id>` nor a
 * JWT — which is exactly the shape of the per-install owner bearer. That
 * made the CREDENTIAL the user id, and the user id is used as an identity in
 * three places: the display name (#395 — the token was rendered on screen and
 * reached a screenshot), the local chat store key (`app:${user.id}`, both
 * `use-mobile-chat.ts` and `ChatSyncSurface.tsx`), and the synthetic email.
 *
 * The store consequence was the severe one and it is REPRODUCED: the local
 * store's PK is `(topic_id, identity)`, so when the bearer changed the device
 * partitioned its own history into a namespace nothing reads again — every
 * project rendered EMPTY while the rows sat in the DB under the old key.
 *
 * An opaque bearer therefore resolves to the STABLE owner identity. Neutron
 * Open is single-owner and the gateway already reports exactly this: its
 * `session_ready` frame carries `user_id: "owner"` / `topic_id: "app:owner"`.
 * Returning it makes the client agree with the server by construction and
 * makes the storage key independent of credential rotation.
 */
export function parseDevTokenUserId(token: string): string {
  if (token.startsWith('dev:')) {
    return token.slice('dev:'.length);
  }
  // `decodeJwtSub` (this file) is the shared decoder — login-first's discovered
  // bearer IS a JWT and its `sub` is the real identity.
  const sub = decodeJwtSub(token);
  if (sub !== null) return sub;
  // Neither `dev:<id>` nor a JWT ⇒ an opaque owner bearer. Return the STABLE
  // owner identity, NEVER the credential. Returning the token here was ISSUES
  // #398: the id changed every rotation, so the topic key changed with it and
  // the transcript was orphaned. A bearer is not an identity.
  return OWNER_IDENTITY;
}

/**
 * Decode URL-safe base64 to a binary string.
 *
 * The matching `base64UrlEncode` and `hexToBase64Url` were deleted with this
 * branch's PKCE move: the client no longer mints a code challenge (the identity
 * service owns the verifier now — `lib/identity-client.ts` `startOauth`), so
 * nothing in production encoded anything and only their own unit tests kept them
 * alive. Decoding stays because `isTokenExpired` reads a JWT payload locally.
 */
export function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const b64 = padded + pad;
  if (typeof atob === 'function') return atob(b64);
  return Buffer.from(b64, 'base64').toString('binary');
}
