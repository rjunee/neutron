/**
 * @neutronai/chat-core — message-search (JS path) contract tests.
 *
 * Exercises the pure-JS search that backs {@link InMemoryStore} (and the OPFS
 * web store + offline fallback): query sanitisation, AND-of-terms matching,
 * relevance + recency ranking, `[`…`]` highlighting, and topic/project
 * scoping — plus that the search stays consistent when a message is edited or
 * deleted via the Store's own write path.
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore } from '../store.ts'
import { buildSnippet, queryTerms, sanitizeFtsQuery } from '../search.ts'
import type { ChatMessage } from '../types.ts'

const TOPIC = 'app:sam'

function msg(p: Partial<ChatMessage> & { client_msg_id: string }): ChatMessage {
  return {
    topic_id: TOPIC,
    message_id: null,
    seq: null,
    role: 'user',
    body: 'x',
    project_id: null,
    attachments: null,
    created_at: 0,
    status: 'acked',
    ...p,
  }
}

describe('sanitizeFtsQuery', () => {
  it('passes bare alphanumeric tokens through verbatim', () => {
    expect(sanitizeFtsQuery('hello world 42')).toBe('hello world 42')
  })
  it('phrase-quotes hyphenated / punctuated tokens so FTS5 grammar never fires', () => {
    expect(sanitizeFtsQuery('daily-driver')).toBe('"daily-driver"')
    expect(sanitizeFtsQuery('a "b c"')).toBe('a """b" "c"""')
  })
  it('returns empty for whitespace-only / non-string input', () => {
    expect(sanitizeFtsQuery('   ')).toBe('')
    expect(sanitizeFtsQuery('')).toBe('')
    expect(sanitizeFtsQuery(undefined as unknown as string)).toBe('')
  })
})

describe('queryTerms', () => {
  it('lowercases + splits into alnum_ runs', () => {
    expect(queryTerms('Hello, WORLD_42!')).toEqual(['hello', 'world_42'])
  })
})

describe('buildSnippet', () => {
  it('wraps every whole-word term occurrence with [..]', () => {
    expect(buildSnippet('the quick brown fox', ['quick', 'fox'])).toBe('the [quick] brown [fox]')
  })
  it('does not highlight a term embedded in a larger word', () => {
    expect(buildSnippet('foxes are clever', ['fox'])).toBe('foxes are clever')
  })
  it('windows long bodies around the first match with ellipses', () => {
    const body = 'a'.repeat(200) + ' needle ' + 'b'.repeat(200)
    const snip = buildSnippet(body, ['needle'])
    expect(snip).toContain('[needle]')
    expect(snip).toContain('…')
    expect(snip.length).toBeLessThan(body.length)
  })
})

describe('InMemoryStore.searchMessages', () => {
  async function seed(): Promise<InMemoryStore> {
    const store = new InMemoryStore()
    await store.upsert(msg({ client_msg_id: 'a', message_id: 'm1', seq: 1, created_at: 100, body: 'Deploy the gateway to production tonight' }))
    await store.upsert(msg({ client_msg_id: 'b', message_id: 'm2', seq: 2, created_at: 200, role: 'agent', body: 'The gateway deploy succeeded; production is green' }))
    await store.upsert(msg({ client_msg_id: 'c', message_id: 'm3', seq: 3, created_at: 300, body: 'Lunch plans for tomorrow?' }))
    return store
  }

  it('returns only messages containing ALL query terms (AND semantics)', async () => {
    const store = await seed()
    const hits = await store.searchMessages('gateway deploy')
    expect(hits.map((h) => h.id).sort()).toEqual(['m1', 'm2'])
    // The unrelated lunch message is not a hit.
    expect(hits.some((h) => h.id === 'm3')).toBe(false)
  })

  it('highlights matched terms in the snippet', async () => {
    const store = await seed()
    const [top] = await store.searchMessages('production')
    expect(top?.snippet).toContain('[production]')
  })

  it('ranks denser (shorter) matches above longer ones, scores in [0,1]', async () => {
    const store = await seed()
    const hits = await store.searchMessages('gateway')
    expect(hits.length).toBe(2)
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0)
      expect(h.score).toBeLessThanOrEqual(1)
    }
    // m1 ("Deploy the gateway…", 6 tokens) is denser than m2 (7 tokens), so
    // it outranks despite being older — relevance dominates the blend.
    expect(hits[0]?.id).toBe('m1')
  })

  it('breaks a relevance tie by recency (newest first)', async () => {
    const store = new InMemoryStore()
    // Identical bodies → identical relevance; only created_at differs.
    await store.upsert(msg({ client_msg_id: 'old', message_id: 'old', created_at: 100, body: 'alpha beta gamma' }))
    await store.upsert(msg({ client_msg_id: 'new', message_id: 'new', created_at: 900, body: 'alpha beta gamma' }))
    const hits = await store.searchMessages('alpha')
    expect(hits.map((h) => h.id)).toEqual(['new', 'old'])
  })

  it('scopes by topic and by project', async () => {
    const store = new InMemoryStore()
    await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'a1', message_id: 'm1', body: 'shared keyword here', project_id: 'p1' }))
    await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'b1', message_id: 'm2', body: 'shared keyword here', project_id: 'p2' }))
    // Global: both topics.
    expect((await store.searchMessages('keyword')).length).toBe(2)
    // Topic-scoped: just one.
    expect((await store.searchMessages('keyword', { topic_id: 'app:a' })).map((h) => h.id)).toEqual(['m1'])
    // Project-scoped: just one.
    expect((await store.searchMessages('keyword', { project_id: 'p2' })).map((h) => h.id)).toEqual(['m2'])
  })

  it('honours the limit (clamped)', async () => {
    const store = new InMemoryStore()
    for (let i = 0; i < 5; i++) {
      await store.upsert(msg({ client_msg_id: `c${i}`, message_id: `m${i}`, created_at: i, body: `match number ${i}` }))
    }
    expect((await store.searchMessages('match', { limit: 2 })).length).toBe(2)
  })

  it('returns nothing for an empty / whitespace query', async () => {
    const store = await seed()
    expect(await store.searchMessages('   ')).toEqual([])
  })

  it('stays consistent after an edit (re-upsert) and a topic clear', async () => {
    const store = await seed()
    // Edit m3's body so it now matches "gateway"; the upsert merge keeps the
    // same identity, so the message is updated in place, not duplicated.
    await store.upsert(msg({ client_msg_id: 'c', message_id: 'm3', seq: 3, created_at: 300, body: 'Actually the gateway lunch is cancelled' }))
    const hits = await store.searchMessages('gateway')
    expect(hits.map((h) => h.id).sort()).toEqual(['m1', 'm2', 'm3'])
    // Clearing the topic drops everything from search.
    await store.clear(TOPIC)
    expect(await store.searchMessages('gateway')).toEqual([])
  })
})
