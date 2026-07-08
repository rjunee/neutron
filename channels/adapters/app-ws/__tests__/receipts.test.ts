/**
 * Track B Phase 4 — delivery + read receipts at the app-ws adapter layer.
 *
 * Exercises the server half over a REAL SQLite message + receipt log (not a
 * mock): delivered-at-fan-out stamping, the agent/client read path with its
 * `receipt_update` fan-out, multi-device read fan-out, and the resume receipt
 * replay. The legacy (no receipt_log) path is asserted to stay inert.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import {
  AppChatReceiptStore,
  AppChatStore,
  ProjectDb,
} from '@neutronai/persistence/index.ts'
import type { OutgoingMessage, Topic } from '../../../types.ts'
import { AppWsAdapter } from '../adapter.ts'
import { AGENT_DEVICE_ID } from '../envelope.ts'
import { InMemoryAppWsSessionRegistry } from '../session-registry.ts'
import type { AppWsOutbound } from '../envelope.ts'

const CHANNEL_TOPIC = 'app:sam'
const topic: Topic = {
  topic_id: 'topic-abc',
  channel_kind: 'app_socket',
  channel_topic_id: CHANNEL_TOPIC,
  project_id: null,
  privacy_mode: 'regular',
}

let tmp: string
let db: ProjectDb

/** Register one device on the topic; returns its captured-envelope sink. */
function device(registry: InMemoryAppWsSessionRegistry, device_id: string): AppWsOutbound[] {
  const captured: AppWsOutbound[] = []
  registry.register(CHANNEL_TOPIC, (e) => captured.push(e), { device_id })
  return captured
}

function setup(devices: string[] = ['devA']) {
  const registry = new InMemoryAppWsSessionRegistry()
  const sinks = new Map<string, AppWsOutbound[]>()
  for (const d of devices) sinks.set(d, device(registry, d))
  let n = 0
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
    now: () => 1000,
    generate_message_id: () => `msg-${++n}`,
    chat_log: new AppChatStore({ db }),
    receipt_log: new AppChatReceiptStore({ db }),
  })
  return { adapter, registry, sinks }
}

/** Latest receipt_update captured by a device's sink. */
function lastReceipt(sink: AppWsOutbound[]): Extract<AppWsOutbound, { type: 'receipt_update' }> | undefined {
  for (let i = sink.length - 1; i >= 0; i--) {
    const e = sink[i]
    if (e !== undefined && e.type === 'receipt_update') return e
  }
  return undefined
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-receipts-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AppWsAdapter — delivered at fan-out', () => {
  it('reports hasReceipts and stamps delivered_by with the connected devices', async () => {
    const { adapter, sinks } = setup(['devA', 'devB'])
    expect(adapter.hasReceipts).toBe(true)

    await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'hello',
      client_msg_id: 'c1',
    })
    const echo = sinks.get('devA')!.at(-1) as { type: string; delivered_by?: string[] }
    expect(echo.type).toBe('user_message')
    expect([...(echo.delivered_by ?? [])].sort()).toEqual(['devA', 'devB'])
  })

  it('stamps delivered_by on an agent message too', async () => {
    const { adapter, sinks } = setup(['devA'])
    const out: OutgoingMessage = { topic, text: 'hi there' }
    await adapter.send(out)
    const env = sinks.get('devA')!.at(-1) as { type: string; delivered_by?: string[] }
    expect(env.type).toBe('agent_message')
    expect(env.delivered_by).toEqual(['devA'])
  })
})

