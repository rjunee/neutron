/**
 * @neutronai/app — central-identity HTTP client: sign in, then DISCOVER
 * which instance this app belongs to (login-first flow).
 *
 * WHY THIS EXISTS. Before this module the only way an install learned its
 * gateway address was for the owner to TYPE it: ISSUES #385 added the
 * runtime server URL + the "Connect to your Neutron" form, and
 * `app/app/_layout.tsx` made that form the FIRST-RUN surface. Ryan:
 * *"why does it have to ask? it should just open with a login screen, and
 * once you login it should know the url."* So the app now opens on LOGIN
 * and learns its own address from the identity service afterwards. Typing
 * a URL survives as the SELF-HOST path (a self-hoster runs no identity
 * service, so manual entry can never be removed) — see
 * `app/app/login.tsx`'s self-host section.
 *
 * THE SERVER SIDE ALREADY EXISTS — this file only CONSUMES it. Two
 * endpoints on the identity service (`loadAppConfig().auth_base_url`,
 * resolved from `extra.neutron_auth_base_url` →
 * `EXPO_PUBLIC_NEUTRON_AUTH_BASE_URL`; NEVER hardcoded, and there is no
 * baked instance address anywhere in this repo):
 *
 *   POST /v1/login                     {email, password}
 *                                      → {account, accessToken, refreshToken}
 *   POST /v1/oauth/<provider>/start    {redirectUri}
 *                                      → {authorizeUrl, state, codeVerifier}
 *   POST /v1/oauth/<provider>/exchange {code, redirectUri, codeVerifier}
 *                                      → {account, accessToken, refreshToken}
 *   POST /v1/auth/refresh              {refreshToken}
 *                                      → {accessToken, refreshToken}
 *   POST /v1/route  {slug?} + Bearer   → {slug, publicUrl, upstreamUrl, accessToken, claims}
 *
 * THE OAUTH LANE IS NOT OPTIONAL. Password sign-in alone strands a real owner:
 * an account created through the provider front door is stored with NO usable
 * password hash and there is no password-set or reset endpoint, so typing an
 * email + any password returns 401 forever and discovery never runs. Whichever
 * way the owner made their account, they must be able to get in — hence
 * `signInWithOauth` alongside `signInWithPassword`.
 *
 * TWO DIFFERENT TOKENS — do not conflate them:
 *
 *   - `/v1/login`'s `accessToken` is ACCOUNT-scoped (`sub` only). Its ONLY
 *     job is to authenticate the `/v1/route` call. It is never persisted
 *     as the gateway bearer.
 *   - `/v1/route`'s `accessToken` is INSTANCE-scoped (`sub` + `slug`); the
 *     instance verifies that `slug` against its own identity. THIS is the
 *     token the app persists as the session and sends to the gateway.
 *
 * ⚠ `upstreamUrl` IS DELIBERATELY NOT PART OF `DiscoveredInstance`. It is
 * the identity service's INTERNAL loopback target (`http://127.0.0.1:<port>`
 * — the reverse-proxy upstream on the box, meaningful only to processes
 * running there). A phone that adopted it would dial its OWN loopback,
 * which is precisely the failure ISSUES #385 fixed. `discoverInstance`
 * reads `publicUrl` and NOTHING else addressable, so the bug cannot be
 * reintroduced by a caller picking the wrong field — the field never
 * leaves this file.
 *
 * PURE-ISH BY DESIGN: no `react-native`, no Expo SDK imports, `fetch`
 * injectable — so `app/__tests__/login-first-discovery.test.ts` exercises
 * the REAL module (not a re-implementation) under `bun test`.
 */

import {
  base64UrlDecode,
  decodeJwtSub,
  parseOauthCallback,
  requireAuthBaseUrl,
} from './auth-helpers';
import {
  commitServerConfig,
  normalizeServerUrl,
  type CommitServerConfigResult,
  type ServerConfigStore,
} from './server-url';

