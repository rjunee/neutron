/**
 * @neutronai/app — LOGIN-FIRST discovery (SPEC § Decisions Log 2026-07-25).
 *
 * Ryan: *"why does it have to ask? it should just open with a login screen,
 * and once you login it should know the url."* ISSUES #385 gave the app a
 * runtime server URL but made TYPING it the first-run surface. This suite
 * covers the replacement: sign in at central identity, then learn the
 * instance address from `POST {auth_base}/v1/route`.
 *
 * WHAT IS EXERCISED FOR REAL. Every behavioural test below drives the REAL
 * `lib/identity-client.ts` over an injected `fetch`, and the REAL persist
 * path (`commitServerConfig` → `WebTokenStorage` → an in-memory backing),
 * same harness as `server-url.test.ts` / `token-storage.test.ts`. Nothing
 * re-implements the module under test, and the persisted value is read back
 * out of the backing store rather than from a return value.
 *
 * This file deliberately does NOT mock `expo-constants`: `mock.module` is
 * process-global in bun, and `server-config-wiring.test.ts` documents that
 * it is the ONLY app test allowed to virtualize it. `lib/identity-client.ts`
 * has no `expo-constants` import (it takes `auth_base_url` as an argument),
 * so it loads cleanly here. The final hop — persisted config → synchronous
 * `loadAppConfig()` — is asserted in `server-config-wiring.test.ts`, which
 * is the file that owns that mock.
 *
 * WHY THE SCREEN'S OWN LOGIC IS STILL TESTED FOR REAL. The app suite has no
 * React Native mount harness (no `@testing-library/react-native`;
 * `react-test-renderer` is deprecated in React 19), so a component's rendering
 * can only be source-pinned. The DECISIONS therefore do not live in the
 * component: which stage follows which failure, and what the retry control
 * does, are pure functions in `lib/login-stage.ts` and are asserted directly
 * here. Round 1 of this branch had them inline and "covered" by
 * `expect(src).toContain('void runDiscovery(session)')` — which passed over a
 * real bug where the retry button did the opposite of its own label. Source
 * pins that remain cover WIRING only (this testID is rendered, this module is
 * imported), and every one of them is paired with a behavioural assertion of
 * the rule it wires.
 *
 * Hosts in fixtures are `*.example.com` on purpose — `scripts/ci/leak-gate.sh`
 * enforces a zero-tolerance hosted-domain rule over this PUBLIC repo.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  adoptDiscoveredInstance,
  discoverInstance,
  isIdentityConfigured,
  isTokenExpired,
  LOGIN_PATH,
  oauthExchangePath,
  oauthStartPath,
  REFRESH_PATH,
  refreshIdentitySession,
  renewInstanceSession,
  ROUTE_PATH,
  signInWithOauth,
  signInWithPassword,
  type DiscoveredInstance,
} from '../lib/identity-client';
import {
  clearsSession,
  nextStageForFailure,
  retryLabelForStage,
  retryTargetForStage,
  type Stage,
} from '../lib/login-stage';
import {
  IDENTITY_SESSION_KEY,
  SERVER_AUTH_KEY,
  SERVER_GATEWAY_KEY,
  TOKEN_KEY,
  WebTokenStorage,
  type SyncKeyValueStore,
} from '../lib/token-storage';

const APP_ROOT = join(__dirname, '..');
const AUTH_BASE = 'https://auth.example.com';

function makeBacking(): SyncKeyValueStore & { snapshot(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    snapshot: () => Object.fromEntries(map),
  };
}

/** The real gateway health body — `gateway/index.ts:786-789`. */
function healthBody(): string {
  return JSON.stringify({ status: 'ok', project_slug: 'general', uptime_ms: 1234 });
}

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/**
 * A `fetch` that records every call and answers per-path:
 *   - `<AUTH_BASE>/v1/login`  → `login`
 *   - `<AUTH_BASE>/v1/route`  → `route` (a function, so successive calls can
 *                               differ — the picker re-calls the same path)
 *   - anything ending `/healthz` → the gateway health body (200)
 */
function stubFetch(input: {
  login?: { status: number; body: unknown };
  route?: (call: number, body: unknown) => { status: number; body: unknown };
  healthz?: { status: number; body?: string };
  throws?: Error;
}): { fn: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  let routeCalls = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers['authorization'] ?? null,
      body: parsed,
    });
    if (input.throws !== undefined && !url.endsWith('/healthz')) throw input.throws;
    if (url === `${AUTH_BASE}${LOGIN_PATH}`) {
      const spec = input.login ?? { status: 500, body: { error: 'no login stub' } };
      return new Response(JSON.stringify(spec.body), { status: spec.status });
    }
    if (url === `${AUTH_BASE}${ROUTE_PATH}`) {
      routeCalls += 1;
      const spec = input.route?.(routeCalls, parsed) ?? {
        status: 500,
        body: { error: 'no route stub' },
      };
      return new Response(JSON.stringify(spec.body), { status: spec.status });
    }
    if (url.endsWith('/healthz')) {
      const spec = input.healthz ?? { status: 200 };
      return new Response(spec.body ?? healthBody(), { status: spec.status });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return { fn, calls };
}

/** A successful `/v1/login` body, as the identity service returns it. */
function loginOk() {
  return {
    status: 200,
    body: {
      account: { user_id: 'u-1', email: 'owner@example.com' },
      // ACCOUNT-scoped: only ever spent on /v1/route.
      accessToken: 'account-scoped-token',
      refreshToken: 'refresh-1',
    },
  };
}

/**
 * A successful `/v1/route` body, shaped exactly as the identity service's
 * routing module emits it. NOTE the `upstreamUrl`: it is the INTERNAL
 * loopback target used on the box, and it is present in EVERY real reply. A
 * client that adopted it would dial its own loopback — the exact ISSUES #385
 * bug — so its presence here is what makes the (c) assertions meaningful.
 */
function routeOk(slug: string) {
  return {
    status: 200,
    body: {
      slug,
      publicUrl: `https://${slug}.example.com`,
      upstreamUrl: 'http://127.0.0.1:7800',
      accessToken: instanceToken(slug),
      claims: { sub: 'u-1', slug },
    },
  };
}

/**
 * An instance-scoped bearer shaped like the real one: RS256 header, `{sub, slug,
 * exp}` payload. It has to be a real JWT because the app reads `sub` off it to
 * learn which identity the instance will see this device as — a placeholder
 * string would make that assertion vacuous.
 */
function instanceToken(slug: string, opts: { sub?: string; expSec?: number } = {}): string {
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = {
    sub: opts.sub ?? 'u-1',
    slug,
    exp: opts.expSec ?? Math.floor(Date.now() / 1_000) + 3_600,
  };
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature-not-checked-client-side`;
}

/** The full happy path: sign in → discover → adopt. Returns what persisted. */
async function signInAndAdopt(
  stub: ReturnType<typeof stubFetch>,
  backing: ReturnType<typeof makeBacking>,
  slug?: string,
) {
  const signedIn = await signInWithPassword({
    auth_base_url: AUTH_BASE,
    email: 'owner@example.com',
    password: 'pw',
    fetchFn: stub.fn,
  });
  if (!signedIn.ok) return { signedIn, found: null, adopted: null };
  const found = await discoverInstance({
    auth_base_url: AUTH_BASE,
    session_token: signedIn.value.session_token,
    fetchFn: stub.fn,
    ...(slug === undefined ? {} : { slug }),
  });
  if (!found.ok) return { signedIn, found, adopted: null };
  const adopted = await adoptDiscoveredInstance({
    instance: found.value,
    auth_base_url: AUTH_BASE,
    previous_gateway_base_url: '',
    store: new WebTokenStorage(backing),
    fetchFn: stub.fn,
  });
  return { signedIn, found, adopted };
}

function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  for (const dir of dirs) walk(join(APP_ROOT, dir));
  return out;
}

function read(...parts: string[]): string {
  return readFileSync(join(APP_ROOT, ...parts), 'utf8');
}

/**
 * A file's CODE only, comment lines dropped.
 *
 * Absence checks have to run against this, not the raw source: the modules
 * that removed the setup gate DOCUMENT what was removed and why (that prose
 * is the point — it stops the pattern being reintroduced by someone who
 * doesn't know the history). Matching raw text would make writing the
 * explanation fail the test that guards it. Same convention as
 * `server-editor-reachability.test.ts`'s loopback-default scan.
 *
 * BLOCK-COMMENT STATE IS TRACKED, not approximated by a per-line prefix. The
 * earlier form dropped only lines whose first non-space character was `*`, `//`
 * or `/*` — so a continuation line INSIDE a `/* … *\/` block that happens to
 * start with a word ("upstreamUrl is the internal loopback…") read as CODE and
 * would have failed a scan it should have been exempt from. That is a
 * false-POSITIVE — it fails the build on prose — so the fix is state, not a
 * cleverer regex. Trailing `//` comments are also stripped so a forbidden token
 * cannot hide after real code on the same line.
 */
function codeLinesOf(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Drop any complete /* … */ spans on this line, then open a block if one
    // starts and does not close.
    line = line.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = line.indexOf('/*');
    if (open !== -1) {
      inBlock = true;
      line = line.slice(0, open);
    }
    const lineComment = line.indexOf('//');
    if (lineComment !== -1) line = line.slice(0, lineComment);
    if (line.trim().length > 0) out.push(line);
  }
  return out;
}

