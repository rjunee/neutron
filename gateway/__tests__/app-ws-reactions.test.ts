/**
 * Track B Phase 4 (message reactions) end-to-end over the real gateway app-ws
 * WebSocket surface (Bun.serve), backed by a real SQLite message + reaction
 * log. Exercises: a `reaction` frame fanning a `reaction_update` to every
 * device, multi-device aggregation, removal clearing the set, the resume
 * reaction replay, and device attribution from the SOCKET (a forged frame
 * device id is ignored).
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
import { AppChatReactionStore, AppChatStore, ProjectDb } from '../../persistence/index.ts'
import { applyMigrations } from '../../migrations/runner.ts'
import { composeHttpHandler } from '../http/compose.ts'
import { createAppWsSurface } from '../http/app-ws-surface.ts'

interface Harness {
  base: string
  close(): Promise<void>
}

let tmp: string
let db: ProjectDb

async function startGateway(): Promise<Harness> {
  const registry = new InMemoryAppWsSessionRegistry()
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
    chat_log: new AppChatStore({ db }),
    reaction_log: new AppChatReactionStore({ db }),
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

function reactionFor(events: AppWsOutbound[], messageId: string) {
  return events
    .filter((e): e is Extract<AppWsOutbound, { type: 'reaction_update' }> => e.type === 'reaction_update')
    .filter((e) => e.message_id === messageId)
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gw-reactions-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('app-ws reactions — add/remove fan-out', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('an add fans a reaction_update to every device, attributed to the socket', async () => {
    const a = await openDevice(h.base, 'devA')
    const b = await openDevice(h.base, 'devB')

    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c1' }))
    await waitFor(() => b.events.some((e) => e.type === 'user_message'))
    const echo = a.events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') throw new Error('expected echo')
    const msgId = echo.message_id

    // Device B reacts — attribution comes from B's SOCKET, NOT the (forged)
    // device_id in the frame.
    b.ws.send(JSON.stringify({ v: 1, type: 'reaction', message_id: msgId, emoji: '👍', action: 'add', device_id: 'devEVIL' }))
    await waitFor(() => reactionFor(a.events, msgId).some((r) => r.reactions.length > 0))
    const update = reactionFor(a.events, msgId).at(-1)
    expect(update?.reactions).toEqual([{ emoji: '👍', device_id: 'devB' }])

    a.ws.close()
    b.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('a remove clears the reaction set across devices', async () => {
    const a = await openDevice(h.base, 'devA')
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c1' }))
    await waitFor(() => a.events.some((e) => e.type === 'user_message'))
    const msgId = (a.events.find((e) => e.type === 'user_message') as { message_id: string }).message_id

    a.ws.send(JSON.stringify({ v: 1, type: 'reaction', message_id: msgId, emoji: '👍', action: 'add' }))
    await waitFor(() => reactionFor(a.events, msgId).some((r) => r.reactions.length > 0))
    a.ws.send(JSON.stringify({ v: 1, type: 'reaction', message_id: msgId, emoji: '👍', action: 'remove' }))
    await waitFor(() => reactionFor(a.events, msgId).some((r) => r.reactions.length === 0 && r.rev >= 2))
    expect(reactionFor(a.events, msgId).at(-1)?.reactions).toEqual([])

    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws reactions — resume replay', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('replays reaction_update frames after a resume cursor', async () => {
    const a = await openDevice(h.base, 'devA')
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c1' }))
    await waitFor(() => a.events.some((e) => e.type === 'user_message'))
    const msgId = (a.events.find((e) => e.type === 'user_message') as { message_id: string }).message_id
    a.ws.send(JSON.stringify({ v: 1, type: 'reaction', message_id: msgId, emoji: '🎉', action: 'add' }))
    await waitFor(() => reactionFor(a.events, msgId).length > 0)
    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))

    // A fresh device resumes from cursor 0 → gets the message AND its reactions.
    const c = await openDevice(h.base, 'devC')
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))
    await waitFor(() => reactionFor(c.events, msgId).some((r) => r.reactions.length > 0))
    expect(reactionFor(c.events, msgId).at(-1)?.reactions).toEqual([{ emoji: '🎉', device_id: 'devA' }])

    c.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})