/** `POST {auth_base}/v1/login` — verified against the live control plane. */
export const LOGIN_PATH = '/v1/login';
/** `POST {auth_base}/v1/route` — verified against the live control plane. */
export const ROUTE_PATH = '/v1/route';
/** `POST {auth_base}/v1/auth/refresh` — rotates the refresh token. */
export const REFRESH_PATH = '/v1/auth/refresh';

/**
 * Default budget for an identity-service call. Deliberately shorter than
 * the `/healthz` probe budget: this is a request to a public HTTPS
 * service, not a LAN host that might be slow to answer.
 */
const DEFAULT_IDENTITY_TIMEOUT_MS = 10_000;

/**
 * Whether this build has an identity service to sign in against.
 *
 * The SAME predicate the request path uses (`requireAuthBaseUrl`), exposed
 * so the login screen's rendering decision and the client's behaviour can
 * never disagree — a screen that offers a sign-in form the client would
 * refuse to send is the dishonest-degradation case this avoids.
 */
export function isIdentityConfigured(auth_base_url: string): boolean {
  try {
    requireAuthBaseUrl(auth_base_url);
    return true;
  } catch {
    return false;
  }
}

/** The account-scoped result of a successful sign-in (password or OAuth). */
export interface IdentitySession {
  user_id: string;
  email: string;
  /**
   * ACCOUNT-scoped bearer. Used ONLY to call `/v1/route` — never
   * persisted as the gateway bearer, never sent to a gateway. See the header.
   */
  session_token: string;
  /**
   * Long-lived, single-use refresh token. The account-scoped bearer above and
   * the instance-scoped one derived from it are SHORT-LIVED, so without this
   * the owner would have to retype credentials once the access token aged out.
   * `refreshIdentitySession` spends it; the service rotates it on every
   * redemption, so the value returned must replace the one used.
   */
  refresh_token: string | null;
}

/**
 * What the app is allowed to learn about its own instance. `publicUrl` is
 * already normalised (`normalizeServerUrl`) and is the ONLY address here
 * by construction — `upstreamUrl` is never surfaced.
 */
export interface DiscoveredInstance {
  slug: string;
  /** `https://<slug>.<base-domain>`, composed server-side. */
  publicUrl: string;
  /** INSTANCE-scoped bearer — this is what becomes the session token. */
  accessToken: string;
  /**
   * The `sub` of `accessToken` — the identity the instance will see this
   * device as. Read off the token itself (unverified; the instance is
   * authoritative) so the app keys its local state on the SAME value the
   * bearer asserts rather than on something adjacent like the instance slug,
   * which is not an identity and misroutes every user-derived identifier.
   * `null` when the token carries no readable `sub`.
   */
  userId: string | null;
}

/**
 * Every way sign-in or discovery can fail, as a CLOSED set the UI
 * switches on. Each one has a distinct on-screen state in
 * `app/app/login.tsx`; there is no "unknown, show a spinner forever" case.
 */
export type IdentityFailure =
  /** No identity service in this build — offer the self-host path. */
  | { kind: 'identity_not_configured' }
  /** 401 — bad credentials, or a session token the service rejected. */
  | { kind: 'unauthorized' }
  /** The owner closed the provider's browser sheet. Not an error state. */
  | { kind: 'oauth_cancelled' }
  /** This identity service does not offer that provider (404 on start). */
  | { kind: 'oauth_unavailable'; provider: IdentityOauthProvider }
  /** The provider round-trip itself failed (denied consent, bad redirect). */
  | { kind: 'oauth_failed'; detail: string }
  /** 404 + `userId` — the account owns no active instance yet. */
  | { kind: 'no_instance' }
  /** 409 + `slugs` — several instances; render a picker. */
  | { kind: 'ambiguous'; slugs: string[] }
  /** 404 + `slug` — the chosen slug is not (any longer) ours. */
  | { kind: 'not_owned'; slug: string }
  /** Transport-level: DNS, offline, TLS, timeout. Retryable. */
  | { kind: 'unreachable' }
  /** Anything else the service said, including an unusable body. */
  | { kind: 'server'; status: number };

export type IdentityResult<T> =
  | { ok: true; value: T }
  /** `message` is owner-facing copy; `failure` is what the UI branches on. */
  | { ok: false; failure: IdentityFailure; message: string };

