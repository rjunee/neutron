/**
 * Track B Phase 4 (message edit/delete) — durable edit log over REAL SQLite
 * (bun:sqlite via ProjectDb). Covers edit/delete record, per-message `rev`
 * monotonicity, AUTHOR-ONLY authorization (a human device may mutate `user`
 * messages; the agent may mutate `agent` messages; cross-role is rejected), seq
 * resolution from the message log, and the resume `aggregatesAfter` range scan.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../migrations/runner.ts'
import {
  AppChatEditStore,
  AppChatEditNotAuthorizedError,
  APP_CHAT_AGENT_DEVICE_ID,
} from './app-chat-edits.ts'
import { AppChatStore } from './app-chat-store.ts'
import { ProjectDb } from './db.ts'

const TOPIC = 'app:sam'
let tmp: string
let db: ProjectDb
let messages: AppChatStore
let edits: AppChatEditStore

async function appendMessage(message_id: string, role: 'user' | 'agent' = 'user'): Promise<number> {
  const r = await messages.append({ topic_id: TOPIC, message_id, role, body: 'original', created_at: 1 })
  return r.row.seq
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-chat-edits-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  messages = new AppChatStore({ db })
  edits = new AppChatEditStore({ db })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AppChatEditStore — record edit/delete', () => {
  it('edits a user message (resolves seq, bumps rev, new body)', async () => {
    await appendMessage('m1') // seq 1
    const agg = await edits.record({
      topic_id: TOPIC,
      message_id: 'm1',
      editor_device_id: 'devA',
      action: 'edit',
      body: 'corrected',
      at: 100,
    })
    expect(agg.seq).toBe(1)
    expect(agg.rev).toBe(1)
    expect(agg.body).toBe('corrected')
    expect(agg.deleted).toBe(false)
    expect(agg.edited_at).toBe(100)
  })

  it('deletes a message (tombstone: empty body, deleted, higher rev)', async () => {
    await appendMessage('m1')
    await edits.record({ topic_id: TOPIC, message_id: 'm1', editor_device_id: 'devA', action: 'edit', body: 'v1', at: 1 })
    const del = await edits.record({
      topic_id: TOPIC,
      message_id: 'm1',
      editor_device_id: 'devA',
      action: 'delete',
      body: '',
      at: 2,
    })
    expect(del.deleted).toBe(true)
    expect(del.body).toBe('')
    expect(del.rev).toBe(2)
  })

  it('a re-edit advances rev and replaces the body', async () => {
    await appendMessage('m1')
    await edits.record({ topic_id: TOPIC, message_id: 'm1', editor_device_id: 'devA', action: 'edit', body: 'v1', at: 1 })
    const v2 = await edits.record({ topic_id: TOPIC, message_id: 'm1', editor_device_id: 'devA', action: 'edit', body: 'v2', at: 2 })
    expect(v2.body).toBe('v2')
    expect(v2.rev).toBe(2)
  })
})

describe('AppChatEditStore — author-only authorization', () => {
  it('rejects a human device editing an AGENT message (cross-role)', async () => {
    await appendMessage('a1', 'agent')
    await expect(
      edits.record({ topic_id: TOPIC, message_id: 'a1', editor_device_id: 'devA', action: 'edit', body: 'hax', at: 1 }),
    ).rejects.toBeInstanceOf(AppChatEditNotAuthorizedError)
  })

  it('rejects the agent editing a USER message (cross-role)', async () => {
    await appendMessage('m1', 'user')
    await expect(
      edits.record({
        topic_id: TOPIC,
        message_id: 'm1',
        editor_device_id: APP_CHAT_AGENT_DEVICE_ID,
        action: 'edit',
        body: 'nope',
        at: 1,
      }),
    ).rejects.toBeInstanceOf(AppChatEditNotAuthorizedError)
  })

  it('allows the agent to edit/delete its OWN agent message (agent-native parity)', async () => {
    await appendMessage('a1', 'agent')
    const agg = await edits.record({
      topic_id: TOPIC,
      message_id: 'a1',
      editor_device_id: APP_CHAT_AGENT_DEVICE_ID,
      action: 'edit',
      body: 'agent fixed a typo',
      at: 5,
    })
    expect(agg.body).toBe('agent fixed a typo')
    const del = await edits.record({
      topic_id: TOPIC,
      message_id: 'a1',
      editor_device_id: APP_CHAT_AGENT_DEVICE_ID,
      action: 'delete',
      body: '',
      at: 6,
    })
    expect(del.deleted).toBe(true)
  })

  it('rejects editing an unknown message (no author to authorize)', async () => {
    await expect(
      edits.record({ topic_id: TOPIC, message_id: 'ghost', editor_device_id: 'devA', action: 'edit', body: 'x', at: 1 }),
    ).rejects.toBeInstanceOf(AppChatEditNotAuthorizedError)
  })
})

describe('AppChatEditStore — aggregatesAfter (resume replay)', () => {
  it('returns per-message edit aggregates with seq > cursor, ascending', async () => {
    await appendMessage('m1') // seq 1
    await appendMessage('m2') // seq 2
    await appendMessage('m3') // seq 3
    await edits.record({ topic_id: TOPIC, message_id: 'm1', editor_device_id: 'devA', action: 'edit', body: 'e1', at: 1 })
    await edits.record({ topic_id: TOPIC, message_id: 'm3', editor_device_id: 'devA', action: 'delete', body: '', at: 1 })

    const after0 = await edits.aggregatesAfter(TOPIC, 0)
    expect(after0.map((a) => a.seq)).toEqual([1, 3])
    expect(after0[0]?.body).toBe('e1')
    expect(after0[1]?.deleted).toBe(true)

    const after1 = await edits.aggregatesAfter(TOPIC, 1)
    expect(after1.map((a) => a.seq)).toEqual([3])
  })

  it('isolates topics', async () => {
    await messages.append({ topic_id: 'app:kim', message_id: 'k1', role: 'user', body: 'x', created_at: 1 })
    await edits.record({ topic_id: 'app:kim', message_id: 'k1', editor_device_id: 'devA', action: 'edit', body: 'e', at: 1 })
    expect(await edits.aggregatesAfter(TOPIC, 0)).toEqual([])
  })

  it('aggregate() returns rev 0 / empty for an unedited message', async () => {
    await appendMessage('m1')
    const agg = await edits.aggregate(TOPIC, 'm1')
    expect(agg).toEqual({ message_id: 'm1', seq: 0, rev: 0, body: '', deleted: false, edited_at: 0 })
  })
})
