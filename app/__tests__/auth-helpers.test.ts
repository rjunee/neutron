/**
 * @neutronai/app — pure auth-helpers unit tests (P5.0).
 *
 * Covers the pure helpers in `lib/auth-helpers.ts`:
 *   - `shouldRedirectToLogin` — the shared signed-out guard.
 *   - `requireAuthBaseUrl` — guards an identity base before it is used.
 *   - `parseOauthCallback` — parses the provider's authorization-code redirect.
 *   - `decodeJwtSub` — peeks (unverified) at a token's `sub`.
 *   - `parseDevTokenUserId` — extracts the user id from a `dev:` opaque
 *     token, a JWT, or an unrecognized opaque token.
 *   - `shouldHoldOnLogin` — the login-first hold decision (see its own describe).
 *   - `base64UrlDecode` — reads a JWT payload locally.
 *
 * `buildStartUrl` was DELETED with the dead OAuth lane (2026-07-25): the
 * identity service now composes and returns the provider `authorizeUrl` from
 * `POST /v1/oauth/<p>/start`, so the client no longer builds one. The live lane
 * is `signInWithOauth`, covered in `login-first-discovery.test.ts`.
 *
 * `base64UrlEncode` / `hexToBase64Url` were deleted in the same sweep — they
 * existed only to mint a PKCE challenge on the client, which the service now
 * does. The local `b64u` below is a TEST FIXTURE BUILDER, deliberately not an
 * export: production has no encoder to call, so re-exporting one just to satisfy
 * these tests would resurrect the dead code they were removed for.
 */

import { describe, expect, it } from 'bun:test';

import {
  base64UrlDecode,
  decodeJwtSub,
  OWNER_IDENTITY,
  parseDevTokenUserId,
  parseOauthCallback,
  requireAuthBaseUrl,
  shouldHoldOnLogin,
  shouldRedirectToLogin,
} from '../lib/auth-helpers';