export interface IdentityRequestOptions {
  auth_base_url: string;
  fetchFn?: typeof globalThis.fetch;
  timeout_ms?: number;
}

/**
 * `POST /v1/login`. Returns the ACCOUNT-scoped session, which the caller
 * immediately spends on `discoverInstance`.
 */
export async function signInWithPassword(
  input: IdentityRequestOptions & { email: string; password: string },
): Promise<IdentityResult<IdentitySession>> {
  const email = input.email.trim();
  if (email.length === 0 || input.password.length === 0) {
    return {
      ok: false,
      failure: { kind: 'unauthorized' },
      message: 'Enter the email and password for your Neutron account.',
    };
  }
  return withIdentityRequest(input, LOGIN_PATH, { email, password: input.password }, null, 'password', (body) =>
    parseSession(body, email),
  );
}

/** The providers this client knows how to drive. */
export type IdentityOauthProvider = 'google' | 'apple';

export function oauthStartPath(provider: IdentityOauthProvider): string {
  return `/v1/oauth/${provider}/start`;
}

export function oauthExchangePath(provider: IdentityOauthProvider): string {
  return `/v1/oauth/${provider}/exchange`;
}

/**
 * How the platform opens the provider's consent page. Modelled as a parameter
 * (Expo's `WebBrowser.openAuthSessionAsync` shape) so this module stays free of
 * `react-native` / Expo imports and the whole lane is testable under
 * `bun test`. `app/app/login.tsx` supplies the real one.
 */
export type OpenAuthSession = (
  authorizeUrl: string,
  redirectUri: string,
) => Promise<{ type: string; url?: string | null }>;

/**
 * Sign in with Google / Apple, ending in the same ACCOUNT-scoped
 * `IdentitySession` the password lane produces — so discovery is identical
 * afterwards and there is only ONE post-sign-in path.
 *
 * THE SERVICE OWNS PKCE. `/v1/oauth/<p>/start` generates and returns both the
 * `state` and the `codeVerifier`; this client's job is to open the returned
 * `authorizeUrl`, check `state` on the way back, and replay the verifier on
 * exchange. It deliberately does NOT mint its own challenge — doing so would
 * mean re-deriving a protocol the service already implements, and the two
 * copies would drift.
 */
