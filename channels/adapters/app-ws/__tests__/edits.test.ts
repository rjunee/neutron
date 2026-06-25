/**
 * Track B Phase 4 (message edit/delete) at the app-ws adapter layer + the wire
 * decoder. Exercises the server half over a REAL SQLite message + edit log:
 * recordEdit's `edit_update` fan-out, delete tombstone, author-only
 * authorization (cross-role reject + agent-native parity), the resume edit
 * replay, and the legacy (no edit_log) inert path. Plus `decodeAppWsEdit`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../../migrations/runner.ts'
import {
  AppChatEditStore,
  AppChatEditNotAuthorizedError,
  APP_CHAT_AGENT_DEVICE_ID,
  AppChatStore,
  ProjectDb,
} from '../../../../persistence/index.ts'
import type { Topic } from '../../../types.ts'
import { AppWsAdapter } from '../adapter.ts'
import { decodeAppWsEdit } from '../envelope.ts'
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

function device(registry: InMemoryAppWsSessionRegistry, device_id: string): AppWsOutbound[] {
  const captured: AppWsOutbound[] = []
  registry.register(CHANNEL_TOPIC, (e) => captured.push(e), { device_id })
  return captured
}

function setup(devices: string[] = ['devA'], opts: { withEditLog?: boolean } = {}) {
  const withEditLog = opts.withEditLog ?? true
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
    ...(withEditLog ? { edit_log: new AppChatEditStore({ db }) } : {}),
  })
  return { adapter, registry, sinks }
}

/** Latest edit_update captured by a device's sink. */
function lastEdit(
  sink: AppWsOutbound[],
): Extract<AppWsOutbound, { type: 'edit_update' }> | undefined {
  for (let i = sink.length - 1; i >= 0; i--) {
    const e = sink[i]
    if (e !== undefined && e.type === 'edit_update') return e
  }
  return undefined
}

/** Send an agent message and return its server message id. */
async function sendAgent(adapter: AppWsAdapter, text: string): Promise<string> {
  const res = await adapter.send({ topic, text } as Parameters<AppWsAdapter['send']>[0])
  return res.split(':').pop() ?? ''
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-edits-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('decodeAppWsEdit', () => {
  it('decodes a well-formed edit frame', () => {
    expect(decodeAppWsEdit({ v: 1, type: 'edit', message_id: 'm1', action: 'edit', body: 'new' })).toEqual({
      v: 1,
      type: 'edit',
      message_id: 'm1',
      action: 'edit',
      body: 'new',
    })
  })

  it('decodes a delete frame (no body required)', () => {
    expect(decodeAppWsEdit({ v: 1, type: 'edit', message_id: 'm1', action: 'delete' })).toEqual({
      v: 1,
      type: 'edit',
      message_id: 'm1',
      action: 'delete',
    })
  })

  it('rejects bad action / empty message_id / missing-or-empty edit body', () => {
    expect(decodeAppWsEdit({ v: 1, type: 'edit', message_id: 'm1', action: 'nope', body: 'x' })).toBeNull()
    expect(decodeAppWsEdit({ v: 1, type: 'edit', message_id: '', action: 'edit', body: 'x' })).toBeNull()
    expect(decodeAppWsEdit({ v: 1, type: 'edit', message_id: 'm1', action: 'edit' })).toBeNull()
    expect(decodeAppWsEdit({ v: 1, type: 'edit', message_id: 'm1', action: 'edit', body: '' })).toBeNull()
  })

  it('ignores an editor device_id in the frame (anti-forge: surface attributes from socket)', () => {
    const d = decodeAppWsEdit({ v: 1, type: 'edit', message_id: 'm1', action: 'delete', editor_device_id: 'devEVIL' })
    expect(d).not.toBeNull()
    expect('editor_device_id' in (d ?? {})).toBe(false)
  })
})

describe('AppWsAdapter — edit fan-out', () => {
  it('reports hasEdits and fans an edit_update to every device on edit', async () => {
    const { adapter, sinks } = setup(['devA', 'devB'])
    expect(adapter.hasEdits).toBe(true)
    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'helo',
      client_msg_id: 'c1',
    })
    const update = await adapter.recordEdit({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: ingest.message_id,
      editor_device_id: 'devB',
      action: 'edit',
      body: 'hello',
    })
    expect(update).not.toBeNull()
    expect(update!.body).toBe('hello')
    expect(update!.deleted).toBe(false)
    expect(update!.rev).toBe(1)
    expect(update!.seq).toBe(1)
    expect(lastEdit(sinks.get('devA')!)?.body).toBe('hello')
    expect(lastEdit(sinks.get('devB')!)?.body).toBe('hello')
  })

  it('a delete fans a tombstone (deleted, empty body, higher rev)', async () => {
    const { adapter } = setup(['devA'])
    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'oops',
      client_msg_id: 'c1',
    })
    await adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, editor_device_id: 'devA', action: 'edit', body: 'v1' })
    const del = await adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, editor_device_id: 'devA', action: 'delete' })
    expect(del!.deleted).toBe(true)
    expect(del!.body).toBe('')
    expect(del!.rev).toBe(2)
  })

  it('an empty edit body is a no-op (returns null, fans nothing)', async () => {
    const { adapter } = setup(['devA'])
    const ingest = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'x', client_msg_id: 'c1' })
    const res = await adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, editor_device_id: 'devA', action: 'edit', body: '' })
    expect(res).toBeNull()
  })

  it('legacy (no edit_log) → recordEdit is inert (null) and hasEdits is false', async () => {
    const { adapter } = setup(['devA'], { withEditLog: false })
    expect(adapter.hasEdits).toBe(false)
    const ingest = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'x', client_msg_id: 'c1' })
    expect(
      await adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, editor_device_id: 'devA', action: 'edit', body: 'y' }),
    ).toBeNull()
  })
})

