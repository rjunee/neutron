/**
 * Focused unit coverage for `open/wiring/owner-gate.ts` (C3c carve).
 *
 * The owner gate is the SECURITY-sensitive single-owner http shell: owner-cookie
 * minting + one-shot start-token + the auth funnel. These tests drive the real
 * `openFetch` returned by `buildOpenOwnerGate` (real `buildLocalStartTokenAuth`
 * + real `InMemoryConsumedTokens` + a fake landing surface) and pin the CARE
 * invariants the carve MUST preserve verbatim:
 *
 *   1. Single-use `?start=` JTI — a replayed token does NOT re-mint the cookie.
 *   2. Cookie minted ONLY on first claim (not on a bare cookie-present GET, not
 *      on a failed claim).
 *   3. Stale-cookie-over-wiped-DB cold-start — a valid cookie but no/erroring
 *      resumable state funnels to `coldStartRedirect` (never strands the loader).
 *   4. Bootstrap injection — exact-regex replace on the `/chat-react.js` tag, and
 *      the `!html.includes('/chat-react.js')` guard no-ops when the tag is absent.
 *   5. Host-bound HMAC cookie — a cookie signed for a DIFFERENT slug is ignored
 *      (`readSessionCookie` returns null for a non-matching slug → cold-start).
 *   6. The two former byte-identical claim-then-mint blocks (SPA deep-link +
 *      `/chat` `?start=` gate), converged onto one shared helper, still
 *      claim-then-mint IDENTICALLY (same single-use JTI / mint-on-first-claim).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { InMemoryConsumedTokens } from '@neutronai/runtime/consumed-tokens-in-memory.ts'
import { signSessionCookie } from '@neutronai/landing/session-cookie.ts'
import type { LandingStackWithEngine } from '@neutronai/gateway/realmode-composer/build-landing-stack.ts'
import { buildLocalStartTokenAuth } from '../local-start-token.ts'
import { OWNER_USER_ID } from '../owner-identity.ts'
import type { OpenWiringContext } from '../wiring/context.ts'
import {
  buildOpenOwnerGate,
  type ProjectRailRow,
  type WireOwnerGateDeps,
} from '../wiring/owner-gate.ts'

const PROJECT_SLUG = 'owner'
const COOKIE_SECRET = 'test-cookie-secret'
// The exact chat-react shell marker the bootstrap injection replaces.
const REACT_SHELL_TAG = '<script type="module" src="/chat-react.js"></script>'
const REACT_SHELL_HTML = `<!doctype html><html><head></head><body>${REACT_SHELL_TAG}</body></html>`

let tmpDir: string
let db: ProjectDb

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-owner-gate-'))
  db = ProjectDb.open(join(tmpDir, 'project.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeCtx(env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): OpenWiringContext {
  return {
    llmPool: null,
    internal_handle: PROJECT_SLUG,
    owner_home: tmpDir,
    project_slug: PROJECT_SLUG,
    env,
    db,
    prewarmSubstrate: async (): Promise<void> => {},
  }
}

interface FakeLandingOpts {
  /** `stateStore.get` result: 'row' → resumable, 'null' → wiped DB, 'throw' → read error. */
  resume?: 'row' | 'null' | 'throw'
  /** HTML body the fake `landing.fetch` serves (default: the React shell). */
  html?: string
  /** content-type the fake `landing.fetch` serves (default: text/html). */
  contentType?: string
}

/** A minimal fake landing surface — only `stateStore.get` + `fetch` are read. */
function makeLanding(opts: FakeLandingOpts = {}): LandingStackWithEngine {
  const { resume = 'row', html = REACT_SHELL_HTML, contentType = 'text/html' } = opts
  return {
    stateStore: {
      get: async () => {
        if (resume === 'throw') throw new Error('stateStore read blew up')
        return resume === 'row' ? ({ phase: 'greeting' } as never) : null
      },
    },
    fetch: () =>
      new Response(html, { status: 200, headers: { 'content-type': contentType } }),
  } as unknown as LandingStackWithEngine
}

const SAMPLE_ROWS: ProjectRailRow[] = [
  {
    id: 'p1',
    label: 'Alpha',
    emoji: '🚀',
    unread: 0,
    last_activity_at: '2026-07-07T00:00:00.000Z',
    activity: 'idle',
    preview: null,
    preview_from: null,
    live_runs: 0,
  },
]

function makeGate(
  overrides: {
    landing?: LandingStackWithEngine
    readProjectRows?: () => ProjectRailRow[]
    env?: NodeJS.ProcessEnv
  } = {},
): { openFetch: ReturnType<typeof buildOpenOwnerGate>['openFetch']; startTokenAuth: ReturnType<typeof buildLocalStartTokenAuth> } {
  const startTokenAuth = buildLocalStartTokenAuth(COOKIE_SECRET)
  const deps: WireOwnerGateDeps = {
    cookieSecret: COOKIE_SECRET,
    startTokenAuth,
    consumedTokens: new InMemoryConsumedTokens(),
    landing: overrides.landing ?? makeLanding(),
    readProjectRows: overrides.readProjectRows ?? ((): ProjectRailRow[] => SAMPLE_ROWS),
  }
  const { openFetch } = buildOpenOwnerGate(makeCtx(overrides.env), deps)
  return { openFetch, startTokenAuth }
}

/** The Bun `server` arg is never touched by the gate — a bare cast suffices. */
const FAKE_SERVER = {} as import('bun').Server<unknown>