function codeOf(src: string): string {
  return codeLinesOf(src).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// (a) an unconfigured install opens on LOGIN, not the connect form
// ─────────────────────────────────────────────────────────────────────────

describe('(a) an unconfigured install renders LOGIN, not the typed-URL form', () => {
  const layout = read('app', '_layout.tsx');

  it('the root layout no longer has an unconfigured branch at all', () => {
    // #385 rendered `ServerSetupGate` INSTEAD of the Stack while
    // unconfigured. That branch is what made "type your address" the first
    // surface, so it is gone — not flag-gated, GONE.
    const code = codeOf(layout);
    expect(code).not.toContain('ServerSetupGate');
    expect(code).not.toContain("'setup'");
    expect(code).toContain("type BootPhase = 'hydrating' | 'ready'");
  });

  it('the full-screen setup gate is DELETED, not left behind unreachable', () => {
    // NO dual old/new surface: a second "Connect to your Neutron" screen
    // nobody can reach is the banned pattern, and the reachability guard
    // below would not catch a component that simply still exists.
    const offenders = sourceFiles(['app', 'components', 'lib']).filter((file) =>
      /ServerSetupGate/.test(codeOf(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map((f) => f.replace(`${APP_ROOT}/`, ''))).toEqual([]);
  });

  it('hydration is still awaited before the tree mounts (the #385 ordering)', () => {
    expect(layout).toContain('await hydrateServerConfig()');
    expect(layout).toContain("setPhase('ready')");
  });

  it('the Stack mounts and /login is a registered screen', () => {
    expect(layout).toContain('<Stack screenOptions');
    expect(layout).toContain('<Stack.Screen name="login" />');
  });

  it('the entry route DELEGATES the hold decision to `shouldHoldOnLogin`', () => {
    // This is what keeps the #385 invariant (no request against an
    // unconfigured install) now that the gate is gone: `/` refuses to move
    // on until a server exists, and `/login` issues no gateway requests.
    //
    // THIS TEST ONLY PINS THE WIRING — that the entry route reads the config and
    // routes the decision through the shared predicate. The DECISION ITSELF is
    // asserted behaviourally in `auth-helpers.test.ts` § shouldHoldOnLogin.
    // Previously the inline condition was matched as a source string here, which
    // a reformat broke and an inverted redirect passed; extracting the predicate
    // is what made real coverage possible (this component owns router + session
    // hooks, so it cannot be mounted in the harness).
    const index = read('app', 'index.tsx');
    expect(index).toContain('loadAppConfig()');
    expect(index).toContain('shouldHoldOnLogin({ configured, status, user })');
    expect(index).toContain("router.replace('/login')");
    // And the inline form is GONE, so there is only one decision site.
    expect(index).not.toContain('!configured ||');
  });

  it('the entry route uses the SHARED signed-out guard, never a bare null check', () => {
    // `AuthSessionProvider` starts at status 'hydrating' with `user` null even
    // for a signed-in install, so redirecting on `user === null` alone flashes
    // /login on every cold start (Argus BLOCKER on PR #13). `settings.tsx` and
    // `integrations.tsx` already route through `shouldRedirectToLogin`; so must
    // the entry.
    // `shouldHoldOnLogin` composes `shouldRedirectToLogin` for exactly this
    // reason — see its assertions in `auth-helpers.test.ts`, which pin that a
    // configured install mid-hydration does NOT hold.
    const index = read('app', 'index.tsx');
    const code = codeOf(index);
    expect(code).toContain('shouldHoldOnLogin');
    // No inline hold condition survives alongside the predicate — one decision
    // site, so the two cannot drift apart.
    expect(code).not.toMatch(/!configured\s*\|\|/);
    // And it holds the spinner while hydration is still in flight.
    expect(code).toContain("if (status !== 'ready') return");
  });

  it('deep-link + push routing stay disabled while unconfigured', () => {
    // Otherwise a push tap would jump straight into a project screen that
    // immediately fetches from nowhere.
    expect(layout).toContain("phase === 'ready' && loadAppConfig().configured");
    expect(layout).toContain('useDocLinkRouting(configured)');
    expect(layout).toContain('usePushTapRouting(configured)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (b) sign in + single-instance discovery persists publicUrl, then enters
// ─────────────────────────────────────────────────────────────────────────

describe('(b) login + single-instance discovery persists publicUrl as the gateway base', () => {
  it('routes with NO slug and persists the discovered publicUrl', async () => {
    const backing = makeBacking();
    const stub = stubFetch({ login: loginOk(), route: () => routeOk('acme') });
    const { found, adopted } = await signInAndAdopt(stub, backing);

    expect(found?.ok).toBe(true);
    expect(adopted?.ok).toBe(true);
    // The persisted value is read back OUT of storage, not off the result.
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBe('https://acme.example.com');
    // The identity base is preserved, so adopting never orphans the service
    // that did the discovery.
    expect(backing.snapshot()[SERVER_AUTH_KEY]).toBe(AUTH_BASE);
  });

  it('the first /v1/route call omits `slug` (one instance auto-routes server-side)', async () => {
    const stub = stubFetch({ login: loginOk(), route: () => routeOk('acme') });
    await signInAndAdopt(stub, makeBacking());
    const route = stub.calls.find((c) => c.url === `${AUTH_BASE}${ROUTE_PATH}`);
    expect(route?.method).toBe('POST');
    expect(route?.body).toEqual({});
  });

  it('sends the ACCOUNT-scoped token to /v1/route and persists the INSTANCE-scoped one', async () => {
    const backing = makeBacking();
    const stub = stubFetch({ login: loginOk(), route: () => routeOk('acme') });
    const { found } = await signInAndAdopt(stub, backing);

    const route = stub.calls.find((c) => c.url === `${AUTH_BASE}${ROUTE_PATH}`);
    // The bearer on /v1/route is the account token from /v1/login …
    expect(route?.authorization).toBe('Bearer account-scoped-token');
    // … and the token the app goes on to use is the instance-scoped one.
    expect(found !== null && found.ok && found.value.accessToken).toBe(instanceToken('acme'));
    expect(found !== null && found.ok && found.value.accessToken).not.toBe(
      'account-scoped-token',
    );
  });

  it('the discovered host is /healthz-validated before it is persisted', async () => {
    // Same rule as a typed URL — one commit path, no shortcut for discovery.
    const backing = makeBacking();
    const stub = stubFetch({
      login: loginOk(),
      route: () => routeOk('acme'),
      healthz: { status: 502 },
    });
    const { adopted } = await signInAndAdopt(stub, backing);
    expect(adopted?.ok).toBe(false);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBeUndefined();
  });

  it('adoption goes through commitServerConfig, not a second writer', () => {
    const src = read('lib', 'identity-client.ts');
    expect(src).toContain('commitServerConfig');
    expect(src).not.toContain('setServerConfig(');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (c) the persisted base is NEVER upstreamUrl
// ─────────────────────────────────────────────────────────────────────────

describe('(c) upstreamUrl is NEVER adopted — the #385 loopback bug cannot return', () => {
  it('persists publicUrl and nothing containing 127.0.0.1', async () => {
    const backing = makeBacking();
    const stub = stubFetch({
      login: loginOk(),
      // upstreamUrl IS the loopback, exactly as the real service sends it.
      route: () => routeOk('acme'),
    });
    const { found, adopted } = await signInAndAdopt(stub, backing);

    expect(adopted?.ok).toBe(true);
    const persisted = backing.snapshot()[SERVER_GATEWAY_KEY]!;
    expect(persisted).toBe('https://acme.example.com');
    expect(persisted).not.toContain('127.0.0.1');
    // The whole persisted blob, not just the one key.
    expect(JSON.stringify(backing.snapshot())).not.toContain('127.0.0.1');
    // And the field never even reaches a caller.
    expect(found !== null && found.ok && Object.keys(found.value).sort()).toEqual([
      'accessToken',
      'publicUrl',
      'slug',
      'userId',
    ]);
  });

  it('a reply whose ONLY address is upstreamUrl is rejected, not salvaged', async () => {
    // The defensive case: no `publicUrl` at all. Falling back to
    // `upstreamUrl` would be the bug; an honest error is correct.
    const backing = makeBacking();
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({
        status: 200,
        body: {
          slug: 'acme',
          upstreamUrl: 'http://127.0.0.1:7800',
          accessToken: 'instance-scoped-acme',
        },
      }),
    });
    const { found } = await signInAndAdopt(stub, backing);
    expect(found?.ok).toBe(false);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBeUndefined();
  });

  it('an unparseable publicUrl is rejected rather than adopted', async () => {
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({
        status: 200,
        body: { slug: 'acme', publicUrl: 'not a url', accessToken: 't' },
      }),
    });
    const { found } = await signInAndAdopt(stub, makeBacking());
    expect(found?.ok).toBe(false);
  });

  it('no app source reads `upstreamUrl` at all', () => {
    // Prose is allowed (and required) — `lib/identity-client.ts` documents WHY
    // the field is ignored. Code is not. `codeLinesOf` tracks block-comment
    // state, so a continuation line of that prose cannot be misread as code.
    const offenders = sourceFiles(['app', 'components', 'lib']).filter((file) =>
      codeLinesOf(readFileSync(file, 'utf8')).some((line) => /upstreamUrl/.test(line)),
    );
    expect(offenders.map((f) => f.replace(`${APP_ROOT}/`, ''))).toEqual([]);
  });

  it('the comment stripper exempts block-comment PROSE but never real code', () => {
    // Mutation-proofing the scan above. The first case is the false-positive the
    // per-line-prefix form produced: prose about the field, mid-block, not
    // starting with `*`. The last two must still be caught.
    expect(codeLinesOf('/*\nupstreamUrl is the internal loopback — never adopt it.\n*/')).toEqual(
      [],
    );
    expect(codeLinesOf('/** doc */\n// upstreamUrl in a line comment')).toEqual([]);
    expect(codeLinesOf('const x = 1; // upstreamUrl hidden after code')).toHaveLength(1);
    expect(codeLinesOf('const base = reply.upstreamUrl;')).toHaveLength(1);
    // A block that OPENS and closes on later lines must not swallow the code
    // that follows it.
    expect(codeLinesOf('/* note\nmore note\n*/\nconst real = upstreamUrl;')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (d) many instances → picker → re-call with the chosen slug
// ─────────────────────────────────────────────────────────────────────────

describe('(d) many instances → picker, then re-route on the chosen slug', () => {
  /** 409 + kind + slugs — Managed `src/index.ts:700,711`. */
  const ambiguous = {
    status: 409,
    body: {
      error: 'owner has several instances (alpha, beta); a slug must be specified',
      slugs: ['alpha', 'beta'],
    },
  };

  it('surfaces the returned slug LIST for the picker', async () => {
    const stub = stubFetch({ login: loginOk(), route: () => ambiguous });
    const { found } = await signInAndAdopt(stub, makeBacking());
    expect(found?.ok).toBe(false);
    expect(found !== null && !found.ok && found.failure).toEqual({
      kind: 'ambiguous',
      slugs: ['alpha', 'beta'],
    });
  });

  it('choosing a slug re-calls /v1/route WITH it and persists THAT publicUrl', async () => {
    const backing = makeBacking();
    // Call 1 = the slug-less probe → ambiguous. Call 2 = the picker choice.
    const stub = stubFetch({
      login: loginOk(),
      route: (n, body) => {
        if (n === 1) return ambiguous;
        const chosen = (body as { slug?: string }).slug ?? '';
        return routeOk(chosen);
      },
    });
    const first = await signInAndAdopt(stub, backing);
    expect(first.found?.ok).toBe(false);

    // The picker's re-call, with the session already in hand.
    const session = first.signedIn.ok ? first.signedIn.value : null;
    const second = await discoverInstance({
      auth_base_url: AUTH_BASE,
      session_token: session!.session_token,
      slug: 'beta',
      fetchFn: stub.fn,
    });
    expect(second.ok).toBe(true);
    const adopted = await adoptDiscoveredInstance({
      instance: (second as { ok: true; value: DiscoveredInstance }).value,
      auth_base_url: AUTH_BASE,
      previous_gateway_base_url: '',
      store: new WebTokenStorage(backing),
      fetchFn: stub.fn,
    });
    expect(adopted.ok).toBe(true);

    const routeCalls = stub.calls.filter((c) => c.url === `${AUTH_BASE}${ROUTE_PATH}`);
    expect(routeCalls.map((c) => c.body)).toEqual([{}, { slug: 'beta' }]);
    // beta, NOT alpha — the choice is what got persisted.
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBe('https://beta.example.com');
  });

  it('a slug the account no longer owns is its own failure, not "no instance"', async () => {
    // Both are 404 server-side, so `kind` is what distinguishes them
    // (Managed `src/index.ts:716-717`).
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({
        status: 404,
        body: { error: 'not owned', slug: 'gamma' },
      }),
    });
    const { found } = await signInAndAdopt(stub, makeBacking(), 'gamma');
    expect(found !== null && !found.ok && found.failure).toEqual({
      kind: 'not_owned',
      slug: 'gamma',
    });
  });

  it('an ambiguous reply with no readable slugs yields an EMPTY list, not junk', async () => {
    // The screen turns this into a retryable error rather than an empty
    // picker — see the `slugs.length > 0` branch in `app/app/login.tsx`.
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({ status: 409, body: { error: 'ambiguous', slugs: [null, 42, ''] } }),
    });
    const { found } = await signInAndAdopt(stub, makeBacking());
    expect(found !== null && !found.ok && found.failure).toEqual({
      kind: 'ambiguous',
      slugs: [],
    });
  });

  it('an ambiguous failure BECOMES the picker stage, carrying the slugs', () => {
    // The real decision, asserted directly — not grepped out of the component.
    const stage = nextStageForFailure({ kind: 'ambiguous', slugs: ['alpha', 'beta'] }, 'msg');
    expect(stage).toEqual({ kind: 'picker', slugs: ['alpha', 'beta'] });
  });

  it('an ambiguous failure with NO readable slugs becomes a retryable error, not an empty picker', () => {
    // A picker with nothing in it is a dead end: no action available, and the
    // owner cannot get out of it.
    const stage = nextStageForFailure({ kind: 'ambiguous', slugs: [] }, 'msg');
    expect(stage.kind).toBe('error');
    expect(stage.kind === 'error' && stage.retry_discovery).toBe(true);
    expect(stage.kind === 'error' && stage.message.length).toBeGreaterThan(0);
  });

  it('the picker is rendered from the stage and calls back into discovery with the slug', () => {
    // WIRING pin (the decisions above are behavioural): the component renders
    // the picker stage's slugs and hands the chosen one to `runDiscovery`.
    const src = read('app', 'login.tsx');
    expect(src).toContain('login-instance-picker');
    expect(src).toContain('stage.slugs.map');
    // `lane` is threaded explicitly so the persisted provider cannot be a stale
    // closure read — see the provider assertions in section (b).
    expect(src).toContain('void runDiscovery(session, lane, slug)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (e) zero instances → the not-provisioned state
// ─────────────────────────────────────────────────────────────────────────

describe('(e) zero instances → an explicit not-provisioned state, no crash', () => {
  it('maps a 404 carrying `userId` to `no_instance` with owner-facing copy', async () => {
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({
        status: 404,
        body: {
          error: 'user u-1 owns no active instance',
          userId: 'u-1',
        },
      }),
    });
    const { found } = await signInAndAdopt(stub, makeBacking());
    expect(found?.ok).toBe(false);
    expect(found !== null && !found.ok && found.failure.kind).toBe('no_instance');
    expect(found !== null && !found.ok && found.message.length).toBeGreaterThan(0);
  });

  it('nothing is persisted, so the next launch still opens on login', async () => {
    const backing = makeBacking();
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({ status: 404, body: { userId: 'u-1' } }),
    });
    await signInAndAdopt(stub, backing);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBeUndefined();
    expect(backing.snapshot()[TOKEN_KEY]).toBeUndefined();
  });

  it('the screen has a distinct state for it', () => {
    const src = read('app', 'login.tsx');
    expect(src).toContain('login-no-instance');
    expect(src).toContain("stage.kind === 'no_instance'");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (f) discovery failure → actionable error + retry + self-host reachable
// ─────────────────────────────────────────────────────────────────────────

describe('(f) discovery failure → actionable error, retry, self-host still reachable', () => {
  it('a transport failure is `unreachable`, not a swallowed exception', async () => {
    const stub = stubFetch({
      login: loginOk(),
      throws: new Error('Network request failed'),
    });
    const signedIn = await signInWithPassword({
      auth_base_url: AUTH_BASE,
      email: 'owner@example.com',
      password: 'pw',
      // Login must succeed first, so use a stub that only fails /v1/route.
      fetchFn: stubFetch({ login: loginOk(), route: () => routeOk('acme') }).fn,
    });
    expect(signedIn.ok).toBe(true);
    const found = await discoverInstance({
      auth_base_url: AUTH_BASE,
      session_token: 'account-scoped-token',
      fetchFn: stub.fn,
    });
    expect(found.ok).toBe(false);
    expect(!found.ok && found.failure.kind).toBe('unreachable');
    expect(!found.ok && found.message).toContain('identity service');
  });

  it('a 5xx keeps the real status so the message is honest', async () => {
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({ status: 503, body: { error: 'unavailable' } }),
    });
    const { found } = await signInAndAdopt(stub, makeBacking());
    expect(found !== null && !found.ok && found.failure).toEqual({
      kind: 'server',
      status: 503,
    });
    expect(found !== null && !found.ok && found.message).toContain('503');
  });

  it('a hung identity service resolves rather than spinning forever', async () => {
    // The deadline is RACED as well as wired to the AbortController — a
    // `fetchFn` that ignores the signal must still settle.
    const hang = (async () => new Promise(() => undefined)) as unknown as typeof globalThis.fetch;
    const found = await discoverInstance({
      auth_base_url: AUTH_BASE,
      session_token: 'account-scoped-token',
      fetchFn: hang,
      timeout_ms: 20,
    });
    expect(found.ok).toBe(false);
    expect(!found.ok && found.failure.kind).toBe('unreachable');
  });

  it('a service that answers then STALLS MID-BODY also settles', async () => {
    // The subtle version of the above: headers arrive, so the fetch promise
    // resolves, but the body never does. Disarming the deadline as soon as the
    // fetch settled would leave the read unbounded and the screen spinning.
    const stallBody = (async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => undefined),
    })) as unknown as typeof globalThis.fetch;
    const found = await discoverInstance({
      auth_base_url: AUTH_BASE,
      session_token: 'account-scoped-token',
      fetchFn: stallBody,
      timeout_ms: 20,
    });
    expect(found.ok).toBe(false);
    expect(!found.ok && found.failure.kind).toBe('unreachable');
  });

  it('a non-JSON body is not a transport failure — the STATUS still speaks', async () => {
    // An HTML error page from a proxy must surface as `server` with the real
    // status, not as `unreachable` (which would imply "you are offline").
    const html = (async () => new Response('<html>gateway timeout</html>', { status: 504 })) as
      unknown as typeof globalThis.fetch;
    const found = await discoverInstance({
      auth_base_url: AUTH_BASE,
      session_token: 'account-scoped-token',
      fetchFn: html,
    });
    expect(found.ok).toBe(false);
    expect(!found.ok && found.failure).toEqual({ kind: 'server', status: 504 });
  });

  it('bad credentials are `unauthorized`, distinct from a service fault', async () => {
    const stub = stubFetch({
      login: { status: 401, body: { error: 'invalid credentials', kind: 'InvalidCredentialsError' } },
    });
    const signedIn = await signInWithPassword({
      auth_base_url: AUTH_BASE,
      email: 'owner@example.com',
      password: 'wrong',
      fetchFn: stub.fn,
    });
    expect(signedIn.ok).toBe(false);
    expect(!signedIn.ok && signedIn.failure.kind).toBe('unauthorized');
  });

  it('a transient failure becomes a RETRYABLE error; a refused credential does not', () => {
    for (const failure of [
      { kind: 'unreachable' } as const,
      { kind: 'server', status: 503 } as const,
      { kind: 'not_owned', slug: 'gamma' } as const,
    ]) {
      const stage = nextStageForFailure(failure, 'msg');
      expect(stage.kind === 'error' && stage.retry_discovery).toBe(true);
    }
    for (const failure of [
      { kind: 'unauthorized' } as const,
      { kind: 'identity_not_configured' } as const,
    ]) {
      const stage = nextStageForFailure(failure, 'msg');
      expect(stage.kind === 'error' && stage.retry_discovery).toBe(false);
    }
  });

  it('an unauthorized failure DISCARDS the session — nothing may retry a refused token', () => {
    expect(clearsSession({ kind: 'unauthorized' })).toBe(true);
    expect(clearsSession({ kind: 'unreachable' })).toBe(false);
    expect(clearsSession({ kind: 'server', status: 503 })).toBe(false);
  });

  it('the retry control CANNOT do the opposite of its own label', () => {
    // The round-1 bug, now impossible by construction: the label came from
    // `stage.retry_discovery` while the action branched on `session !== null`.
    // A failed second sign-in sets retry_discovery=false WITHOUT clearing the
    // first account's session, so the button read "Back to sign in" and re-ran
    // discovery on account A's token — which could sign the device into A's
    // instance. Label and action now come from the same predicate.
    const staleSessionAfterFailedSignIn: Stage = {
      kind: 'error',
      message: 'that email and password did not match',
      retry_discovery: false,
    };
    expect(retryTargetForStage(staleSessionAfterFailedSignIn, true)).toBe('sign_in');
    expect(retryLabelForStage(staleSessionAfterFailedSignIn, true)).toBe('Back to sign in');

    const transientWithGoodSession: Stage = {
      kind: 'error',
      message: 'the identity service answered 503',
      retry_discovery: true,
    };
    expect(retryTargetForStage(transientWithGoodSession, true)).toBe('discovery');
    expect(retryLabelForStage(transientWithGoodSession, true)).toBe('Try again');

    // …and retry_discovery with NO session cannot re-run discovery either.
    expect(retryTargetForStage(transientWithGoodSession, false)).toBe('sign_in');
    expect(retryLabelForStage(transientWithGoodSession, false)).toBe('Back to sign in');

    // For every stage and both session states, the label and the action agree.
    const stages: Stage[] = [
      { kind: 'idle' },
      { kind: 'busy', label: 'Signing in…' },
      { kind: 'picker', slugs: ['alpha'] },
      { kind: 'no_instance', message: 'not provisioned' },
      transientWithGoodSession,
      staleSessionAfterFailedSignIn,
    ];
    for (const stage of stages) {
      for (const hasSession of [true, false]) {
        const target = retryTargetForStage(stage, hasSession);
        const label = retryLabelForStage(stage, hasSession);
        // `no_instance` says "Check again" ONLY when it can actually check again.
        // It used to return that literal unconditionally, so a sessionless
        // `no_instance` promised a re-check and then bounced to sign-in — the
        // same label/action divergence this test exists to forbid, surviving in
        // the one branch that was exempted from it.
        if (stage.kind === 'no_instance' && target === 'discovery') {
          expect(label).toBe('Check again');
        } else {
          expect(label).toBe(target === 'discovery' ? 'Try again' : 'Back to sign in');
        }
      }
    }
  });

  it('a sessionless `no_instance` promises sign-in, not a re-check it cannot perform', () => {
    // Unreachable today (`clearsSession` is false for `no_instance`, so a session
    // is always present) but one edit away from reachable, which is why the
    // label is derived rather than hardcoded.
    const stage: Stage = { kind: 'no_instance', message: 'not provisioned' };
    expect(retryTargetForStage(stage, true)).toBe('discovery');
    expect(retryLabelForStage(stage, true)).toBe('Check again');
    expect(retryTargetForStage(stage, false)).toBe('sign_in');
    expect(retryLabelForStage(stage, false)).toBe('Back to sign in');
  });

  it('the error state renders the message and the retry control', () => {
    // WIRING pin only — the decision is asserted above.
    const src = read('app', 'login.tsx');
    expect(src).toContain('login-error');
    expect(src).toContain('login-retry');
    expect(src).toContain('retryLabelForStage(stage, session !== null)');
    expect(src).toContain("retryTargetForStage(stage, session !== null) === 'discovery'");
  });

  it('the self-host lane is LOCKED while discovery is in flight — one config writer at a time', () => {
    // Both lanes write the same persisted server config. Saving a LAN host
    // mid-discovery lets the in-flight adopt overwrite it moments later with a
    // stale `previous_gateway_base_url`, corrupting the session-wipe bookkeeping.
    const src = read('app', 'login.tsx');
    expect(src).toContain('const serverLaneLocked = busy || devBusy');
    for (const control of ['login-change-server', 'login-dev-token', 'login-dev-submit']) {
      const at = src.indexOf(`testID="${control}"`);
      expect(at).toBeGreaterThan(-1);
      // The lock appears within the control's own props block.
      expect(src.slice(at, at + 400)).toContain('serverLaneLocked');
    }
  });

  it('the self-host card is OUTSIDE every conditional stage, so it never disappears', () => {
    const src = read('app', 'login.tsx');
    // The self-host card must not be nested inside a stage branch — it is
    // the fallback FROM those states, so it has to outlive all of them.
    expect(src).toContain('testID="login-server-card"');
    const card = src.indexOf('testID="login-server-card"');
    const errorState = src.indexOf("stage.kind === 'error'");
    const picker = src.indexOf("stage.kind === 'picker'");
    expect(errorState).toBeGreaterThan(-1);
    expect(picker).toBeGreaterThan(-1);
    // Rendered after every stage block, at the top level of the screen.
    expect(card).toBeGreaterThan(errorState);
    expect(card).toBeGreaterThan(picker);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (g) auth_base_url unconfigured → honest state, no fabricated URL
// ─────────────────────────────────────────────────────────────────────────

describe('(g) no identity service → an honest state and NO fabricated URL', () => {
  it('isIdentityConfigured is false for every non-origin value', () => {
    for (const value of ['', '   ', '/', 'auth.example.com', 'javascript:alert(1)']) {
      expect(isIdentityConfigured(value)).toBe(false);
    }
    expect(isIdentityConfigured(AUTH_BASE)).toBe(true);
  });

  it('a request with no identity base fails as `identity_not_configured` and NEVER fetches', async () => {
    // The old bug shape: an empty base concatenated into a schemeless
    // relative URL ('/v1/route'), which on web resolves against the app's
    // own origin. Nothing may leave the device.
    let fetched = 0;
    const spy = (async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const found = await discoverInstance({
      auth_base_url: '',
      session_token: 'account-scoped-token',
      fetchFn: spy,
    });
    const signedIn = await signInWithPassword({
      auth_base_url: '',
      email: 'owner@example.com',
      password: 'pw',
      fetchFn: spy,
    });

    expect(!found.ok && found.failure.kind).toBe('identity_not_configured');
    expect(!signedIn.ok && signedIn.failure.kind).toBe('identity_not_configured');
    expect(fetched).toBe(0);
  });

  it('the screen renders the honest notice INSTEAD of a sign-in form it could not send', () => {
    const src = read('app', 'login.tsx');
    expect(src).toContain('isIdentityConfigured');
    expect(src).toContain('login-identity-unconfigured');
    // The sign-in card is gated on the same predicate the client uses, so
    // the screen can never offer a form the client would refuse.
    expect(src).toContain('identityConfigured ? (');
  });

  it('no identity or instance address is hardcoded anywhere in the app', () => {
    // Ryan-locked: mobile builds NEVER carry a baked instance URL.
    //
    // Matches ANY http(s) string literal in code, not just an assignment. The
    // narrower `= 'https://…'` form this started as missed a URL returned from a
    // function, passed as an argument, or sitting in an object literal — i.e.
    // `fetch('https://my-instance…')` would have slipped straight through a test
    // whose stated guarantee is "nothing is hardcoded anywhere".
    const LITERAL_URL = /['"`]https?:\/\/[^'"`\s]/;
    /**
     * NAMED, reviewable allowances — not a category exemption. Each entry is a
     * literal that is provably NOT an identity or instance address:
     *   - `lib/server-url.ts` — `LOCAL_DEV_SUGGESTION`, the localhost hint
     *     offered in the self-host form (a suggestion, never a default).
     *   - `lib/citation-chip-row.tsx` — a third-party FAVICON endpoint for
     *     hosts the agent cited. Nothing routes the app through it.
     * Anything else must be an `example.com` / `.test` host.
     *
     * ALLOWANCES ARE PER-LINE, NOT PER-FILE. A whole-file skip meant the stated
     * guarantee ("no instance URL anywhere") did not actually hold there — a real
     * instance address added ANYWHERE in `lib/server-url.ts`, which already
     * contains one localhost literal, would have passed. Each entry below names
     * the exact constant it permits, so any OTHER literal in the same file still
     * fails the scan.
     */
    const ALLOWED: { file: string; literal: RegExp }[] = [
      // The localhost hint offered in the self-host form (a suggestion, never a
      // default) — and only on the line that defines it.
      { file: join('lib', 'server-url.ts'), literal: /LOCAL_DEV_SUGGESTION/ },
      // A third-party favicon endpoint for hosts the agent cited. Nothing routes
      // the app through it.
      { file: join('lib', 'citation-chip-row.tsx'), literal: /favicon/i },
    ];
    const offenders = sourceFiles(['app', 'components', 'lib']).filter((file) => {
      const allowances = ALLOWED.filter((a) => file.endsWith(a.file));
      return codeLinesOf(readFileSync(file, 'utf8')).some(
        (line) =>
          LITERAL_URL.test(line) &&
          !/example\.(com|test)/.test(line) &&
          !allowances.some((a) => a.literal.test(line)),
      );
    });
    expect(offenders.map((f) => f.replace(`${APP_ROOT}/`, ''))).toEqual([]);
  });

  it('the widened scan actually CATCHES a non-assignment literal (guard against a vacuous regex)', () => {
    // Mutation-proofing the test above: the previous assignment-only form
    // passed on all four of these.
    const LITERAL_URL = /['"`]https?:\/\/[^'"`\s]/;
    for (const line of [
      "  return fetch('https://my-instance.somewhere/api');",
      '  const cfg = { base: `https://my-instance.somewhere` };',
      "  send('POST', 'https://my-instance.somewhere');",
      '  return `https://${slug}.somewhere`;',
    ]) {
      expect(LITERAL_URL.test(line)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (h) the self-host typed-URL path still works, with no session
// ─────────────────────────────────────────────────────────────────────────

describe('(h) the self-host typed-URL path still works end-to-end, session-free', () => {
  it('normalise → /healthz → persist, through the SAME commit path', async () => {
    const { commitServerConfig } = await import('../lib/server-url');
    const backing = makeBacking();
    const stub = stubFetch({});
    const result = await commitServerConfig({
      // Deliberately messy input: trailing slash, mixed case host.
      gateway_raw: '  https://Mine.Example.com/  ',
      auth_raw: '',
      previous_gateway_base_url: '',
      store: new WebTokenStorage(backing),
      fetchFn: stub.fn,
    });
    expect(result.ok).toBe(true);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBe('https://mine.example.com');
    // It really probed /healthz — not a blind persist.
    expect(stub.calls.some((c) => c.url === 'https://mine.example.com/healthz')).toBe(true);
  });

  it('a host that is not a Neutron gateway is refused', async () => {
    const backing = makeBacking();
    const stub = stubFetch({ healthz: { status: 200, body: '<html>router login</html>' } });
    const { commitServerConfig } = await import('../lib/server-url');
    const result = await commitServerConfig({
      gateway_raw: 'https://mine.example.com',
      auth_raw: '',
      previous_gateway_base_url: '',
      store: new WebTokenStorage(backing),
      fetchFn: stub.fn,
    });
    expect(result.ok).toBe(false);
    expect(backing.snapshot()[SERVER_GATEWAY_KEY]).toBeUndefined();
  });

  it('the form is mounted on /login, which needs no session to reach', () => {
    const src = read('app', 'login.tsx');
    expect(src).toContain('ServerConnectForm');
    // The #439 testIDs stay — the unauthenticated escape hatch is not a
    // regression surface (Argus r2 MAJOR on #385).
    expect(src).toContain('login-server-card');
    expect(src).toContain('login-server-url');
    expect(src).toContain('login-change-server');
    // /login is not behind the auth redirect guard.
    expect(src).not.toContain('shouldRedirectToLogin');
  });

  it('the dev-token lane survives for self-hosters and still gates on a server', () => {
    const src = read('app', 'login.tsx');
    expect(src).toContain('signInWithDevToken');
    expect(src).toContain('login-dev-submit');
    // Pasting a token before naming a host would fire at nowhere.
    expect(src).toContain('if (!loadAppConfig().configured)');
  });

  it('discovery and the typed form share ONE commit path (no dual writer)', () => {
    const callers = sourceFiles(['app', 'components', 'lib'])
      .filter((file) => !file.endsWith(join('lib', 'server-url.ts')))
      .filter((file) => /commitServerConfig\(/.test(readFileSync(file, 'utf8')))
      .map((f) => f.replace(`${APP_ROOT}/`, ''))
      .sort();
    // Exactly two callers, both delegating to the same implementation:
    // the typed form, and discovery's adopt step.
    expect(callers).toEqual(['components/ServerConnectForm.tsx', 'lib/identity-client.ts']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (i) the PROVIDER lane — password alone strands a real owner
// ─────────────────────────────────────────────────────────────────────────

/**
 * WHY THIS SECTION EXISTS. Round 1 shipped password sign-in as the only way in.
 * But an account created through the provider front door is stored with NO
 * usable password hash, and the identity service has no password-set or
 * password-reset endpoint at all — so that owner types their email and any
 * password, gets 401, and discovery NEVER runs. Not an edge case: the browser
 * front door is provider-first. So the provider lane is a requirement, and it
 * has to end in the same `IdentitySession` the password lane produces so there
 * is exactly ONE post-sign-in path.
 */
describe('(i) provider sign-in reaches the same session the password lane does', () => {
  const START = `${AUTH_BASE}${oauthStartPath('google')}`;
  const EXCHANGE = `${AUTH_BASE}${oauthExchangePath('google')}`;
  const REDIRECT = 'neutron://oauth/callback';

  /** Stubs the two provider endpoints for `google`. */
  function oauthFetch(input: {
    start?: { status: number; body: unknown };
    exchange?: { status: number; body: unknown };
  }): { fn: typeof globalThis.fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers['authorization'] ?? null,
        body: parsed,
      });
      if (url === START) {
        const spec = input.start ?? {
          status: 200,
          body: {
            authorizeUrl: 'https://accounts.example.com/authorize?client_id=x',
            state: 'STATE-1',
            codeVerifier: 'VERIFIER-1',
          },
        };
        return new Response(JSON.stringify(spec.body), { status: spec.status });
      }
      if (url === EXCHANGE) {
        const spec = input.exchange ?? {
          status: 200,
          body: {
            account: { user_id: 'u-1', email: 'owner@example.com' },
            createdAccount: false,
            linkedProvider: false,
            accessToken: 'account-scoped-token',
            refreshToken: 'refresh-1',
          },
        };
        return new Response(JSON.stringify(spec.body), { status: spec.status });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    return { fn, calls };
  }

  const succeedingBrowser = (url: string) => async () => ({ type: 'success', url });

  it('start then consent then exchange yields an ACCOUNT-scoped session, ready for discovery', async () => {
    const stub = oauthFetch({});
    const result = await signInWithOauth({
      auth_base_url: AUTH_BASE,
      provider: 'google',
      redirect_uri: REDIRECT,
      fetchFn: stub.fn,
      openAuthSession: succeedingBrowser(`${REDIRECT}?code=CODE-1&state=STATE-1`),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({
      user_id: 'u-1',
      email: 'owner@example.com',
      session_token: 'account-scoped-token',
      refresh_token: 'refresh-1',
    });
  });

  it('the service owns PKCE — the app REPLAYS the verifier it was handed', async () => {
    // Deliberately not re-deriving a challenge client-side: two
    // implementations of the same protocol drift, and the service has one.
    const stub = oauthFetch({});
    await signInWithOauth({
      auth_base_url: AUTH_BASE,
      provider: 'google',
      redirect_uri: REDIRECT,
      fetchFn: stub.fn,
      openAuthSession: succeedingBrowser(`${REDIRECT}?code=CODE-1&state=STATE-1`),
    });
    expect(stub.calls.map((c) => ({ url: c.url, body: c.body }))).toEqual([
      { url: START, body: { redirectUri: REDIRECT } },
      {
        url: EXCHANGE,
        body: { code: 'CODE-1', redirectUri: REDIRECT, codeVerifier: 'VERIFIER-1' },
      },
    ]);
  });

  it('a MISMATCHED state is refused and the code is never spent', async () => {
    const stub = oauthFetch({});
    const result = await signInWithOauth({
      auth_base_url: AUTH_BASE,
      provider: 'google',
      redirect_uri: REDIRECT,
      fetchFn: stub.fn,
      openAuthSession: succeedingBrowser(`${REDIRECT}?code=CODE-1&state=SOMEONE-ELSES`),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind).toBe('oauth_failed');
    // The exchange must NOT have been attempted with an unverified code.
    expect(stub.calls.map((c) => c.url)).toEqual([START]);
  });

  it('a provider-side refusal is reported, and the code is never spent', async () => {
    const stub = oauthFetch({});
    const result = await signInWithOauth({
      auth_base_url: AUTH_BASE,
      provider: 'google',
      redirect_uri: REDIRECT,
      fetchFn: stub.fn,
      openAuthSession: succeedingBrowser(`${REDIRECT}?error=access_denied&state=STATE-1`),
    });
    expect(!result.ok && result.failure.kind).toBe('oauth_failed');
    expect(stub.calls.map((c) => c.url)).toEqual([START]);
  });

  it('the owner dismissing the sheet is CANCELLED and lands back on idle, not an error', async () => {
    const stub = oauthFetch({});
    const result = await signInWithOauth({
      auth_base_url: AUTH_BASE,
      provider: 'google',
      redirect_uri: REDIRECT,
      fetchFn: stub.fn,
      openAuthSession: async () => ({ type: 'cancel' }),
    });
    expect(!result.ok && result.failure.kind).toBe('oauth_cancelled');
    // Backing out must not leave a red error card shouting at them.
    expect(nextStageForFailure({ kind: 'oauth_cancelled' }, 'Sign-in was cancelled.')).toEqual({
      kind: 'idle',
    });
  });

  it('a provider this service does not offer is a NAMED state, not a bare 404', async () => {
    const stub = oauthFetch({ start: { status: 404, body: { error: 'unknown oauth provider' } } });
    const result = await signInWithOauth({
      auth_base_url: AUTH_BASE,
      provider: 'google',
      redirect_uri: REDIRECT,
      fetchFn: stub.fn,
      openAuthSession: succeedingBrowser(`${REDIRECT}?code=c&state=s`),
    });
    expect(!result.ok && result.failure).toEqual({
      kind: 'oauth_unavailable',
      provider: 'google',
    });
    expect(!result.ok && result.message).toContain('Google');
    // Non-retryable: retrying would ask a service that has no such lane.
    const stage = nextStageForFailure(
      { kind: 'oauth_unavailable', provider: 'google' },
      'not available',
    );
    expect(stage.kind === 'error' && stage.retry_discovery).toBe(false);
  });

  it('with NO identity service the lane refuses before any network call', async () => {
    let fetched = 0;
    const spy = (async () => {
      fetched += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const result = await signInWithOauth({
      auth_base_url: '',
      provider: 'google',
      redirect_uri: REDIRECT,
      fetchFn: spy,
      openAuthSession: async () => {
        throw new Error('browser must not open');
      },
    });
    expect(!result.ok && result.failure.kind).toBe('identity_not_configured');
    expect(fetched).toBe(0);
  });

  it('BOTH lanes are reachable on the screen, provider first', () => {
    // WIRING pin: the provider buttons must exist and must not be buried below
    // the password form — for a provider-created account they are the ONLY way in.
    const src = read('app', 'login.tsx');
    expect(src).toContain('login-google');
    expect(src).toContain('login-apple');
    expect(src).toContain("void handleOauth('google')");
    expect(src).toContain("void handleOauth('apple')");
    expect(src).toContain('login-submit');
    expect(src.indexOf('testID="login-google"')).toBeLessThan(src.indexOf('testID="login-email"'));
    // The real browser opener is injected from the screen, so the lane is live
    // rather than a function nobody calls.
    expect(src).toContain('WebBrowser.openAuthSessionAsync');
    expect(src).toContain("Linking.createURL('/oauth/callback')");
  });

  it('there is exactly ONE OAuth implementation in the app', () => {
    // The deleted lane targeted `/api/v1/install-token/exchange` and had zero
    // call sites. Two implementations, one pointing nowhere, is the banned
    // dual-code-path shape.
    const offenders = sourceFiles(['app', 'components', 'lib']).filter((file) =>
      /install-token|signInWithOauthProvider|buildStartUrl/.test(
        codeOf(readFileSync(file, 'utf8')),
      ),
    );
    expect(offenders.map((f) => f.replace(`${APP_ROOT}/`, ''))).toEqual([]);
  });

  it('the password inputs carry autofill hints so the primary surface is not retyped by hand', () => {
    const src = read('app', 'login.tsx');
    expect(src).toContain('autoComplete="email"');
    expect(src).toContain('textContentType="emailAddress"');
    expect(src).toContain('autoComplete="current-password"');
    expect(src).toContain('textContentType="password"');
  });

  it('the discovered provider is PASSED, not read from a stale `lane` closure', () => {
    // Argus round-2: `afterSignIn` called `setLane(provider)` and then
    // `runDiscovery` in the SAME render tick, so the closure `runDiscovery`
    // captured still held the previous render's `lane` — `'password'` on a first
    // sign-in. A "Continue with Google" therefore persisted `provider:
    // 'password'` and `settings.tsx` rendered a PASSWORD badge for an account
    // with no password. The provider is now a parameter, so the value that
    // reaches storage is the one the button declared.
    const src = read('app', 'login.tsx');
    const code = codeOf(src);
    expect(code).toContain('async function runDiscovery(');
    expect(code).toContain('provider: AuthProvider,');
    // The adopt call takes the PARAMETER…
    expect(code).toContain('await enterWithInstance(found.value, active, provider)');
    // …and no call site reads `lane` where a parameter is in scope.
    expect(code).not.toContain('enterWithInstance(found.value, active, lane)');
    // Every call site supplies it explicitly.
    expect(code).toContain('await runDiscovery(result.value, provider)');
    expect(code).toContain('void runDiscovery(session, lane)');
    expect(code).toContain('void runDiscovery(session, lane, slug)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (m) a 401 says what was actually refused
// ─────────────────────────────────────────────────────────────────────────

/**
 * 401 IS NOT ALWAYS A BAD PASSWORD. `/v1/route` and the refresh endpoint present a
 * SESSION credential, and the service answers 401 when it rejects that bearer —
 * so a Google user whose token was refused during discovery used to be told their
 * "email and password did not match", sending them to check a password they never
 * set (Argus round-2). The copy now names the credential that was presented.
 */
describe('(m) a 401 names the credential that was actually refused', () => {
  const unauthorized = (async () =>
    new Response(JSON.stringify({ error: 'nope' }), {
      status: 401,
    })) as unknown as typeof globalThis.fetch;

  it('a refused PASSWORD says email and password', async () => {
    const result = await signInWithPassword({
      auth_base_url: AUTH_BASE,
      email: 'owner@example.com',
      password: 'wrong',
      fetchFn: unauthorized,
    });
    expect(!result.ok && result.failure.kind).toBe('unauthorized');
    expect(!result.ok && result.message).toContain('email and password');
  });

  it('a refused SESSION bearer during discovery does NOT mention a password', async () => {
    const result = await discoverInstance({
      auth_base_url: AUTH_BASE,
      session_token: 'rejected-bearer',
      fetchFn: unauthorized,
    });
    expect(!result.ok && result.failure.kind).toBe('unauthorized');
    // The whole point: an OAuth owner must not be told to check a password.
    expect(!result.ok && result.message).not.toContain('password');
    expect(!result.ok && result.message?.toLowerCase()).toContain('session');
  });

  it('a refused REFRESH token reads as a dead session, not a typo', async () => {
    const result = await refreshIdentitySession({
      auth_base_url: AUTH_BASE,
      refresh_token: 'revoked',
      user_id: 'u-1',
      email: 'owner@example.com',
      fetchFn: unauthorized,
    });
    expect(!result.ok && result.failure.kind).toBe('unauthorized');
    expect(!result.ok && result.message).not.toContain('password');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (j) the persisted identity is the token's `sub` — never the instance slug
// ─────────────────────────────────────────────────────────────────────────

describe('(j) the persisted AuthUser.id is an IDENTITY, not an instance slug', () => {
  it('discovery reports the `sub` of the instance token it returns', async () => {
    const stub = stubFetch({ login: loginOk(), route: () => routeOk('acme') });
    const { found } = await signInAndAdopt(stub, makeBacking());
    expect(found !== null && found.ok && found.value.userId).toBe('u-1');
    // The slug is NOT the identity — that conflation is the defect.
    expect(found !== null && found.ok && found.value.userId).not.toBe('acme');
    expect(found !== null && found.ok && found.value.slug).toBe('acme');
  });

  it('a token whose sub cannot be read reports null rather than guessing', async () => {
    // The caller then falls back to the account id it already holds. Silently
    // substituting the slug is what broke every user-derived identifier.
    const stub = stubFetch({
      login: loginOk(),
      route: () => ({
        status: 200,
        body: { slug: 'acme', publicUrl: 'https://acme.example.com', accessToken: 'opaque' },
      }),
    });
    const { found } = await signInAndAdopt(stub, makeBacking());
    expect(found !== null && found.ok && found.value.userId).toBeNull();
  });

  it('the screen persists that identity and NOT the slug', () => {
    // Downstream, `'app:' + user.id` becomes the X-Neutron-Topic-Id a ZIP
    // import announces, and the server parses a user_id back out of it — a slug
    // there names no one and the import misroutes.
    const code = codeOf(read('app', 'login.tsx'));
    expect(code).toContain('id: instance.userId ?? accountUserId');
    expect(code).not.toContain('id: instance.slug');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// (k) the session RENEWS itself — "sign in once" must not decay
// ─────────────────────────────────────────────────────────────────────────

/**
 * The instance bearer is short-lived. Without renewal the whole point of this
 * sprint ("sign in and the app knows your instance") would quietly become
 * "retype your password every day" — the clock would undo the discovery. The
 * refresh token is persisted at sign-in and spent at launch.
 */
describe('(k) an aged-out session renews silently instead of demanding credentials', () => {
  const persisted = {
    user_id: 'u-1',
    email: 'owner@example.com',
    refresh_token: 'refresh-1',
    slug: 'acme',
  };

  function renewFetch(input: {
    refresh?: { status: number; body: unknown };
    route?: { status: number; body: unknown };
  }): { fn: typeof globalThis.fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers['authorization'] ?? null,
        body: parsed,
      });
      if (url === `${AUTH_BASE}${REFRESH_PATH}`) {
        const spec = input.refresh ?? {
          status: 200,
          body: { accessToken: 'account-scoped-token-2', refreshToken: 'refresh-2' },
        };
        return new Response(JSON.stringify(spec.body), { status: spec.status });
      }
      if (url === `${AUTH_BASE}${ROUTE_PATH}`) {
        const spec = input.route ?? routeOk('acme');
        return new Response(JSON.stringify(spec.body), { status: spec.status });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof globalThis.fetch;
    return { fn, calls };
  }

  const NOW = 1_800_000_000_000;
  const nowSec = Math.floor(NOW / 1_000);
  const expiredToken = instanceToken('acme', { expSec: nowSec - 10 });
  const freshToken = instanceToken('acme', { expSec: nowSec + 7_200 });

  it('a still-valid bearer is left ALONE — no request is made', async () => {
    const stub = renewFetch({});
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: freshToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome.kind).toBe('not_needed');
    expect(stub.calls).toEqual([]);
  });

  it('an EXPIRED bearer is refreshed, re-routed to the SAME instance, and rotated', async () => {
    const stub = renewFetch({});
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome.kind).toBe('renewed');
    expect(outcome.kind === 'renewed' && outcome.token).toBe(instanceToken('acme'));
    // Rotation: the NEW refresh token is what must be stored. Reusing the old
    // one is treated as theft server-side and revokes the whole family.
    expect(outcome.kind === 'renewed' && outcome.refresh_token).toBe('refresh-2');
    expect(stub.calls.map((c) => ({ url: c.url, body: c.body }))).toEqual([
      { url: `${AUTH_BASE}${REFRESH_PATH}`, body: { refreshToken: 'refresh-1' } },
      // PINNED to the adopted slug — auto-routing could otherwise move a
      // multi-instance owner's device to a different instance behind their back.
      { url: `${AUTH_BASE}${ROUTE_PATH}`, body: { slug: 'acme' } },
    ]);
    expect(stub.calls[1]?.authorization).toBe('Bearer account-scoped-token-2');
  });

  it('a REFUSED refresh token requires signing in again', async () => {
    const stub = renewFetch({ refresh: { status: 401, body: { error: 'reuse detected' } } });
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome).toEqual({ kind: 'sign_in_required', reason: 'unauthorized' });
  });

  it('being OFFLINE at launch DEFERS — it must never sign the owner out', async () => {
    const dead = (async () => {
      throw new Error('Network request failed');
    }) as unknown as typeof globalThis.fetch;
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: dead,
    });
    expect(outcome.kind).toBe('deferred');
  });

  it('a 5xx at the identity service also DEFERS, never signs out', async () => {
    const stub = renewFetch({ refresh: { status: 503, body: { error: 'unavailable' } } });
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome.kind).toBe('deferred');
    // The refresh never landed, so nothing rotated and there is nothing to save.
    expect(outcome.kind === 'deferred' && outcome.rotated_refresh_token).toBeUndefined();
  });

  /**
   * THE ROTATION-LOSS BUG (Argus round-2 MAJOR on PR #440).
   *
   * A refresh token is single-use: the instant the service answers the refresh, the
   * token we presented is REVOKED and the reply carries its replacement. If the
   * `/v1/route` hop then fails, the old code returned a bare `deferred` with
   * nowhere to put that replacement — so it was dropped, the next launch replayed
   * the revoked token, the service read that as a reuse attack and revoked the
   * whole family, and the owner was forced back to credentials permanently.
   *
   * That inverts the guarantee this whole section exists for: one flaky route hop
   * on a train would log someone out for good. These cover the gap the previous
   * defer tests left — both of them failed at the REFRESH step, so no test ever
   * exercised "refresh succeeded, route did not".
   */
  it('a route hop that fails AFTER a successful refresh still hands back the rotated token', async () => {
    const stub = renewFetch({ route: { status: 503, body: { error: 'unavailable' } } });
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome.kind).toBe('deferred');
    // `refresh-1` is now revoked server-side; `refresh-2` MUST reach the caller.
    expect(outcome.kind === 'deferred' && outcome.rotated_refresh_token).toBe('refresh-2');
    // Both hops really did run — the refresh was spent, which is what makes the
    // rotation unavoidable rather than hypothetical.
    expect(stub.calls.map((c) => c.url)).toEqual([
      `${AUTH_BASE}${REFRESH_PATH}`,
      `${AUTH_BASE}${ROUTE_PATH}`,
    ]);
  });

  it('carries the rotated token even when the route hop forces sign-in', async () => {
    // A 404-with-userId (the account owns no instance) signs the owner out. The
    // rotation still travelled, so a caller that persists before clearing cannot
    // leave a revoked token behind if the clear is interrupted.
    const stub = renewFetch({ route: { status: 404, body: { error: 'none', userId: 'u-1' } } });
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome.kind).toBe('sign_in_required');
    expect(outcome.kind === 'sign_in_required' && outcome.rotated_refresh_token).toBe('refresh-2');
  });

  it('a service that rotates to null propagates null, not "no rotation"', async () => {
    // `null` is a real value the service can return; `undefined` means the
    // refresh never happened. Collapsing the two would make the caller skip a
    // write it needs to perform.
    const stub = renewFetch({
      refresh: { status: 200, body: { accessToken: 'account-2' } },
      route: { status: 503, body: { error: 'unavailable' } },
    });
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: persisted,
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome.kind).toBe('deferred');
    expect(outcome.kind === 'deferred' && outcome.rotated_refresh_token).toBeNull();
  });

  it('the launch path PERSISTS the rotation before the access token, and never in parallel', () => {
    // WIRING pin for the caller half. A `Promise.all` could partial-write the NEW
    // bearer beside the OLD (revoked) refresh token — unrecoverable. Sequential,
    // refresh-token first, means the only partial state is a fresh refresh token
    // beside a still-valid older bearer, which the next launch simply renews.
    const code = codeOf(read('app', 'index.tsx'));
    expect(code).not.toContain('Promise.all');
    expect(code).toContain('if (outcome.rotated_refresh_token !== undefined)');
    const setSession = code.indexOf('store.setIdentitySession({ ...session, refresh_token: outcome.refresh_token })');
    const setToken = code.indexOf('store.setToken(outcome.token)');
    expect(setSession).toBeGreaterThan(-1);
    expect(setToken).toBeGreaterThan(setSession);
  });

  it('no persisted refresh token means sign-in is required — no silent retry loop', async () => {
    const stub = renewFetch({});
    const outcome = await renewInstanceSession({
      auth_base_url: AUTH_BASE,
      token: expiredToken,
      session: { ...persisted, refresh_token: null },
      now_ms: NOW,
      fetchFn: stub.fn,
    });
    expect(outcome).toEqual({ kind: 'sign_in_required', reason: 'no_refresh_token' });
    expect(stub.calls).toEqual([]);
  });

  it('expiry is read LOCALLY, and an unreadable token is never assumed expired', () => {
    expect(isTokenExpired(expiredToken, NOW)).toBe(true);
    expect(isTokenExpired(freshToken, NOW)).toBe(false);
    // Renew slightly BEFORE expiry so a request in flight does not 401.
    expect(isTokenExpired(instanceToken('acme', { expSec: nowSec + 30 }), NOW)).toBe(true);
    // The server is authoritative: guessing "expired" would sign out a working
    // self-hosted session whose token is an opaque `dev:` string.
    expect(isTokenExpired('dev:owner', NOW)).toBe(false);
    expect(isTokenExpired(instanceToken('acme').split('.').slice(0, 2).join('.'), NOW)).toBe(false);
  });

  it('the refresh material is PERSISTED at sign-in and wiped on sign-out', async () => {
    const backing = makeBacking();
    const store = new WebTokenStorage(backing);
    await store.setIdentitySession(persisted);
    expect(await store.getIdentitySession()).toEqual(persisted);
    expect(backing.snapshot()[IDENTITY_SESSION_KEY]).toBeDefined();
    // Signing out must not leave behind a credential that could mint a new one.
    await store.clearAll();
    expect(backing.snapshot()[IDENTITY_SESSION_KEY]).toBeUndefined();
    expect(await store.getIdentitySession()).toBeNull();
  });

  it('a corrupted persisted session reads as ABSENT, not as a garbage refresh token', async () => {
    // Spending a garbage token gets the whole family revoked as suspected theft.
    const backing = makeBacking();
    backing.setItem(IDENTITY_SESSION_KEY, 'not json {{{');
    const store = new WebTokenStorage(backing);
    expect(await store.getIdentitySession()).toBeNull();
    expect(backing.snapshot()[IDENTITY_SESSION_KEY]).toBeUndefined();
  });

  it('renewal is WIRED into the launch path and persists both new values', () => {
    const index = read('app', 'index.tsx');
    expect(index).toContain('renewInstanceSession');
    expect(index).toContain('store.setToken(outcome.token)');
    expect(index).toContain('store.setIdentitySession({ ...session, refresh_token:');
    // Only a REFUSED credential signs the owner out.
    expect(index).toContain("if (outcome === 'sign_in_required')");
    expect(index).toContain('clear();');
    // A self-hosted install (no identity session) is left entirely alone.
    expect(index).toContain('if (session === null) return null');
    // …and the sign-in path is what put the material there in the first place.
    expect(read('app', 'login.tsx')).toContain('store.setIdentitySession({');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ordering invariant — adopt BEFORE the session is persisted
// ─────────────────────────────────────────────────────────────────────────

describe('adopt-then-persist ordering — the session must survive the host change', () => {
  it('commitServerConfig WIPES a pre-existing session on a host change', async () => {
    // This is why login.tsx adopts FIRST and persists the instance token
    // SECOND. Reversing it would delete the token just discovered.
    const backing = makeBacking();
    backing.setItem(TOKEN_KEY, 'token-from-a-previous-instance');
    const stub = stubFetch({ login: loginOk(), route: () => routeOk('acme') });
    const { adopted } = await signInAndAdopt(stub, backing);
    expect(adopted?.ok).toBe(true);
    expect(adopted !== null && adopted.ok && adopted.session_cleared).toBe(true);
    expect(backing.snapshot()[TOKEN_KEY]).toBeUndefined();
  });

  it('login.tsx awaits the session write BEFORE bumping the config epoch', () => {
    const src = read('app', 'login.tsx');
    const persist = src.indexOf('store.setUser(authUser)');
    const bump = src.indexOf('setRuntimeServerConfig(adopted.config)');
    expect(persist).toBeGreaterThan(-1);
    expect(bump).toBeGreaterThan(persist);
    // Awaited, not fire-and-forget: the epoch bump remounts the tree and
    // the provider re-reads the user from storage.
    expect(src).toContain('await Promise.all([');
    const awaited = src.indexOf('await Promise.all([');
    expect(awaited).toBeGreaterThan(-1);
    expect(awaited).toBeLessThan(bump);
    // The renewal material is persisted in the SAME awaited batch, so a launch
    // right after sign-in can already renew.
    expect(src.slice(awaited, bump)).toContain('store.setIdentitySession({');
  });
});