describe('AppWsAdapter — author-only authorization + agent parity', () => {
  it('rejects a human device editing an AGENT message', async () => {
    const { adapter } = setup(['devA'])
    const agentMsgId = await sendAgent(adapter, 'agent says hi')
    await expect(
      adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: agentMsgId, editor_device_id: 'devA', action: 'edit', body: 'hax' }),
    ).rejects.toBeInstanceOf(AppChatEditNotAuthorizedError)
  })

  it('lets the agent edit + delete its OWN message (agent-native parity)', async () => {
    const { adapter, sinks } = setup(['devA'])
    const agentMsgId = await sendAgent(adapter, 'agent says hi')
    const edited = await adapter.recordEdit({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: agentMsgId,
      editor_device_id: APP_CHAT_AGENT_DEVICE_ID,
      action: 'edit',
      body: 'agent fixed a typo',
    })
    expect(edited!.body).toBe('agent fixed a typo')
    expect(lastEdit(sinks.get('devA')!)?.body).toBe('agent fixed a typo')
    const del = await adapter.recordEdit({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: agentMsgId,
      editor_device_id: APP_CHAT_AGENT_DEVICE_ID,
      action: 'delete',
    })
    expect(del!.deleted).toBe(true)
  })

  it('rejects the agent editing a USER message', async () => {
    const { adapter } = setup(['devA'])
    const ingest = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'mine', client_msg_id: 'c1' })
    await expect(
      adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, editor_device_id: APP_CHAT_AGENT_DEVICE_ID, action: 'delete' }),
    ).rejects.toBeInstanceOf(AppChatEditNotAuthorizedError)
  })
})

describe('AppWsAdapter — edit resume replay', () => {
  it('replays one edit_update per edited/deleted message after a cursor', async () => {
    const { adapter } = setup(['devA'])
    const a = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'q1', client_msg_id: 'c1' }) // seq 1
    await sendAgent(adapter, 'a1') // seq 2
    const c = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'q2', client_msg_id: 'c2' }) // seq 3
    await adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: a.message_id, editor_device_id: 'devA', action: 'edit', body: 'q1-edited' })
    await adapter.recordEdit({ channel_topic_id: CHANNEL_TOPIC, message_id: c.message_id, editor_device_id: 'devA', action: 'delete' })

    const all = await adapter.replayEditsAfter(CHANNEL_TOPIC, 0)
    expect(all.map((e) => e.seq).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 3])

    const tail = await adapter.replayEditsAfter(CHANNEL_TOPIC, 1)
    expect(tail.map((e) => e.seq)).toEqual([3])
    expect(tail[0]?.deleted).toBe(true)
  })

  it('legacy (no edit_log) replays nothing', async () => {
    const { adapter } = setup(['devA'], { withEditLog: false })
    expect(await adapter.replayEditsAfter(CHANNEL_TOPIC, 0)).toEqual([])
  })
})