export async function signInWithOauth(
  input: IdentityRequestOptions & {
    provider: IdentityOauthProvider;
    /** This app's own deep link, e.g. `neutron://oauth/callback`. */
    redirect_uri: string;
    openAuthSession: OpenAuthSession;
  },
): Promise<IdentityResult<IdentitySession>> {
  const started = await withIdentityRequest<{
    authorizeUrl: string;
    state: string;
    codeVerifier: string;
  }>(
    input,
    oauthStartPath(input.provider),
    { redirectUri: input.redirect_uri },
    null,
    // Starting an OAuth flow presents no credential at all; a 401 here is the
    // service refusing to begin, which the owner retries rather than re-types.
    'oauth_code',
    (body) => {
      const authorizeUrl = body['authorizeUrl'];
      const state = body['state'];
      const codeVerifier = body['codeVerifier'];
      if (
        typeof authorizeUrl !== 'string' ||
        authorizeUrl.length === 0 ||
        typeof state !== 'string' ||
        state.length === 0 ||
        typeof codeVerifier !== 'string' ||
        codeVerifier.length === 0
      ) {
        return {
          ok: false,
          failure: { kind: 'server', status: 200 },
          message: 'The identity service could not start sign-in for that provider.',
        };
      }
      return { ok: true, value: { authorizeUrl, state, codeVerifier } };
    },
  );
  if (!started.ok) {
    // A 404 here means this service offers no such provider — a distinct,
    // non-retryable condition from "the service is down".
    if (started.failure.kind === 'server' && started.failure.status === 404) {
      return {
        ok: false,
        failure: { kind: 'oauth_unavailable', provider: input.provider },
        message: `${providerLabel(input.provider)} sign-in is not available on this account service. Use your email and password, or connect to your instance directly below.`,
      };
    }
    return started;
  }

  let result: Awaited<ReturnType<OpenAuthSession>>;
  try {
    result = await input.openAuthSession(started.value.authorizeUrl, input.redirect_uri);
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'oauth_failed', detail: err instanceof Error ? err.message : String(err) },
      message: `Could not open ${providerLabel(input.provider)} sign-in. Try again, or use your email and password.`,
    };
  }
  if (result.type !== 'success' || typeof result.url !== 'string') {
    // 'cancel' / 'dismiss' are the owner backing out, not a fault. Everything
    // else (a locked browser, an OS refusal) is reported as a real failure.
    if (result.type === 'cancel' || result.type === 'dismiss') {
      return {
        ok: false,
        failure: { kind: 'oauth_cancelled' },
        message: 'Sign-in was cancelled.',
      };
    }
    return {
      ok: false,
      failure: { kind: 'oauth_failed', detail: result.type },
      message: `${providerLabel(input.provider)} sign-in did not complete. Try again, or use your email and password.`,
    };
  }

  let callback: { code: string; state: string };
  try {
    callback = parseOauthCallback(result.url);
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'oauth_failed', detail: err instanceof Error ? err.message : String(err) },
      message: `${providerLabel(input.provider)} did not return a usable sign-in code. Try again, or use your email and password.`,
    };
  }
  // CSRF: the redirect must carry back the exact `state` the service issued.
  if (callback.state !== started.value.state) {
    return {
      ok: false,
      failure: { kind: 'oauth_failed', detail: 'state_mismatch' },
      message: 'That sign-in could not be verified as yours. Start again.',
    };
  }

  return withIdentityRequest(
    input,
    oauthExchangePath(input.provider),
    {
      code: callback.code,
      redirectUri: input.redirect_uri,
      codeVerifier: started.value.codeVerifier,
    },
    null,
    'oauth_code',
    (body) => parseSession(body, ''),
  );
}

/**
 * Spend a refresh token for a fresh ACCOUNT-scoped bearer.
 *
 * The service ROTATES on every redemption and treats reuse of an already-spent
 * token as theft (it revokes the whole family), so the caller MUST replace the
 * stored value with the one returned here and must never retry with the old one.
 *
 * The reply carries no account record, so the caller supplies the identity it
 * already knows — this call refreshes a session, it does not establish one.
 */
export async function refreshIdentitySession(
  input: IdentityRequestOptions & {
    refresh_token: string;
    user_id: string;
    email: string;
  },
): Promise<IdentityResult<IdentitySession>> {
  return withIdentityRequest(
    input,
    REFRESH_PATH,
    { refreshToken: input.refresh_token },
    null,
    // A refresh token IS the session credential — a 401 here means the session
    // is gone (expired, revoked, or a detected reuse), not a mistyped password.
    'session',
    (body) => {
      const token = body['accessToken'];
      if (typeof token !== 'string' || token.length === 0) {
        return {
          ok: false,
          failure: { kind: 'server', status: 200 },
          message: 'The identity service could not renew this session.',
        };
      }
      const next = body['refreshToken'];
      return {
        ok: true,
        value: {
          user_id: input.user_id,
          email: input.email,
          session_token: token,
          refresh_token: typeof next === 'string' && next.length > 0 ? next : null,
        },
      };
    },
  );
}

/** `{account, accessToken, refreshToken}` — the shape all three sign-in replies share. */
function parseSession(
  body: Record<string, unknown>,
  fallbackEmail: string,
): IdentityResult<IdentitySession> {
  const account = asRecord(body['account']);
  const token = body['accessToken'];
  const user_id = account === null ? undefined : account['user_id'];
  if (typeof token !== 'string' || token.length === 0 || typeof user_id !== 'string') {
    return {
      ok: false,
      failure: { kind: 'server', status: 200 },
      message: 'Signed in, but the identity service sent a reply this app could not read.',
    };
  }
  const accountEmail =
    account !== null && typeof account['email'] === 'string' ? account['email'] : fallbackEmail;
  const refresh = body['refreshToken'];
  return {
    ok: true,
    value: {
      user_id,
      email: accountEmail,
      session_token: token,
      refresh_token: typeof refresh === 'string' && refresh.length > 0 ? refresh : null,
    },
  };
}

