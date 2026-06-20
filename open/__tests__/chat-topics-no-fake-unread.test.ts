/**
 * chat-polish B (owner live-dogfood, 2026-06-20) — every project sidebar
 * showed a perpetual "1" unread badge that "always reset to 1".
 *
 * ROOT CAUSE: `ButtonStore.listTopicsByUser` derives `unread_count` as the
 * count of UNRESOLVED + unexpired `button_prompts`, and every materialized
 * project carries exactly ONE unresolved opening seed prompt — so the badge
 * sat at 1 forever. There is no per-topic last-read marker anywhere, so
 * "unread" is not real tracking; it is a fake indicator.
 *
 * THE FIX (decision = REMOVE per the owner's no-fake-indicators rule): the
 * Open topics surface no longer surfaces the count — it reports
 * `unread_count: 0`, so the client badge (which hides at 0) never paints.
 *
 * This test asserts the REAL observable: booting the REAL Open composition,
 * seeding a project whose ONLY chat row is its unresolved opening seed (the
 * exact shape that produced the perpetual "1"), `GET /api/v1/chat/topics`
 * returns `unread_count: 0` for that project — NOT 1.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { signSessionCookie } from '../../landing/session-cookie.ts'
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-no-fake-unread-'))
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
  // One real project (the way onboarding writes it).
  await db.run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES ('acme', 'Acme', 'private', 'personal', ?, ?)`,
    ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  )
  // Seed the project's UNRESOLVED, unexpired opening seed prompt — the exact
  // shape (`resolved_at IS NULL AND expires_at > now`) that listTopicsByUser
  // counted as unread=1 and that produced the perpetual badge.
  const nowMs = Date.now()
  await db.run(
    `INSERT INTO button_prompts
       (prompt_id, topic_id, body, options_json, allow_freeform, expires_at,
        idempotency_key, created_at, delivered_at, resolved_at)
     VALUES (?, 'web:owner:acme', ?, '[]', 1, ?, ?, ?, ?, NULL)`,
    [
      'seed-acme',
      "Welcome to Acme — what's the first thing you want to tackle here?",
      nowMs + 24 * 3_600_000,
      'idem-seed-acme',
      nowMs - 1000,
      nowMs - 900,
    ],
  )
  // Also an unresolved seed on General, to prove General doesn't get a fake
  // badge either.
  await db.run(
    `INSERT INTO button_prompts
       (prompt_id, topic_id, body, options_json, allow_freeform, expires_at,
        idempotency_key, created_at, delivered_at, resolved_at)
     VALUES (?, 'web:owner', ?, '[]', 1, ?, ?, ?, ?, NULL)`,
    [
      'seed-general',
      'Welcome in! What are you working on?',
      nowMs + 24 * 3_600_000,
      'idem-seed-general',
      nowMs - 1100,
      nowMs - 1000,
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

describe('Open chat-topics surface — no fake unread badge (chat-polish B)', () => {
  test('a project whose only row is its unresolved opening seed reports unread_count 0 (regression: was 1)', async () => {
    harness = await startHarness()
    const res = await fetch(`${harness.base}/api/v1/chat/topics`, {
      headers: { cookie: ownerCookie() },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      topics: Array<{ topic_id: string; project_id: string | null; unread_count: number }>
    }
    expect(body.ok).toBe(true)
    const acme = body.topics.find((t) => t.project_id === 'acme')
    expect(acme).toBeDefined()
    // The bug: the unresolved opening seed made this a perpetual 1.
    expect(acme!.unread_count).toBe(0)
    // General must not carry a fake badge from its own unresolved seed either.
    const general = body.topics.find((t) => t.project_id === null)
    expect(general).toBeDefined()
    expect(general!.unread_count).toBe(0)
    // Every topic the surface returns reports 0 — no fake indicators anywhere.
    for (const t of body.topics) {
      expect(t.unread_count).toBe(0)
    }
  }, 30_000)
})
