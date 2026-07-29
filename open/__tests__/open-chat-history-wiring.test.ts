/**
 * Open chat-HISTORY surface wiring — composition reachability gate.
 *
 * THE BUG (Ryan, dogfooding 2026-06-20): after onboarding, reloading General
 * showed an EMPTY chat and switching projects showed only the single live WS
 * re-emit — even though `button_prompts` held the full conversation. Root
 * cause: `open/composer.ts` mounted the topic-rail surface (`chat_topics_surface`)
 * but NEVER mounted the history surface (`chat_history_surface`), so
 * `GET /api/v1/chat/history` 404'd in the composed Open server. The browser
 * logged `[chat] event=history-hydrate-failed status=404 — falling back to
 * live-WS-only` and rendered nothing. The handler (`createChatHistorySurface`)
 * + its own unit tests existed; only the Open-composer WIRING was missing (the
 * carve dropped it). The prior "fix" cleared the loading spinner (a separate
 * symptom) but left the 404 — so this is the regression lock that the missing
 * test let slip: it boots the REAL Open composition and asserts the route is
 * MOUNTED (200 with the owner cookie / 401 without), NOT 404.
 *
 * Mirrors `open-chat-topics-wiring.test.ts`. No ANTHROPIC_API_KEY — the box
 * boots LLM-less; the history surface does not depend on LLM credentials.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { signSessionCookie } from '@neutronai/landing/session-cookie.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const COOKIE_SECRET = 'open-test-secret-0123456789'

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
  db: ProjectDb
  close(): Promise<void>
}

let harness: Harness | null = null

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-chat-history-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = COOKIE_SECRET
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
  // Seed one resolved General turn directly into button_prompts so the
  // mounted surface returns real history (not just an empty array).
  const nowMs = Date.now()
  await db.run(
    `INSERT INTO button_prompts
       (prompt_id, topic_id, body, options_json, allow_freeform, expires_at,
        idempotency_key, created_at, delivered_at, resolved_at,
        resolution_freeform_text, kind)
     VALUES (?, 'web:owner', ?, '[]', 1, ?, ?, ?, ?, ?, ?, '')`,
    [
      'hist-1',
      'Welcome in! What are you working on?',
      nowMs + 3_600_000,
      'idem-hist-1',
      nowMs - 1000,
      nowMs - 1000,
      nowMs - 500,
      'building Neutron',
    ],
  )
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
    db,
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

/** Sign the owner session cookie the same way the composer's `openFetch` does. */
function ownerCookie(): string {
  const c = signSessionCookie('owner', COOKIE_SECRET, Date.now())
  return `${c.name}=${c.value}`
}

describe('Open chat-history surface wiring', () => {
  test('GET /api/v1/chat/history is MOUNTED and returns General history (regression: was 404)', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/v1/chat/history?limit=20`, {
      headers: { cookie: ownerCookie() },
    })
    // The bug surfaced as a 404 here (surface not wired in the Open composer).
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      turns: Array<{ prompt_id: string; body: string; resolved: boolean; resolution_text: string }>
    }
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.turns)).toBe(true)
    const seeded = body.turns.find((t) => t.prompt_id === 'hist-1')
    expect(seeded).toBeDefined()
    expect(seeded!.body).toContain('What are you working on')
    expect(seeded!.resolved).toBe(true)
    expect(seeded!.resolution_text).toBe('building Neutron')
  }, 30_000)

  test('GET /api/v1/chat/history 401s without the owner cookie (mounted, not 404)', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/v1/chat/history?limit=20`)
    expect(res.status).toBe(401)
  }, 30_000)
})
