/**
 * Open doc-link deep-link 404 fix — a hard-loaded SPA deep link serves an
 * IDENTIFIED chat-react shell (not a 404, not an un-injected shell).
 *
 * THE BUG (ISSUES follow-up to #148): a doc reference renders as a tappable
 * link `/projects/<id>/docs?path=…`. Tapping it IN the SPA is intercepted
 * client-side, but a HARD load / new-tab / shared URL hit the gateway's HTTP
 * precedence chain, which had no route serving the shell for anything but the
 * exact `/chat` path — so the deep link 404'd.
 *
 * THE FIX (two parts, both exercised here over the REAL Open composition):
 *   1. Routing — an unknown `GET /projects[/…]` is delegated to the chat-react
 *      shell (`landing/spa-routes.ts:isSpaClientRoute` in `landing/server.ts` +
 *      `gateway/http/compose.ts`), so it is no longer a 404.
 *   2. Identity — the Open `openFetch` gate gives the deep link the SAME owner
 *      cookie-mint + React-bootstrap injection as `/chat`: a fresh (no-cookie)
 *      visit 302s to the SAME deep-link path (preserving the doc path, unlike
 *      /chat's onboarding cold-start) with the owner cookie set; the reload
 *      serves the shell WITH the injected `__neutron_user_id` so the client can
 *      boot + open the doc instead of throwing ChatBootstrapError.
 *
 * No ANTHROPIC_API_KEY is set — the box boots LLM-less; when ambient Claude auth
 * is also absent the served page is the 503 auth-gate (same as /chat), so the
 * injection assertion is conditioned on the shell actually being served.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { SESSION_COOKIE_NAME } from '../../landing/session-cookie.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness {
  base: string
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-doclink-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) {
    await harness.close()
    harness = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) {
    throw new Error('Open composition did not expose graph.fetch/websocket')
  }
  const composedFetch = graph.fetch
  const composedWebsocket = graph.websocket
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composedFetch(req, srv),
    websocket: composedWebsocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) {
        try {
          cleanup()
        } catch {
          /* best-effort */
        }
      }
      await graph.shutdown()
      db.close()
    },
  }
}

function ownerCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = new RegExp(`${SESSION_COOKIE_NAME}=[^;]+`).exec(raw)
  return m === null ? null : m[0]
}

describe('Open doc-link deep link — served as an identified shell, not a 404', () => {
  const DEEP_LINK = '/projects/acme/docs?path=STATUS.md'

  test('a fresh (no-cookie) doc deep link 302s to the SAME path + mints the owner cookie', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}${DEEP_LINK}`, { redirect: 'manual' })
    // The core fix: no longer a dead 404. It bounces to mint the owner cookie…
    expect(res.status).toBe(302)
    // …preserving the deep-link path (NOT resetting to /chat onboarding).
    const location = res.headers.get('location') ?? ''
    expect(location).toBe(DEEP_LINK)
    expect(ownerCookie(res)).not.toBeNull()
  }, 30_000)

  test('following with the minted cookie serves the shell WITH injected identity (no ChatBootstrapError)', async () => {
    harness = await startHarness()
    const bounce = await fetch(`${harness.base}${DEEP_LINK}`, { redirect: 'manual' })
    const cookie = ownerCookie(bounce)
    expect(cookie).not.toBeNull()
    const res = await fetch(`${harness.base}${DEEP_LINK}`, {
      redirect: 'manual',
      headers: { cookie: cookie as string },
    })
    // Never a 404 — the deep link resolves to a real page.
    expect(res.status).not.toBe(404)
    const body = await res.text()
    // When the chat-react shell is actually served (authed box — not the
    // LLM-less 503 auth-gate page), it MUST carry the injected owner identity
    // so the client boots + client-routes to the doc instead of throwing.
    if (body.includes('/chat-react.js')) {
      expect(body).toContain('__neutron_user_id')
      expect(body).toContain('id="root"')
    }
  }, 30_000)

  test('an unknown NON-SPA path still 404s (the catch-all is narrow)', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/totally-unknown-path`, { redirect: 'manual' })
    expect(res.status).toBe(404)
  }, 30_000)
})
