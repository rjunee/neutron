/**
 * @neutronai/app — auth client (P5.0 rewrite).
 *
 * Per `docs/plans/P5.0-app-scaffolding-sprint-brief.md` § 4.4:
 *
 *   1. `/login` shows two primary buttons (Google / Apple) + a dev-token
 *      paste-in lane.
 *   2. Tap Google → `openAuthSessionAsync` round-trip to
 *      `<auth-base>/oauth/google/start` with PKCE `code_challenge`
 *      and a `state` UUID. Web uses `window.location` redirect.
 *   3. Identity service runs the OAuth provider exchange, redirects to
 *      a landing page that emits `neutron://oauth/callback?token=...`
 *      (native) or hands the install-token to an in-page Expo Router
 *      callback handler (web).
 *   4. App calls `POST {auth_base_url}/api/v1/install-token/exchange`
 *      with `{install_token, code_verifier}` → receives the multi-aud
 *      JWT.
 *   5. App stores the JWT via `lib/token-storage.ts` (handled by the
 *      `AuthSessionProvider`'s persist-on-setUser path) + sets the
 *      session user.
 *
 * The dev-token paste-in lane is REQUIRED (not optional) per § 4.4 —
 * while the auth service is bring-up and during local-gateway
 * dev (`NEUTRON_APP_WS_BYPASS=1` / `NEUTRON_APP_WS_DEV_SECRET=...`),
 * pasting a `dev:<user_id>` token OR an HS256 JWT must round-trip to
 * the same `setUser(...)` path the OAuth lane exits through. The
 * gateway accepts these tokens raw per the existing app-WS auth
 * resolver.
 *
 * Pure helpers (URL building, callback parsing, base64-url encoding,
 * dev-token parsing) live in `lib/auth-helpers.ts` — they're free of
 * `react-native` and Expo SDK imports so unit tests can exercise
 * them under `bun test`.
 */

import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

import {
  base64UrlEncode,
  buildStartUrl,
  hexToBase64Url,
  parseDevTokenUserId,
  parseOauthCallback,
} from './auth-helpers';
import { loadAppConfig } from './config';

export type AuthProvider = 'google' | 'apple' | 'dev';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  /**
   * Bearer token used by every authenticated client surface. In dev
   * this is a `dev:<user_id>` opaque token or a pasted HS256 JWT; in
   * prod a multi-aud EdDSA JWT minted by the auth service.
   */
  token: string;
}

WebBrowser.maybeCompleteAuthSession();

/** Public API — provider buttons + dev-token paste-in. */

export async function signInWithGoogle(): Promise<AuthUser> {
  return signInWithOauthProvider({ provider: 'google' });
}

export async function signInWithApple(): Promise<AuthUser> {
  return signInWithOauthProvider({ provider: 'apple' });
}

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
    displayName: input.display_name ?? user_id,
    provider: 'dev',
    token: trimmed,
  };
}

export async function signOut(): Promise<void> {
  // The persisted blobs are wiped via `AuthSessionProvider.clear()`;
  // this is left in the public API for callers that want an explicit
  // server-side revocation hook later. P5.0 leaves it as a no-op.
}

/** Internals — testable bits. */

interface OauthDeps {
  /** UUID v4 generator. Defaults to `Crypto.randomUUID()`. */
  randomUUID?(): string;
  /** Random byte source for the PKCE verifier. */
  randomBytes?(byteCount: number): Promise<Uint8Array>;
  /** Token exchange POST. Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** WebBrowser session opener. Defaults to `WebBrowser.openAuthSessionAsync`. */
  openAuthSession?: typeof WebBrowser.openAuthSessionAsync;
  /** Override the `Constants.expoConfig.extra` resolver. */
  loadConfig?: typeof loadAppConfig;
}

export async function signInWithOauthProvider(input: {
  provider: 'google' | 'apple';
  deps?: OauthDeps;
}): Promise<AuthUser> {
  const provider = input.provider;
  const deps = input.deps ?? {};
  const cfg = (deps.loadConfig ?? loadAppConfig)();
  const verifier = await generateCodeVerifier(deps.randomBytes);
  const challenge = await sha256Base64Url(verifier);
  const state = (deps.randomUUID ?? Crypto.randomUUID)();
  const redirectUri = Linking.createURL('/oauth/callback');
  const startUrl = buildStartUrl({
    auth_base_url: cfg.auth_base_url,
    provider,
    challenge,
    state,
    redirect_uri: redirectUri,
    platform: Platform.OS === 'web' ? 'web' : 'native',
  });
  const openAuthSession = deps.openAuthSession ?? WebBrowser.openAuthSessionAsync;
  const result = await openAuthSession(startUrl, redirectUri);
  if (result.type !== 'success' || typeof result.url !== 'string') {
    throw new Error(`oauth_${result.type}`);
  }
  const callback = parseOauthCallback(result.url);
  if (callback.state !== state) {
    throw new Error('oauth_state_mismatch');
  }
  const exchange = await exchangeInstallToken({
    auth_base_url: cfg.auth_base_url,
    install_token: callback.install_token,
    code_verifier: verifier,
    deps,
  });
  return {
    id: exchange.user.id,
    email: exchange.user.email,
    displayName: exchange.user.displayName ?? exchange.user.email,
    provider,
    token: exchange.token,
  };
}

interface InstallTokenResponse {
  token: string;
  user: {
    id: string;
    email: string;
    displayName?: string;
  };
}

export async function exchangeInstallToken(input: {
  auth_base_url: string;
  install_token: string;
  code_verifier: string;
  deps?: OauthDeps;
}): Promise<InstallTokenResponse> {
  const url = `${input.auth_base_url.replace(/\/+$/, '')}/api/v1/install-token/exchange`;
  const fetchFn = input.deps?.fetch ?? globalThis.fetch;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install_token: input.install_token,
      code_verifier: input.code_verifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`install_token_exchange_failed_${res.status}`);
  }
  const data = (await res.json()) as InstallTokenResponse;
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('install_token_exchange_invalid_response');
  }
  return data;
}

// Re-export the pure helpers under their original names so callers
// that imported them from `./auth` continue to compile.
export { buildStartUrl, parseDevTokenUserId, parseOauthCallback };

/** PKCE helpers (platform-bound — call into `expo-crypto`). */

const VERIFIER_BYTE_LEN = 32; // 32 bytes → 43 base64url chars (RFC 7636 valid)

async function generateCodeVerifier(
  randomBytes?: (n: number) => Promise<Uint8Array>,
): Promise<string> {
  const bytes = randomBytes !== undefined
    ? await randomBytes(VERIFIER_BYTE_LEN)
    : Crypto.getRandomBytes(VERIFIER_BYTE_LEN);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    input,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
  return hexToBase64Url(hex);
}
