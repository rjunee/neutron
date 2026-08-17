/**
 * Open PROJECT-scoped reminder LIVE-DELIVERY wiring — a fire lands on the topic
 * that owns the work.
 *
 * THE BUG (measured 2026-08-15): 24 reminder fires landed on the bare
 * `app:owner` topic over one night while the owner was reading — and writing in
 * — `app:owner:neutron-open`. `resolveAppWsReminderTopic` in `open/composer.ts`
 * discarded the reminder's stored destination and returned General for EVERY
 * fire. This file previously DOCUMENTED that as the fix (the residual #105,
 * 2026-06-29), and it was correct then: the app-ws client bound + hydrated the
 * bare `app:<user>` topic only, so a project-suffixed delivery topic dropped the
 * live push and buried the durable row where nothing replayed it. App-ws topic
 * scoping (`gateway/http/app-ws-surface.ts` `resolveChannelTopicId`, ISSUES
 * #399) superseded that premise: each project chat now binds AND hydrates its
 * own `app:<user>:<project>` topic.
 *
 * THE CONTRACT PINNED HERE (`open/wiring/reminder-topic.ts`): a fire whose
 * stored destination names an EXISTING project delivers to
 * `app:<owner>:<project>` — live to a socket bound to that project, and durably
 * under that topic. A reminder with NO destination still fires into General.
 * (A destination naming no existing project also falls back to General — the
 * #105 lesson kept, unit-pinned in `open/wiring/__tests__/reminder-topic.test.ts`.)
 *
 * This boots the REAL Open composition over a live `Bun.serve`, opens the
 * unified `/ws/app/chat` socket bound to the PROJECT, inserts a PROJECT-scoped
 * reminder (`topic_id = app-project:<id>`, exactly what `app-reminders-surface`
 * stamps), fires it via the REAL tick loop, and asserts the composed body is
 * (a) live-pushed to the project socket and (b) persisted under
 * `app:<owner>:<project>`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const REMINDER_BODY = 'PROJECT_NUDGE_LIVE_DELIVERY_OK'
const PROJECT_ID = 'acme-launch'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
  // A LIVE instance's identity config leaks in through `process.env` when the
  // suite runs on a provisioned box: `NEUTRON_IDENTITY_JWKS_URL` puts the app-ws
  // auth resolver in `jwks` mode, which rejects the `dev:owner` bearer this
  // harness connects with (`channels/adapters/app-ws/auth.ts`).
  'NEUTRON_IDENTITY_JWKS_URL', 'NEUTRON_IDENTITY_AUDIENCE',
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
  delete process.env['NEUTRON_IDENTITY_JWKS_URL']
  delete process.env['NEUTRON_IDENTITY_AUDIENCE']
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
  seedMigratedDb(process.env['NEUTRON_DB_PATH']!)
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  // Seed the project row the way onboarding would. The resolver only honours a
  // destination naming an EXISTING project (`readProjectRows`), so without this
  // row a project-stamped fire correctly falls back to General.
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, 'private', 'personal', ?, ?)`,
    [PROJECT_ID, 'Acme Launch', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
  )
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
  test('a fired PROJECT reminder reaches the PROJECT socket + lands under app:<owner>:<project>', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-proj-reminder-live'
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')
    // Connect the PROJECT socket — the surface reads `project_id` off the
    // upgrade query string and binds `app:owner:<project>` (`resolveChannelTopicId`).
    // This is the topic the owner is actually reading when a project reminder
    // fires; pre-fix the fire went to General and he saw nothing here.
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
    // PROJECT reminder the way `reminders_create` does at create time: the RAW
    // project id in `topic_id` (`cores/free/reminders/src/backend.ts` stores
    // `topic_id: input.project_id ?? null`). This is the PRODUCTION-DOMINANT
    // destination shape — 94 of the 97 live reminder rows at the time of the fix —
    // and the one the misrouted fires carried. (`app-project:<id>`, what the app
    // reminders surface stamps, is covered in the unit table.)
    ws.send(JSON.stringify({
      v: 1, type: 'user_message',
      body: '/remind check the launch status in 5 minutes',
      client_msg_id: 'c-proj-remind-1',
    }))
    await waitFor(() => (harness!.db.raw().query('SELECT count(*) c FROM reminders').get() as { c: number }).c > 0, 10_000)
    const row = harness!.db.raw().query('SELECT id FROM reminders LIMIT 1').get() as { id: string }
    harness!.db.raw().run('UPDATE reminders SET topic_id = ? WHERE id = ?', [PROJECT_ID, row.id])

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

    // (a) The fired PROJECT reminder reached the PROJECT socket LIVE — pre-fix
    //     the fire resolved to General and this socket never saw it.
    const liveFrame = frames
      .slice(framesBeforeFire)
      .find((f) => f['type'] === 'agent_message' && typeof f['body'] === 'string' && (f['body'] as string).includes(REMINDER_BODY))
    expect(liveFrame).toBeDefined()

    // (b) Durable history row persisted under the PROJECT topic the project chat
    //     binds AND hydrates — not the General inbox the owner was not reading.
    const durable = harness!.db.raw()
      .query('SELECT topic_id, body FROM button_prompts WHERE body = ?')
      .all(REMINDER_BODY) as Array<{ topic_id: string; body: string }>
    expect(durable.length).toBeGreaterThan(0)
    expect(durable[0]!.topic_id).toBe(`app:owner:${PROJECT_ID}`)

    // (c) The project RAIL learned about it. Routing the fire to the project
    //     topic is only half of "the owner sees it": if `last_activity_at` is
    //     never stamped, the project does not pop, the unread badge does not
    //     move, and the fire is invisible unless he is already sitting inside
    //     that project. The deliver seam derives the project id back off the
    //     topic so an out-of-turn post stamps exactly like a steady-state reply.
    const stamped = harness!.db.raw()
      .query('SELECT last_activity_at FROM projects WHERE id = ?')
      .get(PROJECT_ID) as { last_activity_at: string | null } | null
    expect(stamped?.last_activity_at).not.toBeNull()

    ws.close()
    await sleep(50)
  }, 60_000)

  test('a reminder with NO destination still fires into General', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-general-reminder-live'
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')
    // The GENERAL socket (no `project_id` → bare `app:owner`). Guards against
    // over-rotating the fix: an instance-level reminder must NOT acquire a
    // project topic just because a project exists.
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    const frames: Array<Record<string, unknown>> = []
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))) } catch { /* */ } }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })

    // Create the reminder through the real `/remind` path and leave its
    // destination alone (no `app-project:` re-stamp).
    ws.send(JSON.stringify({
      v: 1, type: 'user_message',
      body: '/remind check the launch status in 5 minutes',
      client_msg_id: 'c-general-remind-1',
    }))
    await waitFor(() => (harness!.db.raw().query('SELECT count(*) c FROM reminders').get() as { c: number }).c > 0, 10_000)
    const row = harness!.db.raw().query('SELECT id FROM reminders LIMIT 1').get() as { id: string }
    harness!.db.raw().run('UPDATE reminders SET topic_id = NULL WHERE id = ?', [row.id])

    harness!.db.raw().run('UPDATE reminders SET fire_at = ? WHERE id = ?', [
      Math.floor(Date.now() / 1000) - 5, row.id,
    ])
    await waitFor(() => {
      const r = harness!.db.raw().query('SELECT status FROM reminders WHERE id = ?').get(row.id) as { status: string } | null
      return r?.status === 'fired'
    }, 40_000)
    await sleep(800)

    const durable = harness!.db.raw()
      .query('SELECT topic_id, body FROM button_prompts WHERE body = ?')
      .all(REMINDER_BODY) as Array<{ topic_id: string; body: string }>
    expect(durable.length).toBeGreaterThan(0)
    expect(durable[0]!.topic_id).toBe('app:owner')

    ws.close()
    await sleep(50)
  }, 60_000)
})
