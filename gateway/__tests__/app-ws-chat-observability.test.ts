/**
 * ISSUES #557 — the conversation lifecycle is greppable under ONE prefix.
 *
 * These drive the REAL surface (a real `Bun.serve`, the real `AppWsAdapter`
 * over a real `AppChatStore`) across BOTH inbound paths — `/ws/app/chat` and
 * `POST /api/app/chat/send` — and assert on the LINES the logger actually
 * emitted to its console sink. Asserting that a logger was *called* would not
 * catch the failure mode being fixed here (output that never reaches the
 * journal), so nothing here spies on a function.
 *
 * The gap this closes: a message that arrives and is collapsed by the
 * `client_msg_id` idempotency check wrote nothing and logged nothing, so it was
 * indistinguishable from a message that never arrived. And a send refused for
 * any reason answered only the client — silently, from the server's side.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppWsAdapter,
  InMemoryAppWsSessionRegistry,
  createAppWsAuthResolver,
  type AppWsOutbound,
} from '@neutronai/channels/index.ts'
import type { IncomingEvent } from '@neutronai/channels/types.ts'
import { composeHttpHandler } from '../http/compose.ts'
import {
  createAppWsSurface,
  type ChatCommandFilter,
  type ChatCommandFilterResult,
} from '../http/app-ws-surface.ts'
import { AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'

const TOPIC = 'app:owner'
/** A nonsense marker so "the body never reaches the journal" is a real search. */
const BODY = 'qqzx-marker-body'

let tmp: string
let db: ProjectDb
let lines: string[]
let originalLog: typeof console.log
let originalWarn: typeof console.warn

function appWsLines(): string[] {
  return lines.filter((l) => l.startsWith('[app-ws] '))
}

function linesFor(event: string): string[] {
  return appWsLines().filter((l) => l.startsWith(`[app-ws] event=${event} `))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface Harness {
  base: string
  receivedEvents: IncomingEvent[]
  close(): Promise<void>
}

/** Matches every body, so the chat-command short-circuit can be exercised. */
function alwaysMatchFilter(): ChatCommandFilter {
  return {
    async match(): Promise<ChatCommandFilterResult | null> {
      return { text: 'done' }
    },
  }
}

async function startGateway(opts: { filter?: ChatCommandFilter } = {}): Promise<Harness> {
  const receivedEvents: IncomingEvent[] = []
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async (e) => { receivedEvents.push(e) } },
    chat_log: new AppChatStore({ db }),
  })
  const surface = createAppWsSurface({
    adapter,
    registry,
    auth: createAppWsAuthResolver({ project_slug: 'demo', bypass: true }),
    project_slug: 'demo',
    ...(opts.filter !== undefined ? { chat_command_filter: opts.filter } : {}),
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
    close: async () => { await server.stop(true) },
  }
}

/** Open a socket and wait for `session_ready`. */
async function openSocket(base: string): Promise<{ ws: WebSocket; events: AppWsOutbound[] }> {
  const ws = new WebSocket(`${base.replace(/^http:\/\//, 'ws://')}/ws/app/chat?token=owner`)
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-obs-e2e-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  lines = []
  originalLog = console.log
  originalWarn = console.warn
  console.log = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')) }
  console.warn = (...args: unknown[]): void => { lines.push(args.map(String).join(' ')) }
})