function providerLabel(provider: IdentityOauthProvider): string {
  return provider === 'google' ? 'Google' : 'Apple';
}

/**
 * `POST /v1/route` — ask the identity service where this owner's instance
 * lives, and get a token scoped to it.
 *
 * `slug` is omitted on the first call: an owner with exactly one active
 * instance is auto-routed server-side, which is the whole point (zero
 * typing in the happy path). Pass a slug only to resolve an
 * `ambiguous` failure via the picker.
 */
export async function discoverInstance(
  input: IdentityRequestOptions & { session_token: string; slug?: string },
): Promise<IdentityResult<DiscoveredInstance>> {
  const payload = input.slug === undefined ? {} : { slug: input.slug };
  return withIdentityRequest(input, ROUTE_PATH, payload, input.session_token, 'session', (body) => {
    const slug = body['slug'];
    const rawPublicUrl = body['publicUrl'];
    const accessToken = body['accessToken'];
    if (
      typeof slug !== 'string' ||
      slug.length === 0 ||
      typeof rawPublicUrl !== 'string' ||
      typeof accessToken !== 'string' ||
      accessToken.length === 0
    ) {
      return unreadableRouteReply();
    }
    // Normalise (and thereby VALIDATE) the address before it can become
    // this app's gateway base. A `publicUrl` that isn't an origin is
    // treated as an unusable reply rather than adopted — the app must
    // never point itself at something it could not parse.
    const publicUrl = normalizeServerUrl(rawPublicUrl);
    if (publicUrl === null) return unreadableRouteReply();
    // `body['upstreamUrl']` is IGNORED here and on purpose — see the file
    // header. The loopback target never reaches a caller.
    return { ok: true, value: { slug, publicUrl, accessToken, userId: decodeJwtSub(accessToken) } };
  });
}

function unreadableRouteReply(): IdentityResult<never> {
  return {
    ok: false,
    failure: { kind: 'server', status: 200 },
    message:
      'The identity service did not say where your instance lives. Try again, or connect to it directly below.',
  };
}

/**
 * Persist a discovered instance as THE gateway base, through the SAME
 * normalise → `/healthz` → persist path the typed-URL form uses
 * (`commitServerConfig`). There is deliberately no second writer: the
 * discovered host is health-checked exactly like a typed one, so a
 * provisioned-but-not-yet-serving instance surfaces a real error instead
 * of a broken "connected" state.
 *
 * The existing `auth_base_url` is threaded through so adopting an
 * instance never drops the identity service that found it.
 *
 * ORDER MATTERS AT THE CALL SITE: `commitServerConfig` WIPES the
 * persisted session whenever the host changes (a token minted by another
 * instance is worthless here). So the caller must adopt FIRST and set the
 * session SECOND — otherwise this call would delete the instance-scoped
 * token it was just handed. See `enterWithInstance` in `app/app/login.tsx`.
 */
export async function adoptDiscoveredInstance(input: {
  instance: DiscoveredInstance;
  auth_base_url: string;
  previous_gateway_base_url: string;
  store: ServerConfigStore;
  fetchFn?: typeof globalThis.fetch;
  timeout_ms?: number;
}): Promise<CommitServerConfigResult> {
  return commitServerConfig({
    gateway_raw: input.instance.publicUrl,
    auth_raw: input.auth_base_url,
    previous_gateway_base_url: input.previous_gateway_base_url,
    store: input.store,
    ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
    ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
  });
}

/**
 * Is this bearer past (or within `skew_ms` of) its own `exp`?
 *
 * Read LOCALLY, with no network call, so the launch path can decide whether a
 * renewal is even needed before spending a request on it. `false` for a token
 * with no readable `exp`: the server is authoritative on validity, and guessing
 * "expired" would sign a working session out.
 */
