/**
 * @neutronai/message-search — runtime contract tests.
 *
 * Both runtime shapes are exercised against a REAL chat-core search index
 * (`InMemoryStore`): the store-backed runtime (topic / project / global
 * scoping) and the server history-source runtime (ephemeral per-topic
 * hydration, `global` → no results).
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore, type ChatMessage } from '@neutronai/chat-core'

import {
  HistorySourceMessageSearchRuntime,
  StoreMessageSearchRuntime,
  type MessageHistorySource,
} from './runtime.ts'

function msg(p: Partial<ChatMessage> & { client_msg_id: string }): ChatMessage {
  return {
    topic_id: 'app:sam',
    message_id: p.message_id ?? p.client_msg_id,
    seq: 1,
    role: 'user',
    body: 'x',
    project_id: null,
    attachments: null,
    created_at: 0,
    status: 'acked',
    ...p,
  }
}

async function seededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore()
  await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'm1', created_at: 1, body: 'deploy the gateway now', project_id: 'p1' }))
  await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'm2', created_at: 2, body: 'lunch later', project_id: 'p1' }))
  await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'm3', created_at: 3, body: 'gateway in the other project', project_id: 'p2' }))
  return store
}

describe('StoreMessageSearchRuntime', () => {
  it('scopes to a topic by default', async () => {
    const rt = new StoreMessageSearchRuntime(await seededStore())
    const hits = await rt.search({ query: 'gateway', topic_id: 'app:a' })
    expect(hits.map((h) => h.id)).toEqual(['m1'])
  })

  it('searches across all topics when global', async () => {
    const rt = new StoreMessageSearchRuntime(await seededStore())
    const hits = await rt.search({ query: 'gateway', topic_id: 'app:a', global: true })
    expect(hits.map((h) => h.id).sort()).toEqual(['m1', 'm3'])
  })

  it('scopes by project', async () => {
    const rt = new StoreMessageSearchRuntime(await seededStore())
    const hits = await rt.search({ query: 'gateway', global: true, project_id: 'p2' })
    expect(hits.map((h) => h.id)).toEqual(['m3'])
  })
})

describe('HistorySourceMessageSearchRuntime', () => {
  function source(byTopic: Record<string, ChatMessage[]>): MessageHistorySource {
    return {
      async loadTopicMessages(topic_id: string, limit: number): Promise<ChatMessage[]> {
        return (byTopic[topic_id] ?? []).slice(0, limit)
      },
    }
  }

  it('hydrates one topic and searches it', async () => {
    const rt = new HistorySourceMessageSearchRuntime(
      source({
        'app:a': [
          msg({ topic_id: 'app:a', client_msg_id: 'm1', created_at: 1, body: 'the gateway is down' }),
          msg({ topic_id: 'app:a', client_msg_id: 'm2', created_at: 2, body: 'unrelated chatter' }),
        ],
      }),
    )
    const hits = await rt.search({ query: 'gateway', topic_id: 'app:a' })
    expect(hits.map((h) => h.id)).toEqual(['m1'])
    expect(hits[0]?.snippet).toContain('[gateway]')
  })

  it('returns nothing for a global request (per-topic by design)', async () => {
    const rt = new HistorySourceMessageSearchRuntime(
      source({ 'app:a': [msg({ topic_id: 'app:a', client_msg_id: 'm1', body: 'gateway' })] }),
    )
    expect(await rt.search({ query: 'gateway', topic_id: 'app:a', global: true })).toEqual([])
  })

  it('returns nothing when no topic is supplied', async () => {
    const rt = new HistorySourceMessageSearchRuntime(source({}))
    expect(await rt.search({ query: 'gateway' })).toEqual([])
  })

  it('respects the hydrate limit', async () => {
    let askedLimit = -1
    const src: MessageHistorySource = {
      async loadTopicMessages(_t, limit) {
        askedLimit = limit
        return []
      },
    }
    const rt = new HistorySourceMessageSearchRuntime(src, 50)
    await rt.search({ query: 'x', topic_id: 'app:a' })
    expect(askedLimit).toBe(50)
  })
})
