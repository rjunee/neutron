/**
 * Chat-sync foundation — DOUBLE-DISPATCH regression guard (PR #6).
 *
 * Argus + Codex P1 BLOCKING: `AppChatStore` de-dupes a re-sent `client_msg_id`
 * at the storage layer (returns the existing row, `was_new:false`), but the
 * surface used to DISCARD that verdict and unconditionally run the
 * side-effecting chat-command filter + `dispatchInbound`. A re-send (offline-
 * queue flush, double-tap, HTTP fallback racing the WS echo) therefore fired
 * the agent / a command TWICE — storage was idempotent, behaviour wasn't.
 *
 * These tests wire the REAL surface against a REAL `AppChatStore` (SQLite over
 * a temp file, the production store) and assert EXACTLY-ONCE dispatch on a
 * re-send across both transports, while still re-emitting the echo (idempotent
 * on the client). The final test wires the real server append/replay into the
 * real client `SyncEngine` and asserts a single message yields exactly one row
 * per device even with optimistic-insert + server-echo + a reconnect replay
 * overlapping — the spec's exactly-once-per-device convergence guarantee.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  appWsTopicId,
  createAppWsAuthResolver,
  type AppWsOutbound,
} from '@neutronai/channels/index.ts'
import type { IncomingEvent, OutgoingMessage, Topic } from '@neutronai/channels/types.ts'
import { composeHttpHandler } from '../http/compose.ts'
import {
  createAppWsSurface,
  type ChatCommandFilter,
  type ChatCommandFilterResult,
} from '../http/app-ws-surface.ts'
import { ButtonStore } from '@neutronai/channels/button-store.ts'
import { buildButtonPrompt } from '@neutronai/channels/button-primitive.ts'
import { buildButtonPromptClaim } from '../wiring/build-button-prompt-claim.ts'
import { AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { InMemoryStore, SendQueue, SyncEngine, normalizeInbound } from '@neutronai/chat-core/index.ts'

const TOPIC = 'app:sam'

let tmp: string
let db: ProjectDb

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'no-dd-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

interface Harness {
  base: string
  receivedEvents: IncomingEvent[]
  commandMatches: string[]
  registry: InMemoryAppWsSessionRegistry
  adapter: AppWsAdapter
  close(): Promise<void>
}

/** A chat-command filter that records every match call. Returns null (no
 *  match) so the normal LLM dispatch path runs — we count match() calls to
 *  prove the side-effecting filter is gated on `was_new`. */
function countingFilter(sink: string[]): ChatCommandFilter {
  return {
    async match(input): Promise<ChatCommandFilterResult | null> {
      sink.push(input.body)
      return null
    },
  }
}