afterEach(() => {
  console.log = originalLog
  console.warn = originalWarn
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('app-ws observability — the /ws/app/chat path (ISSUES #557)', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await h.close() })

  it('emits message_received → turn_dispatched → turn_completed for one send', async () => {
    const { ws, events } = await openSocket(h.base)
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: BODY, client_msg_id: 'c-1' }))
    await waitFor(() => linesFor('turn_completed').length === 1)

    expect(linesFor('message_received')).toEqual([
      '[app-ws] event=message_received topic=app:owner transport=ws seq=1 client_msg_id=c-1 was_new=true',
    ])
    expect(linesFor('turn_dispatched')[0]).toMatch(
      /^\[app-ws\] event=turn_dispatched topic=app:owner session=\S+ turn=app-ws:\S+$/,
    )
    // The turn's `session` is the SAME device the socket announced at
    // `session_open`, so an operator can tie a turn back to the connection it
    // arrived on — the whole point of grepping one prefix.
    const fieldOf = (l: string, k: string): string =>
      new RegExp(`\\b${k}=(\\S+)`).exec(l)?.[1] ?? ''
    expect(fieldOf(linesFor('turn_dispatched')[0] as string, 'session')).toBe(
      fieldOf(linesFor('session_open')[0] as string, 'device'),
    )
    expect(linesFor('turn_completed')[0]).toMatch(/ ms=\d+$/)
    // The dispatched turn and the completed turn are the SAME turn.
    expect(fieldOf(linesFor('turn_completed')[0] as string, 'turn')).toBe(
      fieldOf(linesFor('turn_dispatched')[0] as string, 'turn'),
    )
    expect(events.some((e) => e.type === 'user_message')).toBe(true)

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })

  /**
   * THE LINE THAT ANSWERS THE LIVE QUESTION. A repeated `client_msg_id`
   * collapses onto the existing row and writes nothing; before this it also
   * logged nothing, so "arrived and de-duped" and "never arrived" looked
   * identical from the server.
   */
  it('logs a DEDUPED re-send with was_new=false, and names the skipped turn', async () => {
    const { ws } = await openSocket(h.base)
    const frame = JSON.stringify({ v: 1, type: 'user_message', body: BODY, client_msg_id: 'dup-1' })
    ws.send(frame)
    await waitFor(() => linesFor('turn_completed').length === 1)
    ws.send(frame)
    await waitFor(() => linesFor('message_received').length === 2)

    expect(linesFor('message_received')).toEqual([
      '[app-ws] event=message_received topic=app:owner transport=ws seq=1 client_msg_id=dup-1 was_new=true',
      '[app-ws] event=message_received topic=app:owner transport=ws seq=1 client_msg_id=dup-1 was_new=false',
    ])
    expect(linesFor('turn_skipped')).toEqual([
      '[app-ws] event=turn_skipped topic=app:owner transport=ws reason=duplicate_client_msg_id',
    ])
    // The de-dupe is still honoured: exactly one turn ran.
    expect(h.receivedEvents.length).toBe(1)
    expect(linesFor('turn_dispatched').length).toBe(1)

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('logs the reason a malformed frame was refused', async () => {
    const { ws } = await openSocket(h.base)
    ws.send('{not json')
    await waitFor(() => linesFor('message_refused').length === 1)
    ws.send(JSON.stringify({ v: 1, type: 'user_message' }))
    await waitFor(() => linesFor('message_refused').length === 2)

    expect(linesFor('message_refused')).toEqual([
      '[app-ws] event=message_refused topic=app:owner transport=ws reason=malformed_json',
      '[app-ws] event=message_refused topic=app:owner transport=ws reason=malformed_envelope',
    ])

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('never writes the message body into the journal', async () => {
    const { ws } = await openSocket(h.base)
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: BODY, client_msg_id: 'c-1' }))
    await waitFor(() => linesFor('turn_completed').length === 1)

    expect(appWsLines().length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(BODY)

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws observability — the POST /api/app/chat/send path (ISSUES #557)', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway() })
  afterEach(async () => { await h.close() })

  async function send(body: unknown, auth = 'Bearer owner'): Promise<Response> {
    return await fetch(`${h.base}/api/app/chat/send`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('tags the HTTP transport on message_received and completes the turn', async () => {
    const res = await send({ body: BODY, client_msg_id: 'h-1' })
    expect(res.status).toBe(200)
    await waitFor(() => linesFor('turn_completed').length === 1)

    expect(linesFor('message_received')).toEqual([
      '[app-ws] event=message_received topic=app:owner transport=http seq=1 client_msg_id=h-1 was_new=true',
    ])
    expect(linesFor('turn_dispatched')[0]).toMatch(
      /^\[app-ws\] event=turn_dispatched topic=app:owner session=http turn=app-ws:\S+$/,
    )
  })

  it('logs the DEDUPED HTTP re-send with was_new=false', async () => {
    await send({ body: BODY, client_msg_id: 'h-dup' })
    await waitFor(() => linesFor('turn_completed').length === 1)
    const res = await send({ body: BODY, client_msg_id: 'h-dup' })
    expect(res.status).toBe(200)

    expect(linesFor('message_received').at(-1)).toBe(
      '[app-ws] event=message_received topic=app:owner transport=http seq=1 client_msg_id=h-dup was_new=false',
    )
    expect(linesFor('turn_skipped')).toEqual([
      '[app-ws] event=turn_skipped topic=app:owner transport=http reason=duplicate_client_msg_id',
    ])
    expect(h.receivedEvents.length).toBe(1)
  })

  it('logs a reason for every refusal, and never the bearer', async () => {
    expect((await send({ body: BODY }, 'Token owner')).status).toBe(401)
    expect((await send({ body: BODY }, 'Bearer not a token!')).status).toBe(401)
    expect((await send('{not json')).status).toBe(400)
    expect((await send({ body: '' })).status).toBe(400)
    expect((await send({ body: 'x'.repeat(200_000) })).status).toBe(413)

    expect(linesFor('message_refused')).toEqual([
      '[app-ws] event=message_refused topic=- transport=http reason=missing_bearer',
      '[app-ws] event=message_refused topic=- transport=http reason=malformed_token',
      '[app-ws] event=message_refused topic=app:owner transport=http reason=malformed_json',
      '[app-ws] event=message_refused topic=app:owner transport=http reason=missing_body',
      '[app-ws] event=message_refused topic=app:owner transport=http reason=body_too_long',
    ])
    // A refused send must never carry credential material into the journal.
    for (const line of lines) expect(line).not.toContain('not a token!')
    // No message_received / turn_dispatched for a send that never landed.
    expect(linesFor('message_received')).toEqual([])
    expect(linesFor('turn_dispatched')).toEqual([])
  })
})

describe('app-ws observability — a message handled by a chat command (ISSUES #557)', () => {
  let h: Harness
  beforeEach(async () => { h = await startGateway({ filter: alwaysMatchFilter() }) })
  afterEach(async () => { await h.close() })

  it('names the reason no turn was dispatched instead of leaving a gap', async () => {
    const { ws } = await openSocket(h.base)
    ws.send(JSON.stringify({ v: 1, type: 'user_message', body: BODY, client_msg_id: 'c-1' }))
    await waitFor(() => linesFor('turn_skipped').length === 1)

    expect(linesFor('message_received').length).toBe(1)
    expect(linesFor('turn_skipped')).toEqual([
      '[app-ws] event=turn_skipped topic=app:owner transport=ws reason=chat_command',
    ])
    expect(linesFor('turn_dispatched')).toEqual([])
    expect(h.receivedEvents.length).toBe(0)

    ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})