export function isTokenExpired(
  token: string,
  now_ms: number,
  skew_ms = 60_000,
): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1] ?? '')) as { exp?: unknown };
    if (typeof payload.exp !== 'number') return false;
    return payload.exp * 1_000 <= now_ms + skew_ms;
  } catch {
    return false;
  }
}

export type RenewalOutcome =
  /** The persisted bearer is still good (or unreadable) — leave it alone. */
  | { kind: 'not_needed' }
  /** A fresh instance bearer + the rotated refresh token to persist. */
  | { kind: 'renewed'; token: string; instance: DiscoveredInstance; refresh_token: string | null }
  /** Renewal is impossible; the owner must sign in again. `reason` is for logs. */
  | { kind: 'sign_in_required'; reason: string; rotated_refresh_token?: string | null }
  /**
   * A transient failure (offline, 5xx). Do NOT sign the owner out — the token
   * may well still be accepted, and if it isn't the next launch retries.
   *
   * `rotated_refresh_token` IS PRESENT WHENEVER THE REFRESH HOP ALREADY
   * SUCCEEDED and the failure came later (the `/v1/route` hop). The caller MUST
   * persist it. Refresh tokens ROTATE: the moment the service answers the
   * refresh, the token we presented is revoked and this one replaces it. Dropping
   * it — which this type used to force, having nowhere to put it — means the next
   * launch replays a REVOKED token, the service revokes the whole family as a
   * reuse attack, and the owner is thrown back to credentials. That is precisely
   * the "being on a train at launch cannot log anyone out" guarantee inverted:
   * one flaky route hop would log them out permanently. `undefined` means the
   * refresh never happened, so nothing rotated and there is nothing to save.
   */
  | { kind: 'deferred'; reason: string; rotated_refresh_token?: string | null };

/**
 * Renew an aged-out login-first session end to end: refresh the ACCOUNT bearer,
 * re-route to the SAME instance, and hand back the new instance bearer.
 *
 * WHY THIS EXISTS. The instance bearer the app persists is short-lived. Without
 * renewal, "sign in once and the app knows your instance" quietly becomes
 * "retype your password every day" — the discovery work would be undone by the
 * clock. This is the whole cadence in one pure-ish function (fetch injected) so
 * the launch path is a call, not a state machine.
 *
 * It deliberately does NOT re-adopt the server config: renewal re-routes to the
 * slug this device already adopted, so the gateway base does not change and
 * rewriting it would needlessly trip the host-changed session wipe.
 */
export async function renewInstanceSession(
  input: IdentityRequestOptions & {
    /** The currently persisted gateway bearer. */
    token: string;
    session: {
      user_id: string;
      email: string;
      refresh_token: string | null;
      slug: string;
    };
    now_ms: number;
  },
): Promise<RenewalOutcome> {
  if (!isTokenExpired(input.token, input.now_ms)) return { kind: 'not_needed' };
  if (input.session.refresh_token === null) {
    return { kind: 'sign_in_required', reason: 'no_refresh_token' };
  }
  const refreshed = await refreshIdentitySession({
    auth_base_url: input.auth_base_url,
    ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
    ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
    refresh_token: input.session.refresh_token,
    user_id: input.session.user_id,
    email: input.session.email,
  });
  if (!refreshed.ok) return classifyRenewalFailure(refreshed.failure.kind);

  const routed = await discoverInstance({
    auth_base_url: input.auth_base_url,
    ...(input.fetchFn === undefined ? {} : { fetchFn: input.fetchFn }),
    ...(input.timeout_ms === undefined ? {} : { timeout_ms: input.timeout_ms }),
    session_token: refreshed.value.session_token,
    // Pin the SAME instance. Omitting the slug would silently move a
    // multi-instance owner's device to whichever one auto-routing picks.
    slug: input.session.slug,
  });
  // PAST THIS POINT THE PRESENTED REFRESH TOKEN IS ALREADY REVOKED. The service
  // rotated it when it answered above, so every exit from here on has to carry
  // the replacement out to the caller — including the failure exits. See
  // `RenewalOutcome.deferred.rotated_refresh_token`.
  if (!routed.ok) {
    return classifyRenewalFailure(routed.failure.kind, refreshed.value.refresh_token);
  }
  return {
    kind: 'renewed',
    token: routed.value.accessToken,
    instance: routed.value,
    refresh_token: refreshed.value.refresh_token,
  };
}

