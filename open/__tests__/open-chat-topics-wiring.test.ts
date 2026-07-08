/**
 * Open chat-topics surface wiring — composition reachability gate.
 *
 * THE BUG (Ryan, dogfooding): the chat sidebar was empty after onboarding
 * created N projects. Root cause — `open/composer.ts` never set
 * `chat_topics_surface`, so `GET /api/v1/chat/topics` 404'd in the composed
 * Open server (`history-hydrate-failed status=404` → empty sidebar).
 *
 * This test boots the REAL Open composition (`buildOpenGraphComposer` →
 * `composeProductionGraph`, the same compose `boot()` runs) over a real
 * `Bun.serve`, seeds real `projects` rows, mints the owner session cookie via
 * the server's own `/` bounce, and asserts the sidebar route is MOUNTED and
 * returns the owner's projects (NOT 404).
 *
 * No ANTHROPIC_API_KEY is set — the box boots LLM-less; the topics surface
 * does not depend on LLM credentials.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-chat-topics-'))
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
  // Seed real projects the way onboarding would.
  for (const [id, name] of [
    ['acme', 'Acme'],
    ['globex', 'Globex'],
    ['initech', 'Initech'],
  ] as const) {
    await db.run(
      `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
       VALUES (?, ?, 'private', 'personal', ?, ?)`,
      [id, name, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
    )
  }
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

describe('Open chat-topics surface wiring', () => {
  test('GET /api/v1/chat/topics is MOUNTED and returns the owner projects (regression: was 404)', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/v1/chat/topics`, {
      headers: { cookie: ownerCookie() },
    })
    // The bug surfaced as a 404 here. The fix mounts the route.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      topics: Array<{ topic_id: string; project_id: string | null; name: string }>
    }
    expect(body.ok).toBe(true)
    // General + 3 projects.
    expect(body.topics.length).toBe(4)
    expect(body.topics[0]!.project_id).toBeNull()
    const ids = body.topics.filter((t) => t.project_id !== null).map((t) => t.project_id).sort()
    expect(ids).toEqual(['acme', 'globex', 'initech'])
  }, 30_000)

  test('GET /api/v1/chat/topics 401s without the owner cookie', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/v1/chat/topics`)
    expect(res.status).toBe(401)
  }, 30_000)
})
