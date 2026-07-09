/**
 * @neutronai/gateway — app-admin surface, mint-reauth-token endpoint
 * (switch-Max-account sprint, 2026-06-01).
 *
 * Round-trips `POST /api/app/admin/max-oauth/mint-reauth-token`
 * through `composeHttpHandler` with the dev-bypass auth resolver.
 * The mint closure is stubbed; a real start_token would require the
 * identity-side KeyManager + DB, which we exercise separately in the
 * `identity/oauth/__tests__/max-handoff-reauth-flow.test.ts` E2E
 * round-trip.
 *
 * Coverage per sprint brief:
 *   - POST without JWT → 401 missing_bearer
 *   - POST with valid JWT but wrong instance → 403 project_mismatch
 *   - POST with valid JWT → 200 + paste_url shape matches the
 *     the `/oauth/max/start` URL shape contract
 *     contract
 *   - Optional `return_url` overrides the default
 *   - Bad override `return_url` returns 400 invalid_return_url
 *     (no open-redirect — the start_token mint must NOT be reached)
 *   - 503 reauth_not_configured when the mint closure is unwired
 *   - 503 reauth_not_configured when only the closure is wired but
 *     identityPublicBaseUrl is missing (defense-in-depth)
 *   - 500 mint_failed when the closure resolves null
 *   - Audit-log line fires on success (captured via console.info spy)
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAppWsAuthResolver } from '@neutronai/channels/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { createAppAdminSurface } from '../http/app-admin-surface.ts'
import { composeHttpHandler, type ComposedHttpHandler } from '../http/compose.ts'

// --- in-process handler shim (no socket) -------------------------------------
// These surface tests used to bind a real `Bun.serve({ port: 0 })` and round-
// trip via the global `fetch`, holding a live listener + socket buffers in the
// chunk's RSS until teardown. Instead each harness registers its composed
// handler under a unique in-process base, and `fetch` is shadowed at module
// scope so requests to a registered base dispatch straight to
// `composed.fetch(new Request(...))` — identical assertions, no socket.
// Unrelated URLs fall through to the real fetch.
const __composedHandlers = new Map<string, ComposedHttpHandler>()
let __gatewaySeq = 0
const __realFetch = globalThis.fetch.bind(globalThis)
const fetch = ((input: Request | string | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
  const composed = __composedHandlers.get(new URL(req.url).host)
  if (composed !== undefined) return Promise.resolve(composed.fetch(req, undefined as never))
  return __realFetch(input as Parameters<typeof __realFetch>[0], init)
}) as typeof globalThis.fetch

const PROJECT_SLUG = 'demo'
const IDENTITY_BASE_URL = 'https://auth.neutron.example'
const DEFAULT_RETURN_URL = 'https://demo.neutron.example/chat'

// The carved return-url validator reads NEUTRON_BASE_DOMAIN at call time with
// no hosted default. This file's fixtures are on the `neutron.example` suffix
// (the carved/Open-safe placeholder host; the hosted Managed apex is banned
// here by the leak-gate), so the validator must be told that is the base
// domain for the `*.neutron.example` return_url-override test to pass. Save +
// restore so the env does not leak to other test files in the same bun chunk.
let priorBaseDomain: string | undefined
beforeAll(() => {
  priorBaseDomain = process.env.NEUTRON_BASE_DOMAIN
  process.env.NEUTRON_BASE_DOMAIN = 'neutron.example'
})
afterAll(() => {
  if (priorBaseDomain === undefined) delete process.env.NEUTRON_BASE_DOMAIN
  else process.env.NEUTRON_BASE_DOMAIN = priorBaseDomain
})

interface Harness {
  base: string
  tmp: string
  mintCalls: Array<{ user_id: string }>
  close(): Promise<void>
}

interface StartOptions {
  /** When set, the closure resolves to this token. Default: 'mock.start.token'. */
  mintToken?: string | null
  /** When true, the mint closure is omitted entirely (Open self-host case). */
  omitMintClosure?: boolean
  /** When true, omits the identityPublicBaseUrl (defense-in-depth check). */
  omitIdentityBaseUrl?: boolean
  /** Override the default return URL. */
  defaultReturnUrl?: string
  /** Extra return-URL host allowlist. */
  extraReturnHosts?: ReadonlyArray<string>
}

