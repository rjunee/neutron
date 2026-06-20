/**
 * @neutronai/app — pure auth-helpers unit tests (P5.0).
 *
 * Covers the four pure helpers in `lib/auth-helpers.ts`:
 *   - `buildStartUrl` — composes the identity-service OAuth start URL.
 *   - `parseOauthCallback` — parses the deep-link / web callback URL.
 *   - `parseDevTokenUserId` — extracts the user id from a `dev:` opaque
 *     token, an HS256 JWT, or an unrecognized opaque token.
 *   - `base64UrlEncode` / `base64UrlDecode` / `hexToBase64Url` —
 *     PKCE-relevant codec helpers.
 *
 * The platform-bound `signInWithOauthProvider` is covered by manual
 * smoke against the dev gateway per the brief's verification gate.
 */

import { describe, expect, it } from 'bun:test';

import {
  base64UrlDecode,
  base64UrlEncode,
  buildStartUrl,
  hexToBase64Url,
  parseDevTokenUserId,
  parseOauthCallback,
} from '../lib/auth-helpers';

describe('buildStartUrl', () => {
  it('composes the canonical start URL with every required param', () => {
    const url = buildStartUrl({
      auth_base_url: 'https://auth.neutron.example',
      provider: 'google',
      challenge: 'CHALLENGE',
      state: 'STATE',
      redirect_uri: 'neutron://oauth/callback',
      platform: 'native',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://auth.neutron.example/oauth/google/start',
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe('STATE');
    expect(parsed.searchParams.get('redirect_uri')).toBe('neutron://oauth/callback');
    expect(parsed.searchParams.get('platform')).toBe('native');
  });

  it('strips trailing slashes from auth_base_url', () => {
    const url = buildStartUrl({
      auth_base_url: 'https://auth.neutron.example/',
      provider: 'apple',
      challenge: 'c',
      state: 's',
      redirect_uri: 'https://app.neutron.example/oauth/callback',
      platform: 'web',
    });
    expect(url).toContain('/oauth/apple/start?');
    // No double slash before /oauth.
    expect(url).not.toContain('.example//oauth');
  });
});

describe('parseOauthCallback', () => {
  it('accepts `token` query param', () => {
    const out = parseOauthCallback('neutron://oauth/callback?token=abc&state=xyz');
    expect(out).toEqual({ install_token: 'abc', state: 'xyz' });
  });

  it('accepts `install_token` query param as alias', () => {
    const out = parseOauthCallback(
      'https://app.neutron.example/oauth/callback?install_token=abc&state=xyz',
    );
    expect(out).toEqual({ install_token: 'abc', state: 'xyz' });
  });

  it('throws on a URL missing the token', () => {
    expect(() => parseOauthCallback('neutron://oauth/callback?state=xyz')).toThrow(
      'oauth_callback_missing_token',
    );
  });

  it('throws on a URL missing the state', () => {
    expect(() => parseOauthCallback('neutron://oauth/callback?token=abc')).toThrow(
      'oauth_callback_missing_state',
    );
  });

  it('throws on a malformed URL', () => {
    expect(() => parseOauthCallback('not a url')).toThrow('oauth_callback_url_invalid');
  });
});

describe('parseDevTokenUserId', () => {
  it('strips `dev:` prefix', () => {
    expect(parseDevTokenUserId('dev:sam')).toBe('sam');
  });

  it('extracts `sub` from a 3-part JWT-shaped token', () => {
    // header.payload.signature where payload base64url-decodes to {"sub":"alice"}
    const payload = base64UrlEncode(new TextEncoder().encode('{"sub":"alice"}'));
    const jwt = `aaa.${payload}.bbb`;
    expect(parseDevTokenUserId(jwt)).toBe('alice');
  });

  it('falls back to the raw token when nothing matches', () => {
    expect(parseDevTokenUserId('opaque-token')).toBe('opaque-token');
  });

  it('falls back when the JWT payload is non-JSON', () => {
    expect(parseDevTokenUserId('aaa.not-base64-json.bbb')).toBe('aaa.not-base64-json.bbb');
  });
});

describe('base64UrlEncode / base64UrlDecode', () => {
  it('round-trips a known byte sequence with no `=` padding', () => {
    const bytes = new Uint8Array([0x4d, 0x61, 0x6e]); // "Man"
    const encoded = base64UrlEncode(bytes);
    expect(encoded).toBe('TWFu');
    expect(encoded).not.toContain('=');
    const decoded = base64UrlDecode(encoded);
    expect(decoded).toBe('Man');
  });

  it('uses URL-safe characters in place of `+` and `/`', () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff]);
    const encoded = base64UrlEncode(bytes);
    // Standard base64 of 0xFFFFFF is `////`; URL-safe is `____`.
    expect(encoded).toBe('____');
  });

  it('round-trips through hexToBase64Url for a 32-byte PKCE-shape buffer', () => {
    const hex = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
    const encoded = hexToBase64Url(hex);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
    // 32 bytes → 43 base64url chars.
    expect(encoded.length).toBe(43);
  });
});
