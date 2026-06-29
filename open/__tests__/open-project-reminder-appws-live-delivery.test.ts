/**
 * Open PROJECT-scoped reminder LIVE-DELIVERY wiring — the residual #105 missed.
 *
 * THE BUG (M1 E2E Round 2, 2026-06-29): #105 fixed GENERAL fired reminders so
 * they reach the `/ws/app/chat` client, but it ported the LEGACY web path's
 * per-project topic SUFFIXING (`web:<user>:<project>`) into the app-ws path —
 * mapping a project reminder (`topic_id = app-project:<id>`) to
 * `app:<user>:<id>`. The app-ws client, however, registers its live sender AND
 * replays history on the BARE `app:<user>` topic ONLY (project context is a
 * per-frame field, not a topic suffix). So a project reminder's live push
 * matched no registered sender (dropped) AND its durable row landed under a
 * topic the client never replays → the reminder VANISHED entirely.
 *
 * THE FIX: all fired reminders/briefs resolve to the owner's bare `app:<user>`
 * topic — the one surface the client binds + hydrates.
 *
 * This boots the REAL Open composition over a live `Bun.serve`, opens the
 * unified `/ws/app/chat` socket, inserts a PROJECT-scoped reminder
 * (`topic_id = app-project:<id>`, exactly what `app-reminders-surface` stamps),
 * fires it via the REAL tick loop, and asserts the composed body is (a) live-
 * pushed to the connected socket and (b) persisted under the bare `app:<owner>`
 * topic the client reads. FAILS pre-fix (suffixed topic → live drop + durable
 * row under `app:owner:<id>`), PASSES with the fix.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '../../migrations/runner.ts'
import { ProjectDb } from '../../persistence/index.ts'
import { composeProductionGraph } from '../../gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '../../runtime/substrate.ts'
import type { SessionHandle } from '../../runtime/session-handle.ts'
import type { Event } from '../../runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const REMINDER_BODY = 'PROJECT_NUDGE_LIVE_DELIVERY_OK'
const PROJECT_ID = 'acme-launch'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness { base: string; db: ProjectDb; close(): Promise<void> }
let harness: Harness | null = null

/** Mock substrate: composes a DISTINCTIVE reminder body so the test can assert
 *  the live frame carries the dispatcher's composed output. */
function recordingSubstrate(): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      const out = spec.prompt.includes('reminder agent') ? REMINDER_BODY : 'ok'
      async function* gen(): AsyncGenerator<Event> {
        yield { kind: 'token', text: out }
        yield { kind: 'completion', usage: { input_tokens: 1, output_tokens: 1 }, substrate_instance_id: 'mock' }
      }
      return {
        events: gen(),
        async respondToTool(): Promise<void> {},
        async cancel(): Promise<void> {},
        tool_resolution: 'internal',
      }
    },
  }
}

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-proj-reminder-live-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(async () => {
  if (harness !== null) { await harness.close(); harness = null }
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 40_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

async function startHarness(): Promise<Harness> {
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({
    env: process.env,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    substrateFactory: (() => recordingSubstrate()) as any,
  })
  const composition = await composer({ db, project_slug: 'owner' })
  const graph = await composeProductionGraph(composition)
  if (graph.fetch === undefined || graph.websocket === undefined) throw new Error('no fetch/ws')
  const server = Bun.serve({ port: 0, fetch: (req, srv) => graph.fetch!(req, srv), websocket: graph.websocket })
  return {
    base: `http://127.0.0.1:${server.port}`,
    db,
    close: async () => {
      await server.stop(true)
      for (const cleanup of composition.realmode_cleanups ?? []) { try { cleanup() } catch { /* */ } }
      await graph.shutdown()
      db.close()
    },
  }
}

describe('Open project-scoped reminder app-ws live delivery', () => {
  test('a fired PROJECT reminder reaches the connected socket + lands under app:<owner>', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-proj-reminder-live'
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')
    // Connect with a project context, exactly as the app does when viewing a project.
    const ws = new WebSocket(
      `${wsUrl}/ws/app/chat?token=dev:owner&platform=web&project_id=${PROJECT_ID}`,
    )
    const frames: Array<Record<string, unknown>> = []
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))) } catch { /* */ } }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })

    // Create a reminder via the real `/remind` path, then re-stamp it as a
    // PROJECT reminder (topic_id = `app-project:<id>`) the way the app reminders
    // surface does at create time. This is the destination shape that triggered
    // the bug.
    ws.send(JSON.stringify({
      v: 1, type: 'user_message',
      body: '/remind check the launch status in 5 minutes',
      client_msg_id: 'c-proj-remind-1',
    }))
    await waitFor(() => (harness!.db.raw().query('SELECT count(*) c FROM reminders').get() as { c: number }).c > 0, 10_000)
    const row = harness!.db.raw().query('SELECT id FROM reminders LIMIT 1').get() as { id: string }
    harness!.db.raw().run('UPDATE reminders SET topic_id = ? WHERE id = ?', [
      `app-project:${PROJECT_ID}`, row.id,
    ])

    const framesBeforeFire = frames.length

    // Nudge fire_at into the past; the REAL composition tick loop fires it.
    harness!.db.raw().run('UPDATE reminders SET fire_at = ? WHERE id = ?', [
      Math.floor(Date.now() / 1000) - 5, row.id,
    ])
    await waitFor(() => {
      const r = harness!.db.raw().query('SELECT status FROM reminders WHERE id = ?').get(row.id) as { status: string } | null
      return r?.status === 'fired'
    }, 40_000)
    await sleep(800)

    // (a) The fired PROJECT reminder reached the CONNECTED socket LIVE — pre-fix
    //     this never arrived (suffixed topic → no registered sender).
    const liveFrame = frames
      .slice(framesBeforeFire)
      .find((f) => f['type'] === 'agent_message' && typeof f['body'] === 'string' && (f['body'] as string).includes(REMINDER_BODY))
    expect(liveFrame).toBeDefined()

    // (b) Durable history row persisted under the BARE `app:owner` topic the
    //     client hydrates — NOT the suffixed `app:owner:<project>` that nothing
    //     replays.
    const durable = harness!.db.raw()
      .query('SELECT topic_id, body FROM button_prompts WHERE body = ?')
      .all(REMINDER_BODY) as Array<{ topic_id: string; body: string }>
    expect(durable.length).toBeGreaterThan(0)
    expect(durable[0]!.topic_id).toBe('app:owner')

    ws.close()
    await sleep(50)
  }, 60_000)
})
