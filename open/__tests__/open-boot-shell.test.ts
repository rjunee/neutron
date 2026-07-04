/**
 * Sprint D — Open single-owner boot shell integration test.
 *
 * The HEADLINE acceptance for the boot shell: a fresh boot of the Open
 * server stands up the real HTTP surface — /healthz + the gated `/chat`
 * entry — through the real `boot()` shell (real Bun.serve, real composer),
 * with NO mocks for the HTTP surface, and asserts:
 *
 *   1. /healthz answers (liveness preserved).
 *   2. A fresh GET /chat (no session) mints the owner cookie + a local
 *      start-token and bounces to /chat?start=<token>.
 *   3. ISSUES #318 — with NO Claude substrate credential, GET /chat renders the
 *      "Authenticate Claude to continue" gate (503) INSTEAD of the chat shell,
 *      so a fresh box never presents an interactive-looking chat that can't run.
 *   4. A returning visit with a resumable session still gates the page on
 *      auth (the gate is credential-, not session-, scoped).
 *   5. A valid-but-stale cookie over an empty DB cold-starts onboarding
 *      (302 to a fresh start-token) rather than wedging.
 *
 * The chat WebSocket itself is exercised by the app-ws onboarding suite —
 * onboarding + chat are unified on `/ws/app/chat`; the landing server's
 * legacy `/ws/chat` socket was removed.
 *
 * No ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN is set, so the chat PAGE is
 * gated on auth per ISSUES #318.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createIsolatedHome, type IsolatedHome } from '../../tests/support/test-isolation.ts'

import { boot } from '../../gateway/index.ts'
import type { BootHandle } from '../../gateway/index.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import { __resetAmbientAuthCacheForTests } from '../ambient-claude-auth.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

let home: IsolatedHome
let handle: BootHandle | null = null

beforeEach(() => {
  // Shared G9 test-isolation testkit: a fresh, unique NEUTRON_HOME tmpdir +
  // the standard per-instance env. The extra keys below are this suite's
  // boot-gate controls — all snapshotted and restored on teardown. See
  // tests/support/test-isolation.ts.
  home = createIsolatedHome({
    extraEnvKeys: [
      'NEUTRON_LANDING_STATIC_DIR',
      'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
      'ANTHROPIC_API_KEY',
      // ISSUES #318 — the auth gate is keyed on `resolveOpenLlmPool(env) === null`,
      // which is null only when BOTH substrate credentials are absent. A dev/CI box
      // with an ambient `CLAUDE_CODE_OAUTH_TOKEN` would otherwise disable the gate
      // and make the no-credential 503 assertions return the 200 shell. Save +
      // clear it alongside ANTHROPIC_API_KEY so these tests are env-independent.
      'CLAUDE_CODE_OAUTH_TOKEN',
      // #101 added a macOS Keychain ambient-auth probe that reads the Keychain
      // DIRECTLY (not env), so clearing the token above is not enough on a dev Mac
      // with a real `claude` login — it would resolve a pool and disable the gate.
      // Force the handoff default so these gate assertions are host-independent.
      'NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH',
      'NOTIFY_SOCKET',
      'NEUTRON_GRAPH_COMPOSER_MODULE',
    ],
    env: {
      NEUTRON_LANDING_STATIC_DIR: LANDING_DIR,
      NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: 'open-test-secret-0123456789',
      ANTHROPIC_API_KEY: undefined, // LLM-less → static onboarding prompts
      CLAUDE_CODE_OAUTH_TOKEN: undefined, // ISSUES #318 — keep the auth gate ACTIVE
      NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1', // ignore any host `claude` login
      NOTIFY_SOCKET: undefined,
      NEUTRON_GRAPH_COMPOSER_MODULE: undefined,
    },
  })
  __resetAmbientAuthCacheForTests() // drop a cached probe result from a prior test
})

afterEach(async () => {
  if (handle !== null) {
    await handle.shutdown({ force: true })
    handle = null
  }
  home.restore()
  // Generous hook budget: a booted Open server starts the cron scheduler +
  // watchdog and `shutdown({force:true})` can take several seconds to drain
  // them (slower still when ambient Anthropic creds are rate-limited and an
  // in-flight phase-spec LLM retry is unwinding). The default 5s hook timeout
  // flakily reports a passing test as failed when teardown overruns it.
}, 30_000)

async function bootOpen(): Promise<BootHandle> {
  const composer = buildOpenGraphComposer({ env: process.env })
  handle = await boot({ composer, port: 0 })
  return handle
}

/**
 * Persist a resumable `onboarding_state` row for the single owner by opening a
 * second connection to the same project.db the booted server uses (migrations
 * already applied). Lets the cookie-resume regression test assert the
 * has-resumable-state → serve-chat.html path WITHOUT driving `engine.start`
 * through the LLM (the static onboarding path needs Anthropic creds, which are
 * unavailable in CI/sandbox — see the pre-existing baseline failures).
 */
