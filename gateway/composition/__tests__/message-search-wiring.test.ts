/**
 * @neutronai/gateway — `message_search` server bridge tests.
 *
 * Proves the ButtonStore→message-search adapter: a topic's turn history
 * (agent prompt bodies + user resolution replies) is lifted into chat
 * messages, hydrated into an ephemeral FTS index, and searched — so the live
 * agent's `message_search` over the current conversation returns the right,
 * highlighted turns. Drives a fake ButtonStore (only `listHistoryByTopic` is
 * exercised) including its cursor pagination.
 */

import { describe, expect, it } from 'bun:test'

import type { ButtonStore, ChatHistoryTurn } from '../../../channels/button-store.ts'

import { buildButtonStoreMessageSearchRuntime } from '../message-search-wiring.ts'

function agentTurn(prompt_id: string, body: string, created_at: number, reply?: string): ChatHistoryTurn {
  const base = { prompt_id, body, created_at }
  return reply !== undefined
    ? { ...base, resolved: true, resolution_text: reply }
    : { ...base, resolved: false, resolution_text: null }
}

/** Fake ButtonStore that serves a fixed topic history with real cursor paging. */
function fakeButtonStore(byTopic: Record<string, ChatHistoryTurn[]>): ButtonStore {
  return {
    async listHistoryByTopic(input: {
      topic_id: string
      before: number
      before_prompt_id: string | null
      limit: number
      now: number
    }): Promise<{ turns: ChatHistoryTurn[]; has_more: boolean }> {
      const all = [...(byTopic[input.topic_id] ?? [])].sort(
        (a, b) => b.created_at - a.created_at || (a.prompt_id < b.prompt_id ? 1 : -1),
      )
      const visible = all.filter((t) =>
        input.before_prompt_id === null
          ? t.created_at <= input.before
          : t.created_at < input.before ||
            (t.created_at === input.before && t.prompt_id < input.before_prompt_id),
      )
      const page = visible.slice(0, input.limit)
      return { turns: page, has_more: visible.length > input.limit }
    },
  } as unknown as ButtonStore
}

describe('buildButtonStoreMessageSearchRuntime', () => {
  it('searches the current conversation (agent bodies + user replies)', async () => {
    const rt = buildButtonStoreMessageSearchRuntime(
      fakeButtonStore({
        'web:u1': [
          agentTurn('p1', 'Shall I deploy the gateway tonight?', 100, 'yes do the gateway deploy'),
          agentTurn('p2', 'What should we have for lunch?', 200, 'tacos'),
        ],
      }),
    )
    const hits = await rt.search({ query: 'gateway', topic_id: 'web:u1' })
    // Both the agent prompt (p1:a) and the user reply (p1:u) mention gateway.
    expect(hits.map((h) => h.id).sort()).toEqual(['p1', 'p1:u'])
    expect(hits.every((h) => h.snippet.includes('[gateway]'))).toBe(true)
    // The lunch turn is not a match.
    expect(hits.some((h) => h.body.includes('lunch') || h.body === 'tacos')).toBe(false)
  })

  it('distinguishes agent vs user roles in the results', async () => {
    const rt = buildButtonStoreMessageSearchRuntime(
      fakeButtonStore({
        'web:u1': [agentTurn('p1', 'the gateway is healthy', 100, 'great, gateway looks good')],
      }),
    )
    const hits = await rt.search({ query: 'gateway', topic_id: 'web:u1' })
    const byId = new Map(hits.map((h) => [h.id, h.role]))
    expect(byId.get('p1')).toBe('agent')
    expect(byId.get('p1:u')).toBe('user')
  })

  it('pages through a long history to hydrate the index', async () => {
    const turns: ChatHistoryTurn[] = []
    for (let i = 0; i < 250; i++) {
      turns.push(agentTurn(`p${String(i).padStart(3, '0')}`, i === 199 ? 'the needle is here' : `filler ${i}`, i))
    }
    const rt = buildButtonStoreMessageSearchRuntime(fakeButtonStore({ 'web:u1': turns }))
    const hits = await rt.search({ query: 'needle', topic_id: 'web:u1' })
    // The match sits beyond the first 100-row page → only found if paging works.
    expect(hits.map((h) => h.id)).toEqual(['p199'])
  })

  it('returns nothing for a global request (server bridge is per-topic)', async () => {
    const rt = buildButtonStoreMessageSearchRuntime(
      fakeButtonStore({ 'web:u1': [agentTurn('p1', 'gateway', 1)] }),
    )
    expect(await rt.search({ query: 'gateway', topic_id: 'web:u1', global: true })).toEqual([])
  })

  it('survives a ButtonStore read failure (degrades to no results)', async () => {
    const throwing = {
      async listHistoryByTopic(): Promise<never> {
        throw new Error('db down')
      },
    } as unknown as ButtonStore
    const rt = buildButtonStoreMessageSearchRuntime(throwing)
    expect(await rt.search({ query: 'gateway', topic_id: 'web:u1' })).toEqual([])
  })
})
