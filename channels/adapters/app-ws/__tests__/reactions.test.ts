/**
 * Track B Phase 4 (message reactions) at the app-ws adapter layer + the wire
 * decoder. Exercises the server half over a REAL SQLite message + reaction log:
 * recordReaction's `reaction_update` fan-out, removal clearing the set,
 * multi-device aggregation, the resume reaction replay, and the legacy
 * (no reaction_log) inert path. Plus `decodeAppWsReaction` / emoji validation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import {
  AppChatReactionStore,
  AppChatStore,
  ProjectDb,
} from '@neutronai/persistence/index.ts'
import type { Topic } from '../../../types.ts'
import { AppWsAdapter } from '../adapter.ts'
import { decodeAppWsReaction, sanitizeReactionEmoji } from '../envelope.ts'
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
    reaction_log: new AppChatReactionStore({ db }),
  })
  return { adapter, registry, sinks }
}

/** Latest reaction_update captured by a device's sink. */
function lastReaction(
  sink: AppWsOutbound[],
): Extract<AppWsOutbound, { type: 'reaction_update' }> | undefined {
  for (let i = sink.length - 1; i >= 0; i--) {
    const e = sink[i]
    if (e !== undefined && e.type === 'reaction_update') return e
  }
  return undefined
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-reactions-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('decodeAppWsReaction + sanitizeReactionEmoji', () => {
  it('decodes a well-formed add/remove frame', () => {
    expect(decodeAppWsReaction({ v: 1, type: 'reaction', message_id: 'm1', emoji: '👍', action: 'add' })).toEqual({
      v: 1,
      type: 'reaction',
      message_id: 'm1',
      emoji: '👍',
      action: 'add',
    })
    expect(
      decodeAppWsReaction({ v: 1, type: 'reaction', message_id: 'm1', emoji: '❤️', action: 'remove', seq: 4 }),
    ).toEqual({ v: 1, type: 'reaction', message_id: 'm1', emoji: '❤️', action: 'remove', seq: 4 })
  })

  it('rejects bad action / empty message_id / bad emoji', () => {
    expect(decodeAppWsReaction({ v: 1, type: 'reaction', message_id: 'm1', emoji: '👍', action: 'nope' })).toBeNull()
    expect(decodeAppWsReaction({ v: 1, type: 'reaction', message_id: '', emoji: '👍', action: 'add' })).toBeNull()
    expect(decodeAppWsReaction({ v: 1, type: 'reaction', message_id: 'm1', emoji: '', action: 'add' })).toBeNull()
    // A device id in the frame is IGNORED (anti-forge): the surface attributes
    // from the socket, never the frame.
    const d = decodeAppWsReaction({ v: 1, type: 'reaction', message_id: 'm1', emoji: '👍', action: 'add', device_id: 'devEVIL' })
    expect(d).not.toBeNull()
    expect('device_id' in (d ?? {})).toBe(false)
  })

  it('sanitizeReactionEmoji rejects whitespace / control / oversize / multi-token text', () => {
    expect(sanitizeReactionEmoji('👍')).toBe('👍')
    expect(sanitizeReactionEmoji('not an emoji')).toBeNull()
    expect(sanitizeReactionEmoji('a\nb')).toBeNull()
    expect(sanitizeReactionEmoji('x'.repeat(65))).toBeNull()
    expect(sanitizeReactionEmoji(42)).toBeNull()
  })
})

describe('AppWsAdapter — reactions fan-out', () => {
  it('reports hasReactions and fans a reaction_update to every device on add', async () => {
    const { adapter, sinks } = setup(['devA', 'devB'])
    expect(adapter.hasReactions).toBe(true)
    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'hello',
      client_msg_id: 'c1',
    })
    const update = await adapter.recordReaction({
      channel_topic_id: CHANNEL_TOPIC,
      message_id: ingest.message_id,
      device_id: 'devB',
      emoji: '👍',
      action: 'add',
    })
    expect(update).not.toBeNull()
    expect(update!.reactions).toEqual([{ emoji: '👍', device_id: 'devB' }])
    expect(update!.rev).toBe(1)
    expect(update!.seq).toBe(1)
    // Both devices saw it.
    expect(lastReaction(sinks.get('devA')!)?.reactions).toEqual([{ emoji: '👍', device_id: 'devB' }])
    expect(lastReaction(sinks.get('devB')!)?.reactions).toEqual([{ emoji: '👍', device_id: 'devB' }])
  })

  it('a remove clears the set and advances rev', async () => {
    const { adapter } = setup(['devA'])
    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'x',
      client_msg_id: 'c1',
    })
    await adapter.recordReaction({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, device_id: 'devA', emoji: '👍', action: 'add' })
    const removed = await adapter.recordReaction({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, device_id: 'devA', emoji: '👍', action: 'remove' })
    expect(removed!.reactions).toEqual([])
    expect(removed!.rev).toBe(2)
  })

  it('multi-device: two devices’ reactions aggregate', async () => {
    const { adapter } = setup(['devA', 'devB'])
    const ingest = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'x', client_msg_id: 'c1' })
    await adapter.recordReaction({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, device_id: 'devA', emoji: '👍', action: 'add' })
    const second = await adapter.recordReaction({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, device_id: 'devB', emoji: '🎉', action: 'add' })
    expect(second!.reactions).toEqual([
      { emoji: '🎉', device_id: 'devB' },
      { emoji: '👍', device_id: 'devA' },
    ])
  })
})

describe('AppWsAdapter — reaction resume replay', () => {
  it('replays one reaction_update per message-with-reactions after a cursor', async () => {
    const { adapter } = setup(['devA'])
    const a = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'q1', client_msg_id: 'c1' }) // seq 1
    await adapter.send({ topic, text: 'a1' }) // seq 2
    const c = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'q2', client_msg_id: 'c2' }) // seq 3
    await adapter.recordReaction({ channel_topic_id: CHANNEL_TOPIC, message_id: a.message_id, device_id: 'devA', emoji: '👍', action: 'add' })
    await adapter.recordReaction({ channel_topic_id: CHANNEL_TOPIC, message_id: c.message_id, device_id: 'devA', emoji: '🎉', action: 'add' })

    const all = await adapter.replayReactionsAfter(CHANNEL_TOPIC, 0)
    expect(all.map((r) => r.seq).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([1, 3])

    const tail = await adapter.replayReactionsAfter(CHANNEL_TOPIC, 1)
    expect(tail.map((r) => r.seq)).toEqual([3])
  })
})

describe('AppWsAdapter — no reaction log (legacy)', () => {
  it('hasReactions false, recordReaction → null, replay → []', async () => {
    const registry = new InMemoryAppWsSessionRegistry()
    device(registry, 'devA')
    const adapter = new AppWsAdapter({
      registry,
      receiver: { receive: async () => {} },
      chat_log: new AppChatStore({ db }),
    })
    expect(adapter.hasReactions).toBe(false)
    const ingest = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'hi', client_msg_id: 'c1' })
    expect(
      await adapter.recordReaction({ channel_topic_id: CHANNEL_TOPIC, message_id: ingest.message_id, device_id: 'devA', emoji: '👍', action: 'add' }),
    ).toBeNull()
    expect(await adapter.replayReactionsAfter(CHANNEL_TOPIC, 0)).toEqual([])
  })
})
