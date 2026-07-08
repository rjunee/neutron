/**
 * @neutronai/message-search — `message_search` tool-surface tests.
 *
 * Registers the tool into a real {@link ToolRegistry} and drives its handler
 * end-to-end (args + call context → ranked JSON results), proving the
 * agent-native parity: the live agent can search chat history the same way the
 * user can. Backed by a real chat-core search index via the store runtime.
 */

import { describe, expect, it } from 'bun:test'

import { InMemoryStore, type ChatMessage } from '@neutronai/chat-core'

import { ToolRegistry, type ToolCallContext } from '@neutronai/tools/registry.ts'

import { StoreMessageSearchRuntime } from './runtime.ts'
import { MESSAGE_SEARCH_TOOL, registerMessageSearchToolSurface } from './tool.ts'

function msg(p: Partial<ChatMessage> & { client_msg_id: string }): ChatMessage {
  return {
    topic_id: 'app:a',
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

function ctx(topic_id: string | null): ToolCallContext {
  return { project_slug: 'demo', project_id: null, topic_id, call_id: 'call-1', speaker_user_id: null }
}

async function registry(): Promise<ToolRegistry> {
  const store = new InMemoryStore()
  await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'm1', created_at: 1, body: 'we should deploy the gateway tonight' }))
  await store.upsert(msg({ topic_id: 'app:a', client_msg_id: 'm2', created_at: 2, body: 'remember to water the plants' }))
  await store.upsert(msg({ topic_id: 'app:b', client_msg_id: 'm3', created_at: 3, body: 'gateway notes from the other chat' }))
  const reg = new ToolRegistry()
  registerMessageSearchToolSurface(reg, new StoreMessageSearchRuntime(store))
  return reg
}

describe('message_search tool', () => {
  it('registers with the right name, capability, and auto-approval', async () => {
    const reg = await registry()
    const t = reg.get(MESSAGE_SEARCH_TOOL)
    expect(t).toBeDefined()
    expect(t?.capability_required).toBe('read:project_data')
    expect(t?.approval_policy).toBe('auto')
  })

  it('searches the CURRENT conversation by default (scoped to ctx.topic_id)', async () => {
    const reg = await registry()
    const out = (await reg.get(MESSAGE_SEARCH_TOOL)!.handler({ query: 'gateway' }, ctx('app:a'))) as {
      results: Array<{ id: string; snippet: string; role: string }>
    }
    expect(out.results.map((r) => r.id)).toEqual(['m1']) // not m3 (other topic)
    expect(out.results[0]?.snippet).toContain('[gateway]')
    expect(out.results[0]?.role).toBe('user')
  })

  it('searches every conversation when global=true', async () => {
    const reg = await registry()
    const out = (await reg.get(MESSAGE_SEARCH_TOOL)!.handler({ query: 'gateway', global: true }, ctx('app:a'))) as {
      results: Array<{ id: string }>
    }
    expect(out.results.map((r) => r.id).sort()).toEqual(['m1', 'm3'])
  })

  it('honours an explicit limit', async () => {
    const reg = await registry()
    const out = (await reg.get(MESSAGE_SEARCH_TOOL)!.handler({ query: 'gateway', global: true, limit: 1 }, ctx('app:a'))) as {
      results: unknown[]
    }
    expect(out.results.length).toBe(1)
  })

  it('returns empty results for a blank query rather than throwing', async () => {
    const reg = await registry()
    const out = (await reg.get(MESSAGE_SEARCH_TOOL)!.handler({ query: '   ' }, ctx('app:a'))) as {
      results: unknown[]
    }
    expect(out.results).toEqual([])
  })

  it('searches across topics when the call has no originating topic (system call)', async () => {
    const reg = await registry()
    // No topic + not global → the store runtime sees no topic scope and would
    // search globally; but the handler only sets a scope when ctx.topic_id is
    // present, so a system call with null topic searches across topics.
    const out = (await reg.get(MESSAGE_SEARCH_TOOL)!.handler({ query: 'gateway' }, ctx(null))) as {
      results: Array<{ id: string }>
    }
    expect(out.results.map((r) => r.id).sort()).toEqual(['m1', 'm3'])
  })
})