describe('AppWsAdapter — read receipts + fan-out', () => {
  it('agent read marks a user message read and fans receipt_update to every device', async () => {
    const { adapter, sinks } = setup(['devA', 'devB'])
    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'hello',
      client_msg_id: 'c1',
    })
    const update = await adapter.recordReceipt({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: ingest.message_id,
      device_id: AGENT_DEVICE_ID,
      state: 'read',
    })
    expect(update).not.toBeNull()
    expect(update!.read_by).toEqual([AGENT_DEVICE_ID])
    expect(update!.seq).toBe(1)
    // Both devices receive the fanned receipt_update.
    expect(lastReceipt(sinks.get('devA')!)?.read_by).toEqual([AGENT_DEVICE_ID])
    expect(lastReceipt(sinks.get('devB')!)?.read_by).toEqual([AGENT_DEVICE_ID])
  })

  it('multi-device: device B reading device A’s message fans read_by:[devB] to both', async () => {
    const { adapter, sinks } = setup(['devA', 'devB'])
    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'from A',
      client_msg_id: 'c1',
    })
    await adapter.recordReceipt({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: ingest.message_id,
      device_id: 'devB',
      state: 'read',
    })
    // Device A (the sender) learns its message was read by devB.
    expect(lastReceipt(sinks.get('devA')!)?.read_by).toEqual(['devB'])
    // delivered_by accumulated both devices from the original fan-out.
    expect([...(lastReceipt(sinks.get('devA')!)?.delivered_by ?? [])].sort()).toEqual([
      'devA',
      'devB',
    ])
  })

  it('read receipts accumulate (set-union) across devices + are monotonic', async () => {
    const { adapter } = setup(['devA', 'devB'])
    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'x',
      client_msg_id: 'c1',
    })
    await adapter.recordReceipt({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: ingest.message_id,
      device_id: 'devA',
      state: 'read',
    })
    const second = await adapter.recordReceipt({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: ingest.message_id,
      device_id: 'devB',
      state: 'read',
    })
    expect(second!.read_by).toEqual(['devA', 'devB'])
  })
})

describe('AppWsAdapter — receipt resume replay', () => {
  it('replays one receipt_update per message-with-receipts after a cursor', async () => {
    const { adapter } = setup(['devA'])
    const a = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'q1', client_msg_id: 'c1' })
    await adapter.send({ topic, text: 'a1' }) // seq 2
    const c = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'q2', client_msg_id: 'c2' }) // seq 3
    await adapter.recordReceipt({ channel_topic_id: CHANNEL_TOPIC, message_id: a.message_id, device_id: AGENT_DEVICE_ID, state: 'read' })
    await adapter.recordReceipt({ channel_topic_id: CHANNEL_TOPIC, message_id: c.message_id, device_id: AGENT_DEVICE_ID, state: 'read' })

    // Every message delivered to the live device carries a delivered receipt,
    // so all three (the agent reply at seq 2 included) replay; seqs 1 + 3 also
    // carry the agent READ.
    const all = await adapter.replayReceiptsAfter(CHANNEL_TOPIC, 0)
    expect(all.map((r) => r.seq).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 2, 3])
    const readSeqs = all.filter((r) => r.read_by.length > 0).map((r) => r.seq).sort((x, y) => (x ?? 0) - (y ?? 0))
    expect(readSeqs).toEqual([1, 3])

    // From a cursor mid-stream — only the tail replays.
    const tail = await adapter.replayReceiptsAfter(CHANNEL_TOPIC, 1)
    expect(tail.map((r) => r.seq).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([2, 3])
  })
})

describe('AppWsAdapter — no receipt log (legacy)', () => {
  it('omits delivered_by, recordReceipt → null, replay → []', async () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const captured = device(registry, 'devA')
    const adapter = new AppWsAdapter({
      registry,
      receiver: { receive: async () => {} },
      chat_log: new AppChatStore({ db }),
    })
    expect(adapter.hasReceipts).toBe(false)
    const ingest = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'hi', client_msg_id: 'c1' })
    expect((captured.at(-1) as { delivered_by?: string[] }).delivered_by).toBeUndefined()
    expect(
      await adapter.recordReceipt({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, device_id: 'devA', state: 'read' }),
    ).toBeNull()
    expect(await adapter.replayReceiptsAfter(CHANNEL_TOPIC, 0)).toEqual([])
  })
})

describe('InMemoryAppWsSessionRegistry — device tracking', () => {
  it('returns distinct connected device ids', () => {
    const registry = new InMemoryAppWsSessionRegistry()
    device(registry, 'devA')
    device(registry, 'devB')
    device(registry, 'devA') // a second socket for the same device id
    expect(registry.devices(CHANNEL_TOPIC).sort()).toEqual(['devA', 'devB'])
    expect(registry.devices('app:nobody')).toEqual([])
  })
})
