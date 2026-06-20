/**
 * chat-polish A (owner live-dogfood, 2026-06-20) — the wow first-week brief
 * (the projects + overnight summary action 01 sends) must SURVIVE a General
 * reload.
 *
 * THE BUG: the wow dispatch's channel adapter `sendText` only did a live
 * `webRegistry.send({type:'agent_message'})` — it never wrote to
 * `button_prompts`, the chat-history store `GET /api/v1/chat/history` reads.
 * So the brief rendered live during onboarding and then VANISHED on reload;
 * the owner's DB showed 10 turns in `button_prompts`, none of them the brief.
 *
 * THE FIX: after a confirmed delivery, `sendText` persists the text to
 * `button_prompts` as an inert, already-resolved agent-bubble turn (best
 * effort; never disturbs the load-bearing throw-on-undelivered semantics).
 *
 * This test asserts the REAL observable outcome (not a mock):
 *   1. Driving the REAL `WowChannelAdapter` (`buildWowChannelAdapter`) over a
 *      real `ButtonStore` writes a `button_prompts` row with the brief body.
 *   2. Booting the REAL Open composition over that same DB and hitting
 *      `GET /api/v1/chat/history` returns the brief as a resolved agent turn.
 *   3. The load-bearing contract still holds: with no active WS, `sendText`
 *      THROWS and writes NOTHING (so the action-runner routes it to
 *      `outcome.failed[]` exactly as before).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { ButtonStore } from '../../channels/button-store.ts'
import { InMemoryWebChatSenderRegistry } from '../../gateway/http/chat-bridge.ts'
import { buildWowChannelAdapter } from '../../gateway/realmode-composer/build-wow-dispatcher.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { signSessionCookie } from '../../landing/session-cookie.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const COOKIE_SECRET = 'open-test-secret-0123456789'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

const OWNER_TOPIC = 'web:owner'
const BRIEF_BODY =
  'Welcome friend. Here is the week ahead.\n\nProjects on deck (2):\n- Acme\n- Globex\n\n' +
  "I've queued these to work on overnight while you sleep:\n- Refresh entity + topic graph"

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

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-wow-brief-persist-'))
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

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Sign the owner session cookie the same way the composer's `openFetch` does. */
function ownerCookie(): string {
  const c = signSessionCookie('owner', COOKIE_SECRET, Date.now())
  return `${c.name}=${c.value}`
}

describe('wow brief sendText persists to chat history (chat-polish A)', () => {
  test('sendText writes an inert resolved button_prompts row carrying the brief body', async () => {
    const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
    applyMigrations(db.raw())
    try {
      const buttonStore = new ButtonStore({ db })
      const webRegistry = new InMemoryWebChatSenderRegistry()
      const delivered: string[] = []
      webRegistry.register(OWNER_TOPIC, (event) => {
        if (event.type === 'agent_message') delivered.push(event.body)
      })
      const channel = buildWowChannelAdapter({ webRegistry, buttonStore })

      const res = await channel.sendText({ topic_id: OWNER_TOPIC, body: BRIEF_BODY })
      // Live delivery still happens (load-bearing).
      expect(res.message_id.startsWith('web-')).toBe(true)
      expect(delivered).toEqual([BRIEF_BODY])

      // Real observable: a persisted, RESOLVED row carrying the brief body.
      const rows = db
        .prepare<
          { body: string; resolved_at: number | null; options_json: string },
          [string]
        >(
          `SELECT body, resolved_at, options_json
             FROM button_prompts WHERE topic_id = ?`,
        )
        .all(OWNER_TOPIC)
      const briefRow = rows.find((r) => r.body === BRIEF_BODY)
      expect(briefRow).toBeDefined()
      expect(briefRow!.resolved_at).not.toBeNull()
      // Inert: no buttons.
      expect(briefRow!.options_json).toBe('[]')
    } finally {
      db.close()
    }
  }, 30_000)

  test('GET /api/v1/chat/history (real Open boot) returns the persisted brief as a resolved agent turn', async () => {
    const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
    applyMigrations(db.raw())
    const buttonStore = new ButtonStore({ db })
    const webRegistry = new InMemoryWebChatSenderRegistry()
    webRegistry.register(OWNER_TOPIC, () => {})
    const channel = buildWowChannelAdapter({ webRegistry, buttonStore })
    await channel.sendText({ topic_id: OWNER_TOPIC, body: BRIEF_BODY })

    const composer = buildOpenGraphComposer({ env: process.env })
    const composition = await composer({ db, project_slug: 'owner' })
    const graph = await composeProductionGraph(composition)
    if (graph.fetch === undefined || graph.websocket === undefined) {
      throw new Error('Open composition did not expose graph.fetch/websocket')
    }
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => graph.fetch!(req, srv),
      websocket: graph.websocket,
    })
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/api/v1/chat/history?limit=50`, {
        headers: { cookie: ownerCookie() },
      })
      expect(r.status).toBe(200)
      const body = (await r.json()) as {
        ok: boolean
        turns: Array<{ body: string; resolved: boolean; resolution_text: string | null }>
      }
      expect(body.ok).toBe(true)
      const brief = body.turns.find((t) => t.body === BRIEF_BODY)
      // Regression target: before the fix this was undefined (brief never persisted).
      expect(brief).toBeDefined()
      expect(brief!.resolved).toBe(true)
      // Inert agent bubble — empty resolution renders no user-side bubble.
      expect(brief!.resolution_text).toBe('')
    } finally {
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
    }
  }, 30_000)

  test('sendText with no active WS throws and persists NOTHING (load-bearing contract preserved)', async () => {
    const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
    applyMigrations(db.raw())
    try {
      const buttonStore = new ButtonStore({ db })
      const webRegistry = new InMemoryWebChatSenderRegistry() // no sender registered
      const channel = buildWowChannelAdapter({ webRegistry, buttonStore })

      await expect(
        channel.sendText({ topic_id: OWNER_TOPIC, body: BRIEF_BODY }),
      ).rejects.toThrow(/undelivered/)

      const count = db
        .prepare<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM button_prompts WHERE topic_id = ?`,
        )
        .get(OWNER_TOPIC)
      expect(count!.n).toBe(0)
    } finally {
      db.close()
    }
  }, 30_000)
})
