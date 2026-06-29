/**
 * Open reminder + brief LIVE-DELIVERY wiring — the anti-"built-but-not-wired"
 * gate for fired reminders reaching the surface the owner actually uses.
 *
 * THE BUG (M1 E2E 2026-06-28, verified on an isolated instance): fired
 * reminders (and the proactive morning brief) were delivered over the LEGACY
 * `web:` chat registry (`landing.registry`) on the `web:<user>` topic. The only
 * client — the React/Expo app — connects to `/ws/app/chat` and binds its live
 * sender in `appWsRegistry` under `app:<user>`. So a fired reminder hit the
 * durable history but was NEVER live-pushed to the connected client (a
 * steady-state agent reply, delivered via `appWsRegistry` on `app:<user>`,
 * paints instantly). Net: you set a reminder, it fires, and nothing appears in
 * your chat until you reload.
 *
 * THE FIX: deliver reminders/briefs the SAME way the agent delivers its own
 * replies — over `appWsRegistry` on the owner's `app:<user>` topic, persisting
 * the durable row under that same topic.
 *
 * This boots the REAL Open composition over a live `Bun.serve`, opens the
 * unified `/ws/app/chat` socket, creates a reminder via the real `/remind`
 * command path, nudges its `fire_at` into the past, and asserts the REAL wired
 * tick loop + dispatcher (a) marks it fired, (b) live-pushes the composed body
 * to the CONNECTED socket (the wiring the bug had missing), and (c) persists the
 * durable row under the `app:<owner>` topic. The substrate is MOCKED (no real
 * `claude`); a synthetic credential makes the reminder LLM compose live.
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
const REMINDER_BODY = 'NUDGE_LIVE_DELIVERY_OK'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-reminder-live-'))
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

describe('Open reminder app-ws live delivery', () => {
  test('a fired reminder is live-pushed to the connected /ws/app/chat socket', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-reminder-live'
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(`${wsUrl}/ws/app/chat?token=dev:owner&platform=web`)
    const frames: Array<Record<string, unknown>> = []
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))) } catch { /* */ } }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })

    // Create a reminder via the real `/remind` chat-command path.
    ws.send(JSON.stringify({
      v: 1, type: 'user_message',
      body: '/remind hydrate yourself in 5 minutes',
      client_msg_id: 'c-remind-live-1',
    }))
    await waitFor(() => (harness!.db.raw().query('SELECT count(*) c FROM reminders').get() as { c: number }).c > 0, 10_000)
    const row = harness!.db.raw().query('SELECT id FROM reminders LIMIT 1').get() as { id: string }

    // Drop a delivery marker so we only count frames that arrive AFTER the fire.
    const framesBeforeFire = frames.length

    // Nudge fire_at into the past; the REAL composition tick loop (30s) fires it.
    harness!.db.raw().run('UPDATE reminders SET fire_at = ? WHERE id = ?', [
      Math.floor(Date.now() / 1000) - 5, row.id,
    ])
    await waitFor(() => {
      const r = harness!.db.raw().query('SELECT status FROM reminders WHERE id = ?').get(row.id) as { status: string } | null
      return r?.status === 'fired'
    }, 40_000)
    // The live push is fire-and-forget right after the claim; give it a beat.
    await sleep(800)

    // (a) The fired reminder's composed body reached the CONNECTED socket LIVE —
    //     this is the wiring the bug had missing.
    const liveFrame = frames
      .slice(framesBeforeFire)
      .find((f) => f['type'] === 'agent_message' && typeof f['body'] === 'string' && (f['body'] as string).includes(REMINDER_BODY))
    expect(liveFrame).toBeDefined()

    // (b) Durable history row persisted under the owner's app-ws topic (the same
    //     topic agent replies use), NOT the legacy `web:` namespace.
    const durable = harness!.db.raw()
      .query("SELECT topic_id, body FROM button_prompts WHERE body = ?")
      .all(REMINDER_BODY) as Array<{ topic_id: string; body: string }>
    expect(durable.length).toBeGreaterThan(0)
    expect(durable[0]!.topic_id).toBe('app:owner')

    ws.close()
    await sleep(50)
  }, 60_000)
})