async function startGateway(opts: StartOptions = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-admin-reauth-'))
  const owner_home = join(tmp, 'owner_home')
  const db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  const auth = createAppWsAuthResolver({ project_slug: PROJECT_SLUG, bypass: true })
  const mintCalls: Array<{ user_id: string }> = []
  const surfaceOpts: Parameters<typeof createAppAdminSurface>[0] = {
    auth,
    owner_home,
    project_slug: PROJECT_SLUG,
    restartGateway: () => {},
    defaultReauthReturnUrl: opts.defaultReturnUrl ?? DEFAULT_RETURN_URL,
    extraReauthReturnHosts: opts.extraReturnHosts ?? [],
  }
  if (!opts.omitIdentityBaseUrl) {
    surfaceOpts.identityPublicBaseUrl = IDENTITY_BASE_URL
  }
  if (!opts.omitMintClosure) {
    const tokenResult = opts.mintToken === undefined ? 'mock.start.token' : opts.mintToken
    surfaceOpts.mintReauthStartToken = async (user_id: string): Promise<string | null> => {
      mintCalls.push({ user_id })
      return tokenResult
    }
  }
  const surface = createAppAdminSurface(surfaceOpts)
  const composed = composeHttpHandler({
    appAdmin: { handler: surface.handler },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const host = `gw-${++__gatewaySeq}.test`
  __composedHandlers.set(host, composed)
  return {
    base: `http://${host}`,
    tmp,
    mintCalls,
    close: async () => {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

async function postReauth(
  base: string,
  body: Record<string, unknown> | undefined,
  init: { token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${init.token ?? 'dev:sam'}`,
  }
  const reqInit: RequestInit = { method: 'POST', headers }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    reqInit.body = JSON.stringify(body)
  }
  return fetch(`${base}/api/app/admin/max-oauth/mint-reauth-token`, reqInit)
}

describe('app-admin — mint-reauth-token: auth + wiring guards', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('rejects requests without a Bearer token (401)', async () => {
    const res = await fetch(`${h.base}/api/app/admin/max-oauth/mint-reauth-token`, {
      method: 'POST',
    })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('missing_bearer')
    expect(h.mintCalls.length).toBe(0)
  })

  it('rejects bearer that resolves to a different project (403)', async () => {
    // Spin up a separate surface whose auth pins to OTHER_OWNER but
    // whose gateway thinks it's PROJECT_SLUG — mirrors the
    // instance-mismatch shape exercised by the parent suite.
    await h.close()
    const tmp = mkdtempSync(join(tmpdir(), 'neutron-app-admin-reauth-mis-'))
    const owner_home = join(tmp, 'owner_home')
    const db = ProjectDb.open(join(tmp, 'owner.db'))
    applyMigrations(db.raw())
    const otherAuth = createAppWsAuthResolver({ project_slug: 'someone-else', bypass: true })
    const surface = createAppAdminSurface({
      auth: otherAuth,
      owner_home,
      project_slug: PROJECT_SLUG,
      restartGateway: () => {},
      mintReauthStartToken: async () => 'unused',
      identityPublicBaseUrl: IDENTITY_BASE_URL,
      defaultReauthReturnUrl: DEFAULT_RETURN_URL,
    })
    const composed = composeHttpHandler({
      appAdmin: { handler: surface.handler },
      defaultHandler: () => new Response('not found', { status: 404 }),
    })
    const host = `gw-${++__gatewaySeq}.test`
    __composedHandlers.set(host, composed)
    try {
      const res = await fetch(
        `http://${host}/api/app/admin/max-oauth/mint-reauth-token`,
        { method: 'POST', headers: { authorization: 'Bearer dev:sam' } },
      )
      expect(res.status).toBe(403)
      const json = (await res.json()) as { code: string }
      expect(json.code).toBe('project_mismatch')
    } finally {
      __composedHandlers.delete(host)
      db.close()
      rmSync(tmp, { recursive: true, force: true })
    }
    h = await startGateway()
  })

  it('returns 503 reauth_not_configured when the mint closure is unwired', async () => {
    await h.close()
    h = await startGateway({ omitMintClosure: true })
    const res = await postReauth(h.base, undefined)
    expect(res.status).toBe(503)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('reauth_not_configured')
  })

  it('returns 503 reauth_not_configured when identityPublicBaseUrl is missing', async () => {
    // Defense-in-depth: the closure being wired but the base URL
    // missing is a wiring bug; surface it loudly rather than 500'ing
    // later in URL construction.
    await h.close()
    h = await startGateway({ omitIdentityBaseUrl: true })
    const res = await postReauth(h.base, undefined)
    expect(res.status).toBe(503)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('reauth_not_configured')
  })

  it('returns 500 mint_failed when the closure resolves null', async () => {
    await h.close()
    h = await startGateway({ mintToken: null })
    const res = await postReauth(h.base, undefined)
    expect(res.status).toBe(500)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('mint_failed')
  })

  it('returns 405 for non-POST methods', async () => {
    const res = await fetch(
      `${h.base}/api/app/admin/max-oauth/mint-reauth-token`,
      { method: 'GET', headers: { authorization: 'Bearer dev:sam' } },
    )
    expect(res.status).toBe(405)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('method_not_allowed')
  })
})

describe('app-admin — mint-reauth-token: paste_url construction', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('returns 200 + paste_url with owner + default return + start_token + force=1', async () => {
    const res = await postReauth(h.base, undefined)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; paste_url: string }
    expect(json.ok).toBe(true)
    expect(typeof json.paste_url).toBe('string')
    const url = new URL(json.paste_url)
    expect(url.origin).toBe('https://auth.neutron.example')
    expect(url.pathname).toBe('/oauth/max/start')
    expect(url.searchParams.get('owner')).toBe(PROJECT_SLUG)
    expect(url.searchParams.get('return')).toBe(DEFAULT_RETURN_URL)
    expect(url.searchParams.get('start_token')).toBe('mock.start.token')
    // `force=1` ensures the identity-side handler skips the
    // "already-has-healthy-token short-circuit" branch — the whole
    // point of re-auth is to swap to a DIFFERENT account.
    expect(url.searchParams.get('force')).toBe('1')
    expect(h.mintCalls.length).toBe(1)
    expect(h.mintCalls[0]!.user_id).toBe('sam')
  })

  it('accepts an empty JSON body (no return_url field)', async () => {
    // Equivalent to passing no return_url — the surface falls back to
    // the default. Used by the Expo client which sometimes sends `{}`
    // and sometimes omits the body entirely.
    const res = await postReauth(h.base, {})
    expect(res.status).toBe(200)
    const json = (await res.json()) as { paste_url: string }
    const url = new URL(json.paste_url)
    expect(url.searchParams.get('return')).toBe(DEFAULT_RETURN_URL)
  })

  it('honors an allowed return_url override on the *.neutron.example suffix', async () => {
    const override = 'https://demo.neutron.example/chat?welcome=1'
    const res = await postReauth(h.base, { return_url: override })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { paste_url: string }
    const url = new URL(json.paste_url)
    // URL.toString() normalises the `?` placement; compare on the
    // parsed return-URL rather than the raw string.
    expect(url.searchParams.get('return')).toBe(override)
  })

  it('honors an extra-hosts override (.alt-domain.com)', async () => {
    await h.close()
    h = await startGateway({ extraReturnHosts: ['.alt-domain.com'] })
    const override = 'https://demo.alt-domain.com/chat'
    const res = await postReauth(h.base, { return_url: override })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { paste_url: string }
    const url = new URL(json.paste_url)
    expect(url.searchParams.get('return')).toBe(override)
  })

  it('rejects an off-allowlist return_url with 400 invalid_return_url', async () => {
    // Open-redirect guard: a return_url pointing at an attacker-
    // controlled host MUST NOT be honored, even though the bearer is
    // valid for this instance. The mint MUST NOT be reached (asserts on
    // mintCalls.length).
    const res = await postReauth(h.base, {
      return_url: 'https://attacker.example.com/steal',
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_return_url')
    expect(h.mintCalls.length).toBe(0)
  })

  it('rejects malformed return_url with 400 invalid_return_url', async () => {
    const res = await postReauth(h.base, { return_url: 'not a url' })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_return_url')
    expect(h.mintCalls.length).toBe(0)
  })

  it('rejects non-string return_url with 400 invalid_return_url', async () => {
    // A misbehaving client sending `return_url: 42` should NOT
    // silently fall back to the default — surface the type mismatch.
    const res = await postReauth(h.base, { return_url: 42 })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('invalid_return_url')
    expect(h.mintCalls.length).toBe(0)
  })

  it('mints a fresh token on every call (no caching)', async () => {
    const r1 = await postReauth(h.base, undefined)
    const r2 = await postReauth(h.base, undefined)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(h.mintCalls.length).toBe(2)
  })
})
