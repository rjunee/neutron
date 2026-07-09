/**
 * Open app-ws DURABLE CHAT-LOG + real typing — the anti-"built-but-not-wired"
 * gate for the Telegram-class chat transport (Ryan-directed, 2026-06-29).
 *
 * THE ROOT CAUSE this guards: Open's composer constructed the app-ws adapter
 * with NO durable logs (`new AppWsAdapter({ registry, receiver })`), so the
 * fully-built seq/resume/idempotency/receipt machinery was inert in M1 —
 * `hasChatLog === false` everywhere. The fix wires the four per-topic logs
 * (`AppChatStore`/`AppChatReceiptStore`/`AppChatReactionStore`/`AppChatEditStore`,
 * all on the single-owner project.db) onto the adapter, and adds a
 * server-authoritative `agent_typing` frame around every live-agent turn.
 *
 * This boots the REAL Open composition over a live `Bun.serve`, opens the
 * unified `/ws/app/chat` socket, and asserts — on REAL turns (mocked substrate,
 * synthetic credential so the live-agent path composes) — that:
 *   #1 every user echo + agent reply is persisted to `app_chat_messages` and
 *      carries a monotonic per-topic `seq` on the wire;
 *   #2 a re-sent `client_msg_id` is de-duped — the agent turn does NOT re-run
 *      (the double-dispatch guard trips), no second durable row, no 2nd reply;
 *   #3 a reconnecting / second socket resumes from `after_seq` and gets a
 *      gap-free replay of the persisted transcript; `session_ready` carries
 *      `last_seen_seq`;
 *   #4 the server records + fans a `receipt_update` (the agent-read receipt) for
 *      a freshly-received user message;
 *   #5 the HTTP `/api/app/chat/send` fallback returns the echo (with seq)
 *      IMMEDIATELY — it does NOT block on the (delayed) agent turn;
 *   #6 a real `agent_typing` start→end bracket fans to the socket around the
 *      turn.
 *
 * The substrate is MOCKED (no real `claude`); a synthetic credential makes the
 * live-agent path compose. Non-reminder turns sleep `STEADY_TURN_DELAY_MS` so
 * the fire-and-forget HTTP proof (#5) is deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { composeProductionGraph } from '@neutronai/gateway/composition.ts'
import { buildOpenGraphComposer } from '../composer.ts'
import type { AgentSpec, Substrate } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')
const AGENT_REPLY_BODY = 'CHATLOG_TURN_REPLY_OK'
/** Delay the mocked steady-state turn so fire-and-forget (#5) is observable. */
const STEADY_TURN_DELAY_MS = 500

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME', 'OWNER_HOME', 'NEUTRON_DB_PATH', 'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR', 'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string

interface Harness { base: string; db: ProjectDb; close(): Promise<void> }
let harness: Harness | null = null

/** Mock substrate: a distinctive reply body; non-reminder turns sleep so the
 *  HTTP fire-and-forget proof can observe the response returning first. */