function getReq(pathAndQuery: string, cookieSlug?: string): Request {
  const headers = new Headers()
  if (cookieSlug !== undefined) {
    const c = signSessionCookie(cookieSlug, COOKIE_SECRET, Date.now())
    headers.set('cookie', `${c.name}=${c.value}`)
  }
  return new Request(`http://localhost${pathAndQuery}`, { method: 'GET', headers })
}

describe('owner gate — single-use ?start= JTI', () => {
  test('first /chat?start=T mints the cookie; a replay of the SAME token does not', async () => {
    const { openFetch, startTokenAuth } = makeGate()
    const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })

    const first = await openFetch(getReq(`/chat?start=${encodeURIComponent(token)}`), FAKE_SERVER)
    expect(first.headers.get('set-cookie')).not.toBeNull()

    const second = await openFetch(getReq(`/chat?start=${encodeURIComponent(token)}`), FAKE_SERVER)
    // JTI already claimed on first use → the gate refuses to re-mint.
    expect(second.headers.get('set-cookie')).toBeNull()
  })
})

describe('owner gate — cookie minted ONLY on a first successful claim', () => {
  test('a bare cookie-present /chat GET (resumable) serves chat.html with NO Set-Cookie', async () => {
    const { openFetch } = makeGate({ landing: makeLanding({ resume: 'row' }) })
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('a FAILED claim (bad token, no cookie) serves the page but mints NO cookie', async () => {
    const { openFetch } = makeGate()
    const res = await openFetch(getReq('/chat?start=not-a-valid-token'), FAKE_SERVER)
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('owner gate — stale-cookie-over-wiped-DB cold-start', () => {
  test('valid cookie but stateStore.get === null → 302 cold-start (never strands the loader)', async () => {
    const { openFetch } = makeGate({ landing: makeLanding({ resume: 'null' }) })
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })

  test('valid cookie but stateStore.get THROWS → fail-toward-cold-start (302)', async () => {
    const { openFetch } = makeGate({ landing: makeLanding({ resume: 'throw' }) })
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })
})

describe('owner gate — React shell bootstrap injection', () => {
  test('injects the project bootstrap before the /chat-react.js tag, preserving it', async () => {
    const { openFetch, startTokenAuth } = makeGate()
    const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })
    const res = await openFetch(getReq(`/chat?start=${encodeURIComponent(token)}`), FAKE_SERVER)
    const body = await res.text()
    // The canonical project list is injected …
    expect(body).toContain('window.__neutron_projects=')
    expect(body).toContain('"id":"p1"')
    expect(body).toContain('window.__neutron_user_id=')
    // … immediately before the preserved shell tag.
    expect(body).toContain(REACT_SHELL_TAG)
    expect(body.indexOf('window.__neutron_projects=')).toBeLessThan(body.indexOf(REACT_SHELL_TAG))
  })

  test('the !html.includes(/chat-react.js) guard no-ops when the tag is absent', async () => {
    const noShellHtml = '<!doctype html><html><body>auth gate — no shell here</body></html>'
    const { openFetch } = makeGate({
      landing: makeLanding({ resume: 'row', html: noShellHtml }),
    })
    // Valid cookie + resumable → serve + inject; the guard must leave it untouched.
    const res = await openFetch(getReq('/chat', PROJECT_SLUG), FAKE_SERVER)
    const body = await res.text()
    expect(body).toBe(noShellHtml)
    expect(body).not.toContain('window.__neutron_projects=')
  })
})

describe('owner gate — host-bound HMAC cookie (cross-instance / stale-slug ignored)', () => {
  test('a cookie signed for a DIFFERENT slug is ignored → cold-start', async () => {
    const { openFetch } = makeGate()
    // A validly-signed cookie, but for another instance's slug.
    const res = await openFetch(getReq('/chat', 'some-other-instance'), FAKE_SERVER)
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toMatch(/^\/chat\?start=/)
  })
})

describe('owner gate — the two converged claim-then-mint call sites are identical', () => {
  // Both the SPA deep-link (`GET /projects/…?start=`) path and the `/chat?start=`
  // gate now share `claimAndMintThenServe`. Proving BOTH exhibit the SAME
  // claim-then-mint + single-use semantics is what pins the dedup as behavior-
  // preserving.
  const cases: Array<{ name: string; path: (t: string) => string }> = [
    { name: '/chat?start=', path: (t) => `/chat?start=${encodeURIComponent(t)}` },
    {
      name: 'SPA deep-link /projects/p1/docs?start=',
      path: (t) => `/projects/p1/docs?start=${encodeURIComponent(t)}`,
    },
  ]
  for (const { name, path } of cases) {
    test(`${name}: first mints the cookie + injects; replay mints nothing`, async () => {
      const { openFetch, startTokenAuth } = makeGate()
      const token = startTokenAuth.mint({ project_slug: PROJECT_SLUG, user_id: OWNER_USER_ID })

      const first = await openFetch(getReq(path(token)), FAKE_SERVER)
      expect(first.headers.get('set-cookie')).not.toBeNull()
      // Both call sites run the SAME React-bootstrap injection on the body.
      expect(await first.text()).toContain('window.__neutron_projects=')

      const replay = await openFetch(getReq(path(token)), FAKE_SERVER)
      expect(replay.headers.get('set-cookie')).toBeNull()
    })
  }
})
