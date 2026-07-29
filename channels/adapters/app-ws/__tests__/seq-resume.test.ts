import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { AppChatStore, ProjectDb } from '@neutronai/persistence/index.ts'
import type { OutgoingMessage, Topic } from '../../../types.ts'
import { AppWsAdapter } from '../adapter.ts'
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

function setup() {
  const registry = new InMemoryAppWsSessionRegistry()
  const captured: AppWsOutbound[] = []
  registry.register(CHANNEL_TOPIC, (e) => captured.push(e))
  let n = 0
  const adapter = new AppWsAdapter({
    registry,
    receiver: { receive: async () => {} },
    now: () => 1000,
    generate_message_id: () => `msg-${++n}`,
    chat_log: new AppChatStore({ db }),
  })
  return { adapter, registry, captured }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-ws-seq-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('AppWsAdapter — seq stamping with a durable log', () => {
  it('reports hasChatLog and stamps a monotonic seq on user echo + agent message', async () => {
    const { adapter, captured } = setup()
    expect(adapter.hasChatLog).toBe(true)

    const ingest = await adapter.ingestUserMessage({
      channel_topic_id: CHANNEL_TOPIC,
      user_id: 'sam',
      body: 'hello',
      client_msg_id: 'c1',
    })
    expect(ingest.seq).toBe(1)
    expect(captured.at(-1)).toMatchObject({ type: 'user_message', seq: 1, client_msg_id: 'c1' })

    const out: OutgoingMessage = { topic, text: 'hi there' }
    await adapter.send(out)
    expect(captured.at(-1)).toMatchObject({ type: 'agent_message', body: 'hi there', seq: 2 })

    expect(await adapter.currentMaxSeq(CHANNEL_TOPIC)).toBe(2)
  })

  it('is idempotent: re-ingesting the same client_msg_id reuses the seq + id', async () => {
    const { adapter } = setup()
    const a = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'hi', client_msg_id: 'c1' })
    const b = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'hi', client_msg_id: 'c1' })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(1)
    expect(b.message_id).toBe(a.message_id)
    expect(await adapter.currentMaxSeq(CHANNEL_TOPIC)).toBe(1)
  })
})

describe('AppWsAdapter — resume replay reconstructs envelopes', () => {
  it('replays the gap after a cursor as typed user/agent envelopes carrying seq', async () => {
    const { adapter } = setup()
    await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'q', client_msg_id: 'c1' })
    await adapter.send({ topic, text: 'a' })

    const full = await adapter.replayAfter(CHANNEL_TOPIC, 0)
    expect(full.length).toBe(2)
    expect(full[0]).toMatchObject({ type: 'user_message', body: 'q', seq: 1, client_msg_id: 'c1' })
    expect(full[1]).toMatchObject({ type: 'agent_message', body: 'a', seq: 2 })

    // From a cursor mid-stream — only the tail.
    const tail = await adapter.replayAfter(CHANNEL_TOPIC, 1)
    expect(tail.length).toBe(1)
    expect(tail[0]).toMatchObject({ type: 'agent_message', seq: 2 })
  })
})

describe('AppWsAdapter — W3a resume re-hydrates structured agent metadata', () => {
  it('round-trips options/prompt_id/kind/citations/doc_refs through a resume replay', async () => {
    const { adapter, captured } = setup()
    const PROMPT_ID = '00000000-0000-4000-8000-000000000abc'
    const projectTopic: Topic = { ...topic, project_id: 'proj-1' }
    const out: OutgoingMessage = {
      topic: projectTopic,
      text: 'Here are your options.',
      inline_choices: [
        { label: 'Yes', callback_data: 'yes' },
        { label: 'No', callback_data: 'no' },
      ],
      adapter_options: {
        prompt_id: PROMPT_ID,
        kind: 'buttons',
        allow_freeform: false,
        citations: [{ title: 'Docs', url: 'https://example.test/doc' }],
        image_urls: ['https://cdn.example/img.png'],
        doc_refs: [{ label: 'Plan', path: 'docs/plans/plan.md', project_id: 'proj-1' }],
        project_id: 'proj-1',
      },
    }
    await adapter.send(out)

    // The live-push envelope carries the full structured shape.
    const live = captured.at(-1) as unknown as Record<string, unknown>
    expect(live['type']).toBe('agent_message')

    // A resume replay reconstructs the SAME structured envelope from the
    // durable meta_json column — not a plain text bubble.
    const [replayed] = await adapter.replayAfter(CHANNEL_TOPIC, 0)
    const env = replayed as unknown as Record<string, unknown>
    expect(env['type']).toBe('agent_message')
    expect(env['body']).toBe('Here are your options.')
    expect(env['prompt_id']).toBe(PROMPT_ID)
    expect(env['kind']).toBe('buttons')
    expect(env['allow_freeform']).toBe(false)
    expect((env['options'] as { value: string }[]).map((o) => o.value)).toEqual(['yes', 'no'])
    expect((env['citations'] as { url: string }[])[0]?.url).toBe('https://example.test/doc')
    expect(env['image_urls']).toEqual(['https://cdn.example/img.png'])
    expect((env['doc_refs'] as { path: string }[])[0]?.path).toBe('docs/plans/plan.md')
    expect(env['project_id']).toBe('proj-1')
  })

  it('replays a plain agent message with no structured fields (meta stays absent)', async () => {
    const { adapter } = setup()
    await adapter.send({ topic, text: 'just text' })
    const [replayed] = await adapter.replayAfter(CHANNEL_TOPIC, 0)
    const env = replayed as unknown as Record<string, unknown>
    expect(env['type']).toBe('agent_message')
    expect(env['body']).toBe('just text')
    expect(env['options']).toBeUndefined()
    expect(env['prompt_id']).toBeUndefined()
    expect(env['citations']).toBeUndefined()
    expect(env['doc_refs']).toBeUndefined()
  })
})

describe('AppWsAdapter — no durable log (legacy)', () => {
  it('omits seq and returns [] for replay when no chat_log is wired', async () => {
    const registry = new InMemoryAppWsSessionRegistry()
    const captured: AppWsOutbound[] = []
    registry.register(CHANNEL_TOPIC, (e) => captured.push(e))
    const adapter = new AppWsAdapter({ registry, receiver: { receive: async () => {} } })
    expect(adapter.hasChatLog).toBe(false)
    const ingest = await adapter.ingestUserMessage({ channel_topic_id: CHANNEL_TOPIC, user_id: 'sam', body: 'hi' })
    expect(ingest.seq).toBeNull()
    expect((captured.at(-1) as { seq?: number }).seq).toBeUndefined()
    expect(await adapter.replayAfter(CHANNEL_TOPIC, 0)).toEqual([])
    expect(await adapter.currentMaxSeq(CHANNEL_TOPIC)).toBe(0)
  })
})
