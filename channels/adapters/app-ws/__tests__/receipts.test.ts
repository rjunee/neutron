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
  DEFAULT_RECEIPT_REPLAY_LIMIT,
  ProjectDb,
} from '@neutronai/persistence/index.ts'
import type { AppChatReceiptAggregate, AppChatReceiptLog } from '@neutronai/persistence/index.ts'
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

  it('drains the continuation cursor: a backlog LARGER than one replay page replays in FULL (no silent tail drop)', async () => {
    // The production bug this fixes end-to-end: a device resuming with a backlog
    // exceeding the store's default page size used to get only the first page
    // (the cursorless `aggregatesAfter`), silently dropping every message past
    // it. The adapter now drains `aggregatesAfterPage` across pages.
    const { adapter } = setup(['devA'])
    const messages = new AppChatStore({ db })
    const N = DEFAULT_RECEIPT_REPLAY_LIMIT + 5 // straddles the page boundary
    for (let i = 1; i <= N; i++) {
      const id = `m${i}`
      await messages.append({ topic_id: CHANNEL_TOPIC, message_id: id, role: 'user', body: 'x', created_at: i })
      await adapter.recordReceipt({ channel_topic_id: CHANNEL_TOPIC, message_id: id, device_id: 'devA', state: 'read' })
    }

    const replay = await adapter.replayReceiptsAfter(CHANNEL_TOPIC, 0)
    // Every one of the N messages replays exactly once — the tail past the first
    // page is delivered, not dropped.
    expect(replay).toHaveLength(N)
    const uniqueIds = new Set(replay.map((r) => r.message_id))
    expect(uniqueIds.size).toBe(N)
    // Ascending, contiguous seqs 1..N — nothing skipped across the page seam.
    expect(replay.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1))
  })

  it('compat boundary: a legacy log WITHOUT aggregatesAfterPage still replays (single-shot fallback, no throw)', async () => {
    // `aggregatesAfterPage` is OPTIONAL on the exported AppChatReceiptLog
    // contract. A pre-existing injected log implementing only the required
    // methods must not break: the adapter capability-detects the page method
    // and falls back to the cursorless `aggregatesAfter` instead of throwing
    // `aggregatesAfterPage is not a function`.
    const legacyCalls: Array<{ topic: string; after: number }> = []
    const legacyLog: AppChatReceiptLog = {
      record: async () => {
        throw new Error('unused in this test')
      },
      aggregate: async () => {
        throw new Error('unused in this test')
      },
      aggregatesAfter: async (topic_id, after_seq): Promise<AppChatReceiptAggregate[]> => {
        legacyCalls.push({ topic: topic_id, after: after_seq })
        return [
          { message_id: 'm1', seq: 1, delivered_by: ['devA'], read_by: [] },
          { message_id: 'm2', seq: 2, delivered_by: ['devA'], read_by: ['devA'] },
        ].filter((a) => a.seq > after_seq)
      },
      // NO aggregatesAfterPage — the compat boundary under test.
    }
    const registry = new InMemoryAppWsSessionRegistry()
    const adapter = new AppWsAdapter({
      registry,
      receiver: { receive: async () => {} },
      now: () => 1000,
      chat_log: new AppChatStore({ db }),
      receipt_log: legacyLog,
    })
    // Sanity: a concrete store DOES expose the page method (the other half of
    // the boundary — its full-cursor drain is covered above).
    expect(typeof new AppChatReceiptStore({ db }).aggregatesAfterPage).toBe('function')

    const replay = await adapter.replayReceiptsAfter(CHANNEL_TOPIC, 0)
    // Fallback made exactly one cursorless call (no page loop for a legacy log).
    expect(legacyCalls).toEqual([{ topic: CHANNEL_TOPIC, after: 0 }])
    expect(replay.map((r) => r.message_id)).toEqual(['m1', 'm2'])
    expect(replay[1]).toMatchObject({ read_by: ['devA'], seq: 2, type: 'receipt_update' })
  })

  it('liveness: the drain terminates on a malformed log that returns a NON-advancing cursor (no infinite spin)', async () => {
    // A conforming aggregatesAfterPage strictly advances next_cursor each page.
    // A broken implementation returning the SAME cursor forever would spin the
    // drain loop and stall reconnect. The strict-advance guard must stop it.
    let calls = 0
    const stuckLog: AppChatReceiptLog = {
      record: async () => {
        throw new Error('unused')
      },
      aggregate: async () => {
        throw new Error('unused')
      },
      aggregatesAfter: async () => [],
      // Always returns one aggregate + a cursor pinned to the SAME point (never
      // advances past seq 0) regardless of the requested cursor.
      aggregatesAfterPage: async () => {
        calls += 1
        if (calls > 100) throw new Error('drain did not terminate — infinite spin')
        return {
          aggregates: [{ message_id: 'm1', seq: 1, delivered_by: ['devA'], read_by: [] }],
          next_cursor: { seq: 0, message_id: '' },
        }
      },
    }
    const registry = new InMemoryAppWsSessionRegistry()
    const adapter = new AppWsAdapter({
      registry,
      receiver: { receive: async () => {} },
      now: () => 1000,
      chat_log: new AppChatStore({ db }),
      receipt_log: stuckLog,
    })
    const replay = await adapter.replayReceiptsAfter(CHANNEL_TOPIC, 0)
    // Stopped after the first page (cursor {0,''} does not advance past the
    // fresh cursor seq 0) — no spin.
    expect(calls).toBe(1)
    expect(replay.map((r) => r.message_id)).toEqual(['m1'])
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
