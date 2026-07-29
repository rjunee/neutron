/**
 * Track B Phase 4 — delivery + read receipts end-to-end over the real gateway
 * app-ws WebSocket surface (Bun.serve), backed by a real SQLite message +
 * receipt log. Exercises: inline delivered_by on the echo, the agent
 * auto-read receipt_update, multi-device read fan-out (device B reads device
 * A's message → A is notified), and the resume receipt replay.
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
import { AppChatReceiptStore, AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
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
    receipt_log: new AppChatReceiptStore({ db }),
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

/** Open a device socket; collects every inbound envelope. */
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

function receiptFor(events: AppWsOutbound[], messageId: string) {
  return events
    .filter((e): e is Extract<AppWsOutbound, { type: 'receipt_update' }> => e.type === 'receipt_update')
    .filter((e) => e.message_id === messageId)
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gw-receipts-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  // Apply the full migration tree so app_chat_messages + app_chat_receipts exist.
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('app-ws receipts — single device + agent auto-read', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('echoes delivered_by:[self] and fans an agent read_by receipt_update', async () => {
    const a = await openDevice(h.base, 'devA')
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c1' }))

    await waitFor(() => a.events.some((e) => e.type === 'user_message'))
    const echo = a.events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') throw new Error('expected echo')
    expect(echo.delivered_by).toEqual(['devA'])
    const msgId = echo.message_id

    // The agent picked it up → read receipt fanned back to device A.
    await waitFor(() => receiptFor(a.events, msgId).some((r) => r.read_by.includes('agent')))
    const update = receiptFor(a.events, msgId).at(-1)
    expect(update?.read_by).toEqual(['agent'])

    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws receipts — multi-device read fan-out', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('device B reading device A’s message notifies device A', async () => {
    const a = await openDevice(h.base, 'devA')
    const b = await openDevice(h.base, 'devB')

    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hello', client_msg_id: 'c1' }))
    // Both devices receive the echo; delivered_by covers both live devices.
    await waitFor(() => b.events.some((e) => e.type === 'user_message'))
    const echo = a.events.find((e) => e.type === 'user_message')
    if (echo === undefined || echo.type !== 'user_message') throw new Error('expected echo')
    const msgId = echo.message_id
    expect([...(echo.delivered_by ?? [])].sort()).toEqual(['devA', 'devB'])

    // Device B reports it READ the message → device A learns it was read by B.
    b.ws.send(JSON.stringify({ v: 1, type: 'receipt', message_id: msgId, state: 'read' }))
    await waitFor(() => receiptFor(a.events, msgId).some((r) => r.read_by.includes('devB')))
    const update = receiptFor(a.events, msgId).at(-1)
    expect(update?.read_by).toContain('devB')

    a.ws.close()
    b.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('app-ws receipts — resume replay', () => {
  let h: Harness
  beforeEach(async () => {
    h = await startGateway()
  })
  afterEach(async () => {
    await h.close()
  })

  it('replays receipt_update frames after a resume cursor', async () => {
    // Device A sends + the agent reads it.
    const a = await openDevice(h.base, 'devA')
    a.ws.send(JSON.stringify({ v: 1, type: 'user_message', body: 'hi', client_msg_id: 'c1' }))
    await waitFor(() => a.events.some((e) => e.type === 'user_message'))
    const msgId = (a.events.find((e) => e.type === 'user_message') as { message_id: string }).message_id
    await waitFor(() => receiptFor(a.events, msgId).length > 0)
    a.ws.close()
    await new Promise((r) => setTimeout(r, 30))

    // A fresh device resumes from cursor 0 → gets the message AND its receipts.
    const c = await openDevice(h.base, 'devC')
    c.ws.send(JSON.stringify({ v: 1, type: 'resume', after_seq: 0 }))
    await waitFor(() => receiptFor(c.events, msgId).some((r) => r.read_by.includes('agent')))
    expect(receiptFor(c.events, msgId).at(-1)?.read_by).toContain('agent')

    c.ws.close()
    await new Promise((r) => setTimeout(r, 30))
  })
})