/**
 * Split renewal failures into "the owner has to act" and "try again later".
 * Getting this wrong in the permissive direction strands the owner; getting it
 * wrong in the strict direction signs them out every time they open the app on
 * a train. Only a credential the service actively refused forces sign-in.
 *
 * `rotated` is the refresh token the service handed back if the refresh hop had
 * already succeeded before this failure — it is threaded through UNCHANGED so no
 * exit path can silently drop a rotation. Omitted when the refresh itself failed
 * (nothing rotated). `null` is a real value the service can return and is
 * preserved as such; only `undefined` means "no rotation happened".
 */
function classifyRenewalFailure(
  kind: IdentityFailure['kind'],
  rotated?: string | null,
): RenewalOutcome {
  const carry = rotated === undefined ? {} : { rotated_refresh_token: rotated };
  if (kind === 'unauthorized' || kind === 'no_instance' || kind === 'not_owned') {
    return { kind: 'sign_in_required', reason: kind, ...carry };
  }
  return { kind: 'deferred', reason: kind, ...carry };
}

/** Internals. */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * One POST, one error taxonomy. Shared by both endpoints so the failure
 * kinds cannot drift apart between them.
 *
 * The deadline is RACED as well as wired to the `AbortController`, matching
 * `checkServerUrl` in `lib/server-url.ts`: a `fetchFn` that ignores the
 * signal (or a platform without `AbortController`) would otherwise leave
 * the login screen spinning with no escape.
 */