async function seedOnboardingState(): Promise<void> {
  const dbPath = process.env['NEUTRON_DB_PATH']!
  const db = ProjectDb.open(dbPath)
  try {
    const store = new SqliteOnboardingStateStore({ db })
    await store.upsert({ project_slug: 'owner', user_id: 'owner', phase: 'signup' })
  } finally {
    db.close()
  }
}

describe('Sprint D — Open single-owner boot shell', () => {
  test('a fresh boot serves /healthz', async () => {
    const h = await bootOpen()
    const res = await fetch(`http://127.0.0.1:${h.server.port}/healthz`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; project_slug: string }
    expect(body.status).toBe('ok')
    expect(body.project_slug).toBe('owner')
  }, 30_000)

  test('fresh GET /chat mints owner cookie + start-token and bounces to /chat?start', async () => {
    const h = await bootOpen()
    const res = await fetch(`http://127.0.0.1:${h.server.port}/chat`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')
    expect(loc).not.toBeNull()
    expect(loc!.startsWith('/chat?start=')).toBe(true)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    expect(setCookie!).toContain('__neutron_chat_session=')
  }, 30_000)

  test('no-credential GET /chat?start gates on auth (renders the Authenticate-Claude page, not the chat shell)', async () => {
    const h = await bootOpen()
    const base = `http://127.0.0.1:${h.server.port}`

    // 1. Fresh visit → mint token + cookie.
    const gate = await fetch(`${base}/chat`, { redirect: 'manual' })
    expect(gate.status).toBe(302)
    const token = new URL(gate.headers.get('location')!, base).searchParams.get('start')
    expect(token).not.toBeNull()

    // 2. ISSUES #318 — with NO Claude credential, /chat?start renders the auth
    //    gate (503), NOT the chat shell. The box must never present an
    //    interactive-looking chat it can't actually run.
    const chatRes = await fetch(`${base}/chat?start=${encodeURIComponent(token!)}`)
    expect(chatRes.status).toBe(503)
    const html = await chatRes.text()
    expect(html).toContain('Authenticate Claude to continue')
    expect(html).toContain('claude setup-token')
    expect(html).not.toContain('id="log"')
  }, 30_000)

  test('returning visit WITH a real resumable session still gates the page on auth (ISSUES #318)', async () => {
    const h = await bootOpen()
    const base = `http://127.0.0.1:${h.server.port}`

    // Mint the owner cookie via the gate.
    const gate = await fetch(`${base}/chat`, { redirect: 'manual' })
    const rawCookie = gate.headers.get('set-cookie')!
    const cookie = rawCookie.split(';')[0]! // __neutron_chat_session=<value>

    // Establish REAL resumable state — persist an `onboarding_state` row for
    // the owner (same effect `engine.start` has, but deterministic without the
    // LLM). With state present, the stale-cookie fallback must NOT fire — the
    // request reaches the chat handler (no 302 bounce).
    await seedOnboardingState()

    // ISSUES #318 — a returning visit with a resumable session reaches the chat
    // handler (no bounce), but with NO Claude credential the page renders the
    // auth gate (503), not the chat shell. The gate is credential-, not
    // session-, scoped: nobody gets a working chat until the box is authed.
    const chatRes = await fetch(`${base}/chat`, {
      headers: { cookie },
      redirect: 'manual',
    })
    expect(chatRes.status).toBe(503)
    const html = await chatRes.text()
    expect(html).toContain('Authenticate Claude to continue')
    expect(html).not.toContain('id="log"')
  }, 30_000)

  test('valid-but-stale cookie over an empty DB cold-starts onboarding (does NOT wedge)', async () => {
    const h = await bootOpen()
    const base = `http://127.0.0.1:${h.server.port}`

    // Mint the owner cookie WITHOUT ever starting onboarding — the DB is fresh
    // (0 projects, no `onboarding_state` row). This mirrors the owner re-running
    // install.sh while their browser still holds a prior-session cookie.
    const gate = await fetch(`${base}/chat`, { redirect: 'manual' })
    const rawCookie = gate.headers.get('set-cookie')!
    const cookie = rawCookie.split(';')[0]! // __neutron_chat_session=<value>

    // A returning /chat GET with the valid-but-stale cookie must NOT serve a
    // hanging chat.html — it falls back to the proven cold-start path: 302 to
    // /chat?start=<fresh token> so the client gets fresh onboarding instead of
    // a loader that waits forever on a resume that will never arrive.
    const chatRes = await fetch(`${base}/chat`, {
      headers: { cookie },
      redirect: 'manual',
    })
    expect(chatRes.status).toBe(302)
    const loc = chatRes.headers.get('location')
    expect(loc).not.toBeNull()
    expect(loc!.startsWith('/chat?start=')).toBe(true)
    // The fallback re-issues a usable owner cookie alongside the bounce.
    expect(chatRes.headers.get('set-cookie')).toContain('__neutron_chat_session=')
  }, 30_000)
})
