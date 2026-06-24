/**
 * Track B Phase 4 (message edit/delete) end-to-end over the real gateway app-ws
 * WebSocket surface (Bun.serve), backed by a real SQLite message + edit log.
 * Exercises: an `edit` frame fanning an `edit_update` to every device, a delete
 * tombstone, the resume edit replay, author-only authorization (a human device
 * editing an AGENT message gets `not_authorized`), and agent-native parity (the
 * agent edits its own message). The editor is attributed from the SOCKET.
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
} from '../../channels/index.ts'
import {
  AppChatEditStore,
  APP_CHAT_AGENT_DEVICE_ID,
  AppChatStore,
  ProjectDb,
} from '../../persistence/index.ts'
import type { Topic } from '../../channels/types.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'

interface Harness {
  base: string
  adapter: AppWsAdapter
  close(): Promise<void>
}

const CHANNEL_TOPIC = 'app:sam'
const agentTopic: Topic = {
  topic_id: 'topic-abc',
  channel_kind: 'app_socket',
  channel_topic_id: CHANNEL_TOPIC,
  project_id: null,
  privacy_mode: 'regular',
}

let tmp: string
let db: ProjectDb

async function startGateway(): Promise<Harness> {
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
    chat_log: new AppChatStore({ db }),
    edit_log: new AppChatEditStore({ db }),
  })
  const auth = createAppWsAuthResolver({ project_slug: 'demo', bypass: true })
  const surface = createAppWsSurface({ adapter, registry, auth, project_slug: 'demo' })
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
    adapter,
    close: async () => {
      await server.stop(true)
    },
  }
}

function wsUrl(base: string): string {
  return base.replace(/^http/, 'ws')
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function openDevice(
  base: string,
  deviceId: string,
): Promise<{ ws: WebSocket; events: AppWsOutbound[] }> {
  const ws = new WebSocket(`${wsUrl(base)}/ws/app/chat?token=sam&device_id=${deviceId}`)
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

function editFor(events: AppWsOutbound[], messageId: string) {
  return events
    .filter((e): e is Extract<AppWsOutbound, { type: 'edit_update' }> => e.type === 'edit_update')
    .filter((e) => e.message_id === messageId)
}

function errorsOf(events: AppWsOutbound[]) {
  return events.filter((e): e is Extract<AppWsOutbound, { type: 'error' }> => e.type === 'error')
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gw-edits-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('app-ws edit/delete — fan-out', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('an edit fans an edit_update to every device, attributed to the socket', async () => {
    const a = await openDevice(h.base, 'devA')
    const b = await openDevice(h.base, 'devB')

    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'helo', client_msg_id: 'c1' }))
    await waitFor(() => b.events.some((e) => e.type === 'user_message'))
    const echo = a.events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') throw new Error('expected echo')
    const msgId = echo.message_id

    a.ws.send(JSON.stringify({ v: 1, type: 'edit', message_id: msgId, action: 'edit', body: 'hello' }))
    await waitFor(() => editFor(b.events, msgId).some((e) => e.body === 'hello'))
    expect(editFor(a.events, msgId).at(-1)?.body).toBe('hello')
    expect(editFor(b.events, msgId).at(-1)?.body).toBe('hello')

    a.ws.close()
    b.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('a delete fans a tombstone across devices', async () => {
    const a = await openDevice(h.base, 'devA')
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'oops', client_msg_id: 'c1' }))
    await waitFor(() => a.events.some((e) => e.type === 'user_message'))
    const msgId = (a.events.find((e) => e.type === 'user_message') as { message_id: string }).message_id

    a.ws.send(JSON.stringify({ v: 1, type: 'edit', message_id: msgId, action: 'delete' }))
    await waitFor(() => editFor(a.events, msgId).some((e) => e.deleted))
    const tomb = editFor(a.events, msgId).at(-1)
    expect(tomb?.deleted).toBe(true)
    expect(tomb?.body).toBe('')

    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws edit/delete — author-only authorization', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('a human device editing an AGENT message gets not_authorized (no edit fanned)', async () => {
    const a = await openDevice(h.base, 'devA')
    // Seed an agent message directly through the adapter (the agent loop's path).
    const res = await h.adapter.send({ topic: agentTopic, text: 'agent says hi' } as Parameters<AppWsAdapter['send']>[0])
    const agentMsgId = res.split(':').pop() ?? ''

    a.ws.send(JSON.stringify({ v: 1, type: 'edit', message_id: agentMsgId, action: 'edit', body: 'hax' }))
    await waitFor(() => errorsOf(a.events).some((e) => e.code === 'not_authorized'))
    // and NO edit_update was fanned for that message
    expect(editFor(a.events, agentMsgId)).toHaveLength(0)

    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('the agent can edit its OWN message (agent-native parity)', async () => {
    const a = await openDevice(h.base, 'devA')
    const res = await h.adapter.send({ topic: agentTopic, text: 'typo here' } as Parameters<AppWsAdapter['send']>[0])
    const agentMsgId = res.split(':').pop() ?? ''

    // The agent edits via the adapter, attributed to the agent device id.
    const update = await h.adapter.recordEdit({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: agentMsgId,
      editor_device_id: APP_CHAT_AGENT_DEVICE_ID,
      action: 'edit',
      body: 'typo fixed',
    })
    expect(update?.body).toBe('typo fixed')
    // the live device sees the agent's edit
    await waitFor(() => editFor(a.events, agentMsgId).some((e) => e.body === 'typo fixed'))

    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws edit/delete — resume replay', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('replays edit_update frames after a resume cursor', async () => {
    const a = await openDevice(h.base, 'devA')
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'helo', client_msg_id: 'c1' }))
    await waitFor(() => a.events.some((e) => e.type === 'user_message'))
    const msgId = (a.events.find((e) => e.type === 'user_message') as { message_id: string }).message_id
    a.ws.send(JSON.stringify({ v: 1, type: 'edit', message_id: msgId, action: 'edit', body: 'hello' }))
    await waitFor(() => editFor(a.events, msgId).length > 0)
    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))

    // A fresh device resumes from cursor 0 → gets the message AND its edit state.
    const c = await openDevice(h.base, 'devC')
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))
    await waitFor(() => editFor(c.events, msgId).some((e) => e.body === 'hello'))
    expect(editFor(c.events, msgId).at(-1)?.body).toBe('hello')

    c.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})