/** Test-only URL-safe base64 encoder, for building JWT-shaped fixtures. */
function b64u(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

describe('shouldRedirectToLogin', () => {
  const user = { token: 't', displayName: 'Me' };

  it('does NOT redirect while auth is still hydrating (token loading from storage)', () => {
    // The bug Argus PR #13 flagged: an authenticated user is transiently
    // `user === null` during hydration; redirecting then bounces them to
    // /login on a direct load / refresh / deep-link.
    expect(shouldRedirectToLogin({ status: 'hydrating', user: null })).toBe(false);
  });

  it('does NOT redirect a hydrated, authenticated user', () => {
    expect(shouldRedirectToLogin({ status: 'ready', user })).toBe(false);
  });

  it('does NOT redirect an authenticated user even mid-hydration', () => {
    expect(shouldRedirectToLogin({ status: 'hydrating', user })).toBe(false);
  });

  it('redirects only once auth has RESOLVED to genuinely-unauthenticated', () => {
    expect(shouldRedirectToLogin({ status: 'ready', user: null })).toBe(true);
  });
});

describe('requireAuthBaseUrl', () => {
  it('returns the base with trailing slashes stripped', () => {
    expect(requireAuthBaseUrl('https://auth.neutron.example//')).toBe(
      'https://auth.neutron.example',
    );
    expect(requireAuthBaseUrl('  http://192.168.1.20:9000  ')).toBe('http://192.168.1.20:9000');
  });

  it('throws a NAMED error on anything that is not an absolute http(s) base', () => {
    for (const bad of ['', '   ', '/', '//auth.example.com', 'ftp://auth.example.com']) {
      expect(() => requireAuthBaseUrl(bad)).toThrow('auth_base_url_not_configured');
    }
  });
});

describe('parseOauthCallback', () => {
  it('reads the authorization code + state out of the provider redirect', () => {
    const out = parseOauthCallback('neutron://oauth/callback?code=abc&state=xyz');
    expect(out).toEqual({ code: 'abc', state: 'xyz' });
  });

  it('reads them from the web (https) form of the same redirect', () => {
    const out = parseOauthCallback(
      'https://app.neutron.example/oauth/callback?code=abc&state=xyz',
    );
    expect(out).toEqual({ code: 'abc', state: 'xyz' });
  });

  it('reports a provider-side refusal as its OWN error, not "missing code"', () => {
    // Denied consent redirects with `error=` and no `code`. Reporting that as
    // a missing code would tell the owner the app is broken when in fact they
    // (or their admin) said no.
    expect(() =>
      parseOauthCallback('neutron://oauth/callback?error=access_denied&state=xyz'),
    ).toThrow('oauth_callback_provider_error:access_denied');
  });

  it('throws on a URL missing the code', () => {
    expect(() => parseOauthCallback('neutron://oauth/callback?state=xyz')).toThrow(
      'oauth_callback_missing_code',
    );
  });

  it('throws on a URL missing the state', () => {
    expect(() => parseOauthCallback('neutron://oauth/callback?code=abc')).toThrow(
      'oauth_callback_missing_state',
    );
  });

  it('throws on a malformed URL', () => {
    expect(() => parseOauthCallback('not a url')).toThrow('oauth_callback_url_invalid');
  });
});

describe('decodeJwtSub', () => {
  const jwt = (payload: unknown): string =>
    `${b64u('{"alg":"RS256"}')}.${b64u(JSON.stringify(payload))}.sig`;

  it('reads sub from a three-part token', () => {
    expect(decodeJwtSub(jwt({ sub: 'acct-42', slug: 'my-instance' }))).toBe('acct-42');
  });

  it('returns null rather than GUESSING for anything unreadable', () => {
    // Callers must handle the null: substituting a plausible-looking value
    // (a slug, an email) is how a non-identity string ends up keying
    // identity-derived state.
    expect(decodeJwtSub('dev:owner')).toBeNull();
    expect(decodeJwtSub(jwt({ slug: 'my-instance' }))).toBeNull();
    expect(decodeJwtSub(jwt({ sub: 42 }))).toBeNull();
    expect(decodeJwtSub('a.b.c')).toBeNull();
    expect(decodeJwtSub('')).toBeNull();
  });
});

describe('parseDevTokenUserId', () => {
  it('strips `dev:` prefix', () => {
    expect(parseDevTokenUserId('dev:sam')).toBe('sam');
  });

  it('extracts `sub` from a 3-part JWT-shaped token', () => {
    // header.payload.signature where payload base64url-decodes to {"sub":"alice"}
    const jwt = `aaa.${b64u('{"sub":"alice"}')}.bbb`;
    expect(parseDevTokenUserId(jwt)).toBe('alice');
  });

  // These two used to assert `toBe(<the token>)` — they PINNED the defect.
  // Returning the credential as the user id is what caused #395 (the bearer
  // rendered as the account display name, reaching a screenshot) and #398 (the
  // bearer used as the local chat-store key, so a rotation stranded the
  // device's own history under a key nothing reads). An opaque value is not an
  // identity; it now resolves to the stable owner identity, which is also what
  // the gateway reports in `session_ready`.
  it('an opaque token resolves to the stable owner identity, NOT the token', () => {
    expect(parseDevTokenUserId('opaque-token')).toBe(OWNER_IDENTITY);
    expect(parseDevTokenUserId('opaque-token')).not.toBe('opaque-token');
  });

  it('a malformed JWT also resolves to the owner identity, never the raw value', () => {
    const malformed = 'aaa.not-base64-json.bbb';
    expect(parseDevTokenUserId(malformed)).toBe(OWNER_IDENTITY);
    expect(parseDevTokenUserId(malformed)).not.toBe(malformed);
  });

  it('a real bearer never leaks into the derived id', () => {
    expect(parseDevTokenUserId('nbt_9k2rFpQ7Kw5eem6BG4I4iSTtezt6ikTY')).not.toContain('nbt_');
  });
});

describe('base64UrlDecode', () => {
  it('decodes unpadded URL-safe base64', () => {
    expect(base64UrlDecode('TWFu')).toBe('Man');
  });

  it('accepts the URL-safe alphabet in place of `+` and `/`', () => {
    // Standard base64 `////` is URL-safe `____`; both decode to 0xFFFFFF.
    expect(base64UrlDecode('____')).toBe('ÿÿÿ');
  });

  it('re-pads a length that is not a multiple of 4', () => {
    // 'TWE' is 3 chars — needs one '=' restored before decoding.
    expect(base64UrlDecode('TWE')).toBe('Ma');
  });
});

/**
 * THE SPRINT'S HEADLINE ACCEPTANCE CRITERION, ASSERTED.
 *
 * "An unconfigured install opens on LOGIN, not the connect form" was previously
 * covered only by matching the source text of `app/app/index.tsx` — a test a
 * reformat breaks and an INVERTED redirect still passes. `shouldHoldOnLogin` is
 * that decision as a value, so these assert the behaviour itself. `index.tsx`
 * calls it directly (`app/app/index.tsx`, the `useEffect` guard), and the
 * structural test in `login-first-discovery.test.ts` pins that call site.
 */
describe('shouldHoldOnLogin', () => {
  const user = { token: 't', displayName: 'Me' };

  it('HOLDS an unconfigured install on /login even with a session — the #385 invariant', () => {
    // The headline criterion. A persisted session says WHO the owner is, not
    // WHERE their instance is; entering here is what dialled loopback in #385.
    expect(shouldHoldOnLogin({ configured: false, status: 'ready', user })).toBe(true);
  });

  it('HOLDS an unconfigured install that is also signed out', () => {
    expect(shouldHoldOnLogin({ configured: false, status: 'ready', user: null })).toBe(true);
  });

  it('HOLDS while unconfigured even mid-hydration — no gateway-calling screen may mount', () => {
    expect(shouldHoldOnLogin({ configured: false, status: 'hydrating', user })).toBe(true);
  });

  it('HOLDS a configured install once auth RESOLVES to signed-out', () => {
    expect(shouldHoldOnLogin({ configured: true, status: 'ready', user: null })).toBe(true);
  });

  it('does NOT hold while a configured install is still hydrating (no /login flash)', () => {
    // The round-1 bug shape: a bare `user === null` is true mid-hydration for a
    // signed-IN install and would bounce every cold start through /login.
    expect(shouldHoldOnLogin({ configured: true, status: 'hydrating', user: null })).toBe(false);
  });

  it('ENTERS the app only when configured AND signed in', () => {
    expect(shouldHoldOnLogin({ configured: true, status: 'ready', user })).toBe(false);
  });

  it('is not vacuously true — the configured+signed-in case is the one that enters', () => {
    // Guards against a predicate that returns true unconditionally, which would
    // satisfy every assertion above while making the app unusable.
    const outcomes = [
      shouldHoldOnLogin({ configured: false, status: 'ready', user }),
      shouldHoldOnLogin({ configured: true, status: 'ready', user }),
    ];
    expect(outcomes).toEqual([true, false]);
  });
});
