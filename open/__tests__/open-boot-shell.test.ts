/**
 * Sprint D — Open single-owner boot shell integration test.
 *
 * The HEADLINE acceptance for the boot shell: a fresh boot of the Open
 * server SERVES THE ONBOARDING FLOW — not just /healthz. This test boots the
 * real composer (`buildOpenGraphComposer`) through the real `boot()` shell —
 * real Bun.serve, real Bun WebSocket client, real onboarding engine, real
 * landing chat-bridge — with NO mocks for the HTTP / WS surface, and asserts:
 *
 *   1. /healthz answers (liveness preserved).
 *   2. A fresh GET /chat (no session) mints the owner cookie + a local
 *      start-token and bounces to /chat?start=<token>.
 *   3. ISSUES #318 — with NO Claude substrate credential, GET /chat renders the
 *      "Authenticate Claude to continue" gate (503) INSTEAD of the chat shell,
 *      so a fresh box never presents an interactive-looking chat that can't run.
 *   4. Opening /ws/chat?start=<token> serves the FIRST onboarding interview
 *      prompt on connect (engine.start → static signup spec, no LLM creds): the
 *      onboarding engine mechanics stay intact under the page gate, so the flow
 *      works the moment a credential is added.
 *   5. The chat WS ACCEPTS A TURN — a user_message advances the engine and a
 *      follow-up agent envelope arrives.
 *   6. The cookie-only resume path works — a returning visit with the owner
 *      session cookie upgrades /ws/chat WITHOUT a token and the session goes
 *      live (session_ready).
 *
 * No ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN is set, so (a) the chat PAGE is
 * gated on auth per ISSUES #318, and (b) the engine walks its static phase
 * prompts (the documented LLM-less fallback) at the WS layer — the first prompt
 * is deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot } from '../../gateway/index.ts'
import type { BootHandle } from '../../gateway/index.ts'
import { STATIC_PHASE_SPECS } from '../../onboarding/interview/phase-prompts.ts'
import { SqliteOnboardingStateStore } from '../../onboarding/interview/sqlite-state-store.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const SIGNUP_PROMPT_BODY = STATIC_PHASE_SPECS['signup']!.body

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  // ISSUES #318 — the auth gate is keyed on `resolveOpenLlmPool(env) === null`,
  // which is null only when BOTH substrate credentials are absent. A dev/CI box
  // with an ambient `CLAUDE_CODE_OAUTH_TOKEN` would otherwise disable the gate
  // and make the no-credential 503 assertions return the 200 shell. Save +
  // clear it alongside ANTHROPIC_API_KEY so these tests are env-independent.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
  'NEUTRON_GRAPH_COMPOSER_MODULE',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let handle: BootHandle | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-sprint-d-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['ANTHROPIC_API_KEY'] // LLM-less → static onboarding prompts
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'] // ISSUES #318 — keep the auth gate ACTIVE
  delete process.env['NOTIFY_SOCKET']
  delete process.env['NEUTRON_GRAPH_COMPOSER_MODULE']
})

afterEach(async () => {
  if (handle !== null) {
    await handle.shutdown({ force: true })
    handle = null
  }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface Envelope {
  type: string
  body?: string
  prompt_id?: string
  user_id?: string
  options?: unknown[]
}

/** Collect WS envelopes; resolve `firstReal` on the first non-typing frame. */
function wireSocket(ws: WebSocket): {
  opened: Promise<void>
  received: Envelope[]
  nextReal: (afterIdx: number, timeoutMs: number, extraSkip?: string[]) => Promise<Envelope>
} {
  const received: Envelope[] = []
  const TYPING = new Set(['agent_typing_start', 'agent_typing_stop', 'agent_typing_end'])
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (ev) => reject(new Error(`ws error: ${String(ev)}`)))
  })
  ws.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : String(ev.data)
    try {
      received.push(JSON.parse(data) as Envelope)
    } catch {
      /* ignore non-JSON frames */
    }
  })
  const nextReal = async (
    afterIdx: number,
    timeoutMs: number,
    extraSkip: string[] = [],
  ): Promise<Envelope> => {
    const skip = new Set([...TYPING, ...extraSkip])
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      for (let i = afterIdx; i < received.length; i++) {
        const e = received[i]!
        if (!skip.has(e.type)) return e
      }
      await sleep(20)
    }
    throw new Error(`nextReal: no real envelope after idx ${afterIdx} within ${timeoutMs}ms`)
  }
  return { opened, received, nextReal }
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

  test('no-credential GET /chat gates on auth; the onboarding WS still serves the first prompt AND accepts a turn', async () => {
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

    // 3. The onboarding engine itself is intact under the page gate — open the
    //    chat WS with the start-token → engine.start fires the first
    //    onboarding prompt on connect.
    const ws = new WebSocket(
      `ws://127.0.0.1:${h.server.port}/ws/chat?start=${encodeURIComponent(token!)}`,
    )
    const sock = wireSocket(ws)
    await sock.opened
    const first = await sock.nextReal(0, 10_000)
    expect(first.type).toBe('agent_message')
    expect(first.body).toBe(SIGNUP_PROMPT_BODY)
    expect(first.prompt_id).toBeDefined()

    // 4. The WS ACCEPTS A TURN — a user_message advances the engine and a
    //    follow-up agent envelope arrives.
    const beforeIdx = sock.received.length
    ws.send(JSON.stringify({ type: 'user_message', body: 'Casey' }))
    // Skip the session_ready lifecycle envelope (it lands just after the
    // opening prompt on the token path) — we want the engine's next turn.
    const followUp = await sock.nextReal(beforeIdx, 10_000, ['session_ready'])
    expect(['agent_message', 'button_prompt']).toContain(followUp.type)

    ws.close()
    await sleep(50)
  }, 30_000)

  test('returning visit WITH a real resumable session still gates the page on auth; resume WS mechanics intact (ISSUES #318)', async () => {
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

    // The resume MECHANICS are unaffected by the page gate: a cookie-only WS
    // upgrade (no ?start) still goes live (session_ready).
    const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/ws/chat`, {
      headers: { cookie },
    } as unknown as string)
    const sock = wireSocket(ws)
    await sock.opened
    const ready = await sock.nextReal(0, 10_000)
    expect(ready.type).toBe('session_ready')
    expect(ready.user_id).toBe('owner')

    ws.close()
    await sleep(50)
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