async function startGateway(): Promise<Harness> {
  const receivedEvents: IncomingEvent[] = []
  const commandMatches: string[] = []
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async (e) => { receivedEvents.push(e) } },
    chat_log: new AppChatStore({ db }),
  })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: 'demo',
    chat_command_filter: countingFilter(commandMatches),
  })
  const composed = composeHttpHandler({
    appWs: { handler: surface.handler, websocket: surface.websocket },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    receivedEvents,
    commandMatches,
    registry,
    adapter,
    close: async () => { await server.stop(true) },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function wsUrl(base: string): string {
  return base.replace(/^http:\/\//, 'ws://')
}

describe('app-ws — no double dispatch on re-sent client_msg_id (WS)', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await h.close() })

  it('re-sending the same client_msg_id dispatches the agent + command EXACTLY ONCE, but re-emits the echo', async () => {
    const ws = new WebSocket(`${wsUrl(h.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))

    const frame = JSON.stringify({ v: 1, type: 'user_message', body: 'hello', client_msg_id: 'dup-1' })
    ws.send(frame)
    await waitFor(() => events.filter((e) => e.type === 'user_message').length === 1)
    // Re-send the IDENTICAL client_msg_id (e.g. an offline-queue flush retry).
    ws.send(frame)
    await waitFor(() => events.filter((e) => e.type === 'user_message').length === 2)
    // Give any erroneous second dispatch a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 50))

    // Echo re-emitted both times (idempotent on the client).
    const echoes = events.filter((e) => e.type === 'user_message')
    expect(echoes.length).toBe(2)
    // Both echoes carry the SAME canonical seq + message_id (the de-duped row).
    const seqs = echoes.map((e) => (e as { seq?: number }).seq)
    expect(seqs).toEqual([1, 1])
    // Agent dispatched EXACTLY ONCE.
    expect(h.receivedEvents.length).toBe(1)
    expect(h.receivedEvents[0]?.body.text).toBe('hello')
    // Side-effecting command filter ran EXACTLY ONCE.
    expect(h.commandMatches).toEqual(['hello'])

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

/**
 * ISSUES #415 — the `button_choice` half of the same guarantee.
 *
 * The typed path has been gated on `was_new` since PR #6; a TAP was gated by
 * nothing. `prompt_id` was decoded and thrown away, no server-side mark said
 * "answered", and reply rows carry a TEN-YEAR TTL — so any remount resurrected
 * a live Retry button whose tap ran the agent a second time, invisibly. These
 * wire the REAL surface against the REAL `ButtonStore` and the REAL claim
 * (`buildButtonPromptClaim` — the same function the Open wiring installs, not a
 * lookalike) and assert exactly-once dispatch on a re-tap.
 */
interface ButtonHarness extends Harness {
  choices: Array<{ prompt_id: string; choice_value: string }>
  buttonStore: ButtonStore
}

async function startGatewayWithButtons(): Promise<ButtonHarness> {
  const receivedEvents: IncomingEvent[] = []
  const commandMatches: string[] = []
  const choices: Array<{ prompt_id: string; choice_value: string }> = []
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async (e) => { receivedEvents.push(e) } },
    chat_log: new AppChatStore({ db }),
  })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const buttonStore = new ButtonStore({ db })
  const surface = createAppWsSurface({
    adapter,
    registry,
    auth,
    project_slug: 'demo',
    claim_button_prompt: buildButtonPromptClaim({ buttonStore }),
    on_button_choice: async ({ prompt_id, choice_value }): Promise<void> => {
      choices.push({ prompt_id, choice_value })
    },
  })
  const composed = composeHttpHandler({
    appWs: { handler: surface.handler, websocket: surface.websocket },
    defaultHandler: () => new Response('not found', { status: 404 }),
  })
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => composed.fetch(req, srv),
    websocket: composed.websocket,
  })
  return {
    base: `http://127.0.0.1:${server.port}`,
    receivedEvents,
    commandMatches,
    registry,
    adapter,
    choices,
    buttonStore,
    close: async () => { await server.stop(true) },
  }
}

describe('app-ws — no double dispatch on a re-tapped button_choice (ISSUES #415)', () => {
  let h: ButtonHarness
  beforeEach(async () => { h = await startGatewayWithButtons() })
  afterEach(async () => { await h.close() })

  /** Emit a real freeze-timeout-shaped Retry prompt and return its id. */
  async function emitRetryPrompt(): Promise<string> {
    const prompt = buildButtonPrompt({
      body: 'That one took too long, so I stopped before finishing.',
      options: [{ label: '1', body: 'Retry', value: '__retry_turn__' }],
      allow_freeform: true,
      // The real reply-row TTL: ten years. A Retry button never expires, which
      // is precisely why the server-side claim has to be the guard.
      expires_in_ms: 10 * 365 * 24 * 60 * 60 * 1_000,
    })
    const { prompt_id } = await h.buttonStore.emit(prompt, { topic_id: TOPIC })
    return prompt_id
  }

  async function openSocket(): Promise<{ ws: WebSocket; events: AppWsOutbound[] }> {
    const ws = new WebSocket(`${wsUrl(h.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    return { ws, events }
  }

  it('re-tapping the SAME prompt dispatches EXACTLY ONCE', async () => {
    const prompt_id = await emitRetryPrompt()
    const { ws } = await openSocket()
    const frame = JSON.stringify({
      v: 1,
      type: 'button_choice',
      prompt_id,
      choice_value: '__retry_turn__',
    })
    ws.send(frame)
    await waitFor(() => h.choices.length === 1)
    // The double-tap / remount-resurrected re-tap.
    ws.send(frame)
    // Give an erroneous second dispatch time to land before asserting.
    await new Promise((r) => setTimeout(r, 120))

    expect(h.choices).toHaveLength(1)
    expect(h.choices[0]).toEqual({ prompt_id, choice_value: '__retry_turn__' })

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('the tap leaves a durable TRACE on the prompt row — the human label, never the routing sentinel', async () => {
    const prompt_id = await emitRetryPrompt()
    const { ws } = await openSocket()
    ws.send(JSON.stringify({
      v: 1,
      type: 'button_choice',
      prompt_id,
      choice_value: '__retry_turn__',
    }))
    await waitFor(() => h.choices.length === 1)
    await new Promise((r) => setTimeout(r, 60))

    const row = db
      .raw()
      .prepare(
        `SELECT resolved_at, resolution_value, resolution_freeform_text
           FROM button_prompts WHERE prompt_id = ?`,
      )
      .get(prompt_id) as {
        resolved_at: number | null
        resolution_value: string | null
        resolution_freeform_text: string | null
      }
    // Answered server-side, so a remount cannot resurrect a LIVE Retry.
    expect(row.resolved_at).not.toBeNull()
    // And the trace renders as the owner's words. `__retry_turn__` is a routing
    // token: without the freeform the history surface would paint a user bubble
    // saying "__retry_turn__" and splice it into the next prompt.
    expect(row.resolution_freeform_text).toBe('Retry')
  })

  it('a tap on a prompt this store never persisted still dispatches (nothing to gate on)', async () => {
    const { ws } = await openSocket()
    ws.send(JSON.stringify({
      v: 1,
      type: 'button_choice',
      prompt_id: '11111111-2222-4333-8444-555555555555',
      choice_value: 'keep-going',
    }))
    await waitFor(() => h.choices.length === 1)
    expect(h.choices[0]?.choice_value).toBe('keep-going')

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws — no double dispatch on re-sent client_msg_id (HTTP)', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await h.close() })

  it('a duplicate HTTP send dispatches once but always returns the canonical echo', async () => {
    const body = JSON.stringify({ body: 'over http', client_msg_id: 'dup-http' })
    const post = () => fetch(`${h.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body,
    })
    const r1 = await post()
    const r2 = await post()
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const j1 = (await r1.json()) as { echo: { seq?: number; message_id: string } }
    const j2 = (await r2.json()) as { echo: { seq?: number; message_id: string } }
    // Same canonical row on both responses.
    expect(j1.echo.seq).toBe(1)
    expect(j2.echo.seq).toBe(1)
    expect(j2.echo.message_id).toBe(j1.echo.message_id)
    // Dispatched + matched exactly once across the two sends.
    expect(h.receivedEvents.length).toBe(1)
    expect(h.commandMatches).toEqual(['over http'])
  })

  it('the HTTP fallback racing the WS echo of the same send does NOT double-dispatch', async () => {
    // First the WS path persists + dispatches.
    const ws = new WebSocket(`${wsUrl(h.base)}/ws/app/chat?token=sam`)
    const events: AppWsOutbound[] = []
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(new Error(`ws error: ${JSON.stringify(e)}`))
    })
    ws.onmessage = (ev) => {
      events.push(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)))
    }
    await opened
    await waitFor(() => events.some((e) => e.type === 'session_ready'))
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'raced', client_msg_id: 'race-1' }))
    await waitFor(() => events.some((e) => e.type === 'user_message'))

    // Now the client's HTTP fallback fires the SAME send (it didn't see the
    // WS echo in time). Must de-dupe — no second dispatch.
    const res = await fetch(`${h.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev:sam' },
      body: JSON.stringify({ body: 'raced', client_msg_id: 'race-1' }),
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.receivedEvents.length).toBe(1)
    expect(h.commandMatches).toEqual(['raced'])

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws — exactly-one-row-per-device convergence (real client SyncEngine)', () => {
  const topic: Topic = {
    topic_id: 'topic-abc',
    channel_kind: 'app_socket',
    channel_topic_id: TOPIC,
    project_id: null,
    privacy_mode: 'regular',
  }

  function device() {
    const store = new InMemoryStore()
    const queue = new SendQueue(store, { now: () => 1 })
    const engine = new SyncEngine(store)
    const inbox: AppWsOutbound[] = []
    return {
      queue,
      sink: (e: AppWsOutbound) => inbox.push(e),
      inbox,
      async drain() {
        for (const env of inbox.splice(0)) {
          const msg = normalizeInbound(env)
          if (msg !== null) await engine.applyInbound(TOPIC, msg)
        }
      },
      rows: () => engine.messages(TOPIC),
    }
  }

  it('single message → one row per device with optimistic insert + echo + reconnect replay overlap', async () => {
    const registry = new InMemoryAppWsSessionRegistry()
    let n = 0
    const adapter = new AppWsAdapter({
      registry,
      receiver: { receive: async () => {} },
      now: () => 1000,
      generate_message_id: () => `srv-${++n}`,
      chat_log: new AppChatStore({ db }),
    })
    const A = device()
    const B = device()
    registry.register(TOPIC, A.sink)
    registry.register(TOPIC, B.sink)

    // Device A optimistically renders before the server round-trip.
    await A.queue.enqueue({ topic_id: TOPIC, body: 'hey', client_msg_id: 'cA' })
    expect((await A.rows()).length).toBe(1)

    // Server ingests (fan echo to both). Re-ingest the SAME client_msg_id to
    // simulate an offline-queue flush retry — must NOT create a second row.
    await adapter.ingestUserMessage({ channel_topic_id: TOPIC, user_id: 'sam', body: 'hey', client_msg_id: 'cA' })
    await adapter.ingestUserMessage({ channel_topic_id: TOPIC, user_id: 'sam', body: 'hey', client_msg_id: 'cA' })
    // Agent reply fans to both.
    const out: OutgoingMessage = { topic, text: 'reply' }
    await adapter.send(out)

    await A.drain()
    await B.drain()

    // Device B reconnects and replays from cursor 0 — overlaps everything it
    // already applied live.
    for (const env of await adapter.replayAfter(TOPIC, 0)) B.inbox.push(env)
    await B.drain()

    const aRows = await A.rows()
    const bRows = await B.rows()
    // One user row + one agent row on EACH device — no duplicates despite the
    // optimistic insert, the duplicate ingest, the live echo, and the overlap.
    expect(aRows.map((r) => r.body)).toEqual(['hey', 'reply'])
    expect(bRows.map((r) => r.body)).toEqual(['hey', 'reply'])
    expect(aRows.map((r) => r.seq)).toEqual([1, 2])
    expect(bRows.map((r) => r.seq)).toEqual([1, 2])
    // Server assigned the seq only once (idempotent re-ingest).
    expect(await adapter.currentMaxSeq(TOPIC)).toBe(2)
  })
})