function recordingSubstrate(): Substrate {
  return {
    start(spec: AgentSpec): SessionHandle {
      const isReminder = spec.prompt.includes('reminder agent')
      const out = isReminder ? 'ok' : AGENT_REPLY_BODY
      async function* gen(): AsyncGenerator<Event> {
        if (!isReminder) await sleep(STEADY_TURN_DELAY_MS)
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
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-chatlog-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-synthetic-chatlog'
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

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
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

interface OpenSocket {
  ws: WebSocket
  frames: Array<Record<string, unknown>>
  close(): void
}

async function openSocket(base: string, query = 'token=dev:owner&platform=web&device_id=devA'): Promise<OpenSocket> {
  const wsUrl = base.replace(/^http/, 'ws')
  const ws = new WebSocket(`${wsUrl}/ws/app/chat?${query}`)
  const frames: Array<Record<string, unknown>> = []
  ws.onmessage = (e) => { try { frames.push(JSON.parse(String(e.data))) } catch { /* */ } }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = (ev) => reject(new Error(`ws error: ${JSON.stringify(ev)}`))
  })
  return { ws, frames, close: () => ws.close() }
}

const framesOfType = (frames: Array<Record<string, unknown>>, type: string): Array<Record<string, unknown>> =>
  frames.filter((f) => f['type'] === type)

describe('Open app-ws durable chat-log + typing (real instance)', () => {
  test('#1/#4/#6 a real turn persists with seq, fans receipts + typing', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)

    // session_ready first.
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)

    // Send a real user message; wait for the agent reply to settle.
    sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hello one', client_msg_id: 'c-1' }))
    await waitFor(() =>
      framesOfType(sock.frames, 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    )

    // #1 — the user echo carries a monotonic seq + matching client_msg_id.
    const echo = framesOfType(sock.frames, 'user_message').find((f) => f['client_msg_id'] === 'c-1')
    expect(echo).toBeDefined()
    expect(typeof echo!['seq']).toBe('number')
    expect((echo!['seq'] as number) > 0).toBe(true)

    // #1 — persisted to the durable log under the owner's app topic.
    const userRow = harness.db.raw()
      .query("SELECT seq, role, body FROM app_chat_messages WHERE topic_id = 'app:owner' AND client_msg_id = 'c-1'")
      .all() as Array<{ seq: number; role: string; body: string }>
    expect(userRow.length).toBe(1)
    expect(userRow[0]!.role).toBe('user')

    // #1 — the agent reply is also persisted (agent role) with its own seq.
    const agentRows = harness.db.raw()
      .query("SELECT seq FROM app_chat_messages WHERE topic_id = 'app:owner' AND role = 'agent'")
      .all() as Array<{ seq: number }>
    expect(agentRows.length).toBeGreaterThan(0)

    // #6 — a server-authoritative typing bracket fanned around the turn.
    const typing = framesOfType(sock.frames, 'agent_typing')
    expect(typing.some((f) => f['state'] === 'start')).toBe(true)
    await waitFor(() => framesOfType(sock.frames, 'agent_typing').some((f) => f['state'] === 'end'))

    // #4 — the agent-read receipt fanned for the user's message.
    const receipts = framesOfType(sock.frames, 'receipt_update')
    expect(receipts.some((f) => Array.isArray(f['read_by']) && (f['read_by'] as string[]).includes('agent'))).toBe(true)

    sock.close()
    await sleep(50)
  }, 30_000)

  test('#2 a re-sent client_msg_id does NOT re-run the agent turn', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)

    const agentRowCount = (): number =>
      (harness!.db.raw()
        .query("SELECT count(*) c FROM app_chat_messages WHERE topic_id = 'app:owner' AND role = 'agent'")
        .get() as { c: number }).c

    // A fresh owner's on_session_open seeds an onboarding opener turn that lands
    // its OWN agent row asynchronously. Let it settle so it can't be mistaken
    // for a re-dispatch below (quiesce: agent row count stable for a beat).
    await sleep(STEADY_TURN_DELAY_MS + 600)
    let stable = agentRowCount()
    await waitFor(() => {
      const now = agentRowCount()
      if (now === stable) return true
      stable = now
      return false
    }, 6_000)

    // First real send of the client_msg_id → exactly one new agent reply.
    sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'dedup me', client_msg_id: 'dup-1' }))
    await waitFor(() => agentRowCount() === stable + 1)
    const baseline = agentRowCount()

    // Re-send the SAME client_msg_id (offline-queue flush / double-tap / WS↔HTTP
    // race). Give the (would-be) second turn ample time to fire if broken.
    sock.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'dedup me', client_msg_id: 'dup-1' }))
    await sleep(STEADY_TURN_DELAY_MS + 800)

    // Exactly ONE durable user row for the client_msg_id (idempotent append) …
    const userRows = harness.db.raw()
      .query("SELECT count(*) c FROM app_chat_messages WHERE topic_id = 'app:owner' AND client_msg_id = 'dup-1'")
      .get() as { c: number }
    expect(userRows.c).toBe(1)
    // … and the agent turn did NOT re-run (the double-dispatch guard tripped).
    expect(agentRowCount()).toBe(baseline)

    sock.close()
    await sleep(50)
  }, 30_000)

  test('#3 a reconnecting socket resumes a gap-free transcript', async () => {
    harness = await startHarness()
    const sock1 = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock1.frames, 'session_ready').length > 0)
    sock1.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'persist me', client_msg_id: 'r-1' }))
    await waitFor(() =>
      framesOfType(sock1.frames, 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    )
    sock1.close()
    await sleep(50)

    // A fresh socket (reconnect / 2nd device) — session_ready carries the
    // current high-water seq, then a resume from 0 replays the whole transcript.
    const sock2 = await openSocket(harness.base, 'token=dev:owner&platform=web&device_id=devB')
    await waitFor(() => framesOfType(sock2.frames, 'session_ready').length > 0)
    const ready = framesOfType(sock2.frames, 'session_ready')[0]!
    expect(typeof ready['last_seen_seq']).toBe('number')
    expect((ready['last_seen_seq'] as number) > 0).toBe(true)

    const beforeResume = sock2.frames.length
    sock2.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))
    // The replay re-emits the persisted user echo + agent reply to THIS socket.
    await waitFor(() =>
      sock2.frames.slice(beforeResume).some(
        (f) => f['type'] === 'user_message' && f['client_msg_id'] === 'r-1',
      ),
    )
    const replayed = sock2.frames.slice(beforeResume)
    expect(replayed.some((f) => f['type'] === 'user_message' && f['client_msg_id'] === 'r-1')).toBe(true)
    expect(
      replayed.some(
        (f) => f['type'] === 'agent_message' && typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    ).toBe(true)

    sock2.close()
    await sleep(50)
  }, 30_000)

  test('#5 HTTP /api/app/chat/send returns the echo immediately (fire-and-forget)', async () => {
    harness = await startHarness()
    // A live socket to observe the agent reply arriving AFTER the HTTP response.
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)

    const t0 = Date.now()
    const res = await fetch(`${harness.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev:owner', 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'http hello', client_msg_id: 'h-1' }),
    })
    const elapsed = Date.now() - t0
    const json = (await res.json()) as { ok: boolean; echo?: { seq?: number; client_msg_id?: string } }

    // The response returned the durable echo (with seq) WITHOUT blocking on the
    // ~500ms agent turn — the whole point of the fire-and-forget change.
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(typeof json.echo?.seq).toBe('number')
    expect(json.echo?.client_msg_id).toBe('h-1')
    expect(elapsed).toBeLessThan(STEADY_TURN_DELAY_MS) // returned before the turn finished

    // The turn still ran — its reply fans over the WS afterwards.
    await waitFor(() =>
      framesOfType(sock.frames, 'agent_message').some(
        (f) => typeof f['body'] === 'string' && (f['body'] as string).includes(AGENT_REPLY_BODY),
      ),
    )

    sock.close()
    await sleep(50)
  }, 30_000)

  test('#7 the FIRST session_ready on a fresh topic carries last_seen_seq:0 (M1 reset signal)', async () => {
    harness = await startHarness()
    const sock = await openSocket(harness.base)
    await waitFor(() => framesOfType(sock.frames, 'session_ready').length > 0)
    // The first connect's session_ready is emitted BEFORE the async onboarding
    // opener persists, so the durable log is still empty. With a durable log
    // wired the surface now ALWAYS reports last_seen_seq — INCLUDING 0 — so a
    // stale client whose local cursor is ahead recognises the seq regression and
    // wipes its old transcript. (Previously the field was omitted on 0, which a
    // client couldn't distinguish from a no-durable-log deployment.)
    const ready = framesOfType(sock.frames, 'session_ready')[0]!
    expect(ready['last_seen_seq']).toBe(0)
    sock.close()
    await sleep(50)
  }, 30_000)
})
