/**
 * Open PROJECT-scoped SESSION REPLY topic PIN — the answer lands in the topic
 * whose message asked the question.
 *
 * WHY THIS EXISTS (acceptance 2 of the 2026-08-15 card): all 24 misrouted rows
 * that night were REMINDER fires, not session replies. Measured session replies
 * (16:43, 17:21) landed on `app:owner:neutron-open` correctly, so the reply path
 * needs NO fix — and the Defect A fix (`open/wiring/reminder-topic.ts`, wired at
 * `open/composer.ts`) must never regress it on the way past. This file is a
 * REGRESSION PIN of behaviour that already works: it contains no product change
 * and asserts nothing new about the runtime, only that the working routing keeps
 * working.
 *
 * It boots the REAL Open composition over a live `Bun.serve`, opens the unified
 * `/ws/app/chat` socket bound to a PROJECT (`project_id=<id>` on the upgrade
 * query string → `app:<owner>:<project>`, `gateway/http/app-ws-surface.ts`
 * `resolveChannelTopicId`), drives a real turn from that socket, and reads the
 * verdict back off the DURABLE table — `app_chat_messages`, not the ws frames.
 * Frames prove a live push; the card's evidence was a `topic_id` query, so the
 * pin is a `topic_id` query too:
 *   (a) the agent reply row carries `topic_id = app:<owner>:<project>`;
 *   (b) the user message that triggered it is stored under the SAME topic;
 *   (c) NOTHING from this turn landed on the bare `app:<owner>` General topic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import { openMigratedDbAt } from '../../tests/support/migrated-db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const AGENT_REPLY_BODY = 'PROJECT_SESSION_REPLY_TOPIC_OK'
/** The project the owner was reading — and writing in — all night. */
const PROJECT_ID = 'neutron-open'
const PROJECT_TOPIC = `app:owner:${PROJECT_ID}`
const GENERAL_TOPIC = 'app:owner'

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
  // A LIVE instance's identity config leaks in through `process.env` on a
  // provisioned box and puts the app-ws auth resolver in `jwks` mode, which
  // rejects the `dev:owner` bearer this harness connects with.
  'NEUTRON_IDENTITY_JWKS_URL', 'NEUTRON_IDENTITY_AUDIENCE',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness { base: string; db: ProjectDb; close(): Promise<void> }
let harness: Harness | null = null

/** Mock substrate: a distinctive reply body so the durable row is identifiable. */
function recordingSubstrate(): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      const out = spec.prompt.includes('reminder agent') ? 'ok' : AGENT_REPLY_BODY
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-proj-reply-topic-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-proj-reply-topic'
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
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(25)
  }
}

async function startHarness(): Promise<Harness> {
  const db = openMigratedDbAt(process.env['NEUTRON_DB_PATH']!)
  // Seed the project row the way onboarding would — the owner is talking INTO a
  // real project, which is the situation the card describes.
  db.raw().run(
    `INSERT INTO projects (id, name, privacy_mode, billing_mode, created_at, updated_at)
     VALUES (?, ?, 'private', 'personal', ?, ?)`,
    [PROJECT_ID, 'Neutron Open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'],
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

describe('Open project-scoped session reply topic (durable read-back)', () => {
  test('a reply to a PROJECT message is stored under app:<owner>:<project>, never General', async () => {
    harness = await startHarness()
    const wsUrl = harness.base.replace(/^http/, 'ws')
    const ws = new WebSocket(
      `${wsUrl}/ws/app/chat?token=dev:owner&platform=web&device_id=devA&project_id=${PROJECT_ID}`,
    )
    const frames: Array<Record<string, unknown>> = []
    ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))) } catch { /* */ } }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
    })
    await waitFor(() => frames.some((f) => f['type'] === 'session_ready'))

    // The owner asks a question in the project topic — exactly the turn shape
    // that produced the 16:43 / 17:21 replies.
    ws.send(JSON.stringify({
      v: 1, type: 'user_message',
      body: 'Hello? Can you answer me?',
      client_msg_id: 'c-project-reply-1',
    }))

    // Turn complete: the durable agent row exists. Read-back is the signal, not
    // the frame — the card's evidence was a `topic_id` query.
    const agentRows = (): Array<{ topic_id: string; body: string }> =>
      harness!.db.raw()
        .query('SELECT topic_id, body FROM app_chat_messages WHERE role = ? AND body LIKE ?')
        .all('agent', `%${AGENT_REPLY_BODY}%`) as Array<{ topic_id: string; body: string }>
    await waitFor(() => agentRows().length > 0)
    // Let any straggler write (a second fan-out, an opener) land before the
    // negative assertion below, so "nothing on General" is not a race won early.
    await sleep(800)

    // (a) The agent reply is stored under the PROJECT topic the socket is bound
    //     to and hydrates from — with a real body, not an empty placeholder.
    const replies = agentRows()
    expect(replies.length).toBeGreaterThan(0)
    for (const r of replies) expect(r.topic_id).toBe(PROJECT_TOPIC)
    expect(replies[0]!.body.trim().length).toBeGreaterThan(0)

    // (b) The user message that triggered the turn is stored under the SAME
    //     topic — question and answer share a thread.
    const userRows = harness.db.raw()
      .query('SELECT topic_id FROM app_chat_messages WHERE client_msg_id = ? AND role = ?')
      .all('c-project-reply-1', 'user') as Array<{ topic_id: string }>
    expect(userRows.length).toBe(1)
    expect(userRows[0]!.topic_id).toBe(PROJECT_TOPIC)

    // (c) THE REGRESSION THIS FILE EXISTS TO CATCH: nothing from this turn was
    //     posted into General, where the owner was not reading.
    const general = harness.db.raw()
      .query('SELECT count(*) c FROM app_chat_messages WHERE topic_id = ?')
      .get(GENERAL_TOPIC) as { c: number }
    expect(general.c).toBe(0)

    ws.close()
    await sleep(50)
  }, 60_000)
})