async function withIdentityRequest<T>(
  options: IdentityRequestOptions,
  path: string,
  payload: Record<string, unknown>,
  bearer: string | null,
  credential: PresentedCredential,
  parse: (body: Record<string, unknown>) => IdentityResult<T>,
): Promise<IdentityResult<T>> {
  let base: string;
  try {
    base = requireAuthBaseUrl(options.auth_base_url);
  } catch {
    // The honest state: this build carries no identity service, so there
    // is nothing to sign in to. NEVER fabricate a URL to paper over it.
    return {
      ok: false,
      failure: { kind: 'identity_not_configured' },
      message:
        'This app has no identity service configured, so it cannot look up your instance. Connect to it directly below.',
    };
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeout_ms ?? DEFAULT_IDENTITY_TIMEOUT_MS;
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (controller !== null) controller.abort();
      reject(new Error('neutron_identity_timeout'));
    }, timeoutMs);
  });
  void deadline.catch(() => undefined);

  let res: Response;
  let body: Record<string, unknown>;
  try {
    // The deadline covers the BODY READ too, not just the headers. A service
    // that answers and then stalls mid-body would otherwise hang forever:
    // clearing the timer straight after the fetch resolved would disarm the
    // abort exactly when it was still needed.
    res = await Promise.race([
      fetchFn(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(payload),
        ...(controller === null ? {} : { signal: controller.signal }),
      }),
      deadline,
    ]);
    // A body that isn't JSON is not a transport failure — the status still
    // carries meaning, so fall back to `{}` and let the mapping below speak.
    body = asRecord(await Promise.race([res.json().catch(() => null), deadline])) ?? {};
  } catch {
    return {
      ok: false,
      failure: { kind: 'unreachable' },
      message:
        'Could not reach the identity service. Check your connection and try again, or connect to your instance directly below.',
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (res.ok) return parse(body);
  return { ok: false, ...describeFailure(res.status, body, credential) };
}

/**
 * WHICH credential a request presented — the thing a 401 is a verdict ON.
 *
 * A 401 means "the credential I sent was refused", and the only useful error
 * copy names the credential the owner can actually do something about. The
 * endpoint alone is not a safe proxy (`/v1/login` and the OAuth exchange both
 * send no bearer yet fail for completely different reasons), so each call site
 * declares this explicitly.
 */
type PresentedCredential =
  /** Email + password typed on this screen. */
  | 'password'
  /** An authorization code from a provider's consent redirect. */
  | 'oauth_code'
  /** An account-scoped session bearer the app already holds. */
  | 'session';

const UNAUTHORIZED_MESSAGE: Record<PresentedCredential, string> = {
  password: 'That email and password did not match an account. Check them and try again.',
  oauth_code:
    'That sign-in could not be completed — the provider’s response was not accepted. Try signing in again.',
  // NOT a password problem: the bearer this device holds was refused, which is
  // what an expired or revoked session looks like.
  session:
    'Your session is no longer valid. Sign in again to reconnect this device to your Neutron.',
};

/**
 * Map the identity service's error reply onto `IdentityFailure`.
 *
 * KEYED ON THE BODY'S SHAPE, then status. Status alone is not enough: the
 * service maps BOTH "this account owns no instance" and "you don't own
 * that slug" to **404**. What separates them is which discriminating field
 * the error body carries, and the service attaches exactly one per case:
 *
 *   409 + `slugs: string[]`  → several instances; the list feeds the picker
 *   404 + `userId: string`   → the account owns no active instance
 *   404 + `slug: string`     → that slug isn't an active instance we own
 *   401                      → bad credentials, or a rejected session token
 *   anything else            → `server`, carrying the REAL status
 *
 * Verified against the control plane's error serialiser and its routing
 * error classes at the SHA that shipped `/v1/route`: the serialiser emits
 * `{error, kind}` for every failure and adds `slugs` / `userId` / `slug`
 * respectively for the three routing cases, and the status table maps them
 * 409 / 404 / 404.
 *
 * The reply also carries a `kind` string, which would be the more direct
 * discriminator — but its values name a hosting-layer concept that Open's
 * vocabulary gate (`scripts/ci/leak-gate.sh`) excludes from this public
 * tree, and matching them would mean embedding those literals here. The
 * shape check is equally determined by the server's own output, so it is
 * used instead.
 *
 * EVERY branch is gated on the STATUS as well as the field. Keying on a body
 * field alone would let an unrelated 500 whose payload happens to carry a
 * `slugs` array render an instance picker instead of a retryable error —
 * turning a transient server fault into a dead end.
 *
 * Anything unrecognised degrades to `server` with the true status — an
 * honest error rather than a mislabelled one.
 */
function describeFailure(
  status: number,
  body: Record<string, unknown>,
  credential: PresentedCredential,
): { failure: IdentityFailure; message: string } {
  if (status === 409 && Array.isArray(body['slugs'])) {
    const slugs = body['slugs'].filter((s): s is string => typeof s === 'string' && s.length > 0);
    return {
      failure: { kind: 'ambiguous', slugs },
      message: 'You have more than one Neutron instance. Pick the one to open.',
    };
  }
  if (status === 404 && typeof body['userId'] === 'string') {
    return {
      failure: { kind: 'no_instance' },
      message:
        "You're signed in, but no Neutron instance has been set up for this account yet. Once it's ready, sign in again and this app will find it.",
    };
  }
  if (status === 404 && typeof body['slug'] === 'string') {
    const slug = body['slug'];
    return {
      failure: { kind: 'not_owned', slug },
      message: `That instance (${slug.length > 0 ? slug : 'unknown'}) is not available on this account any more. Sign in again to see your current instances.`,
    };
  }
  if (status === 401) {
    return {
      failure: { kind: 'unauthorized' },
      // 401 IS NOT ALWAYS A BAD PASSWORD — the copy has to match the credential
      // that was actually presented. `/v1/route` sends a session bearer, and the
      // service answers 401 when it REJECTS that bearer; telling a Google user to
      // check an email and password they never set is a dead end. See
      // `withIdentityRequest`, which passes the credential kind through.
      message: UNAUTHORIZED_MESSAGE[credential],
    };
  }
  return {
    failure: { kind: 'server', status },
    message: `The identity service answered ${status}. Try again in a moment, or connect to your instance directly below.`,
  };
}
