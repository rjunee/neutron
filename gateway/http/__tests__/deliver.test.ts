/**
 * F5 — the ONE out-of-turn delivery seam. `deliver(topic, envelope)` folds the
 * reminder / proactive / notice producers onto one path so none can pick the
 * wrong registry. This suite pins:
 *   - durable-row-first ORDERING (persist before the best-effort push);
 *   - the durability modes (`reply` → emit, `inert` → inert turn, `none` → a
 *     synchronous live-only system_notice pill with no durable row);
 *   - GRAMMAR ROUTING via parseAnyTopicId (`app:` → the app registry, `web:` →
 *     the web registry, `tg:` / unrecognised → dropped, no push);
 *   - per-mode persist-fail policy (`reply` swallows → not-delivered; `inert`
 *     surfaces the throw for retry);
 *   - best-effort push (a throwing sender never surfaces out of `deliver`);
 *   - the two registries' LOAD-BEARING failure semantics are UNCHANGED — deliver
 *     only PICKS which one: the app-ws session registry evicts a throwing sender
 *     and CONTINUES the fan-out; the web registry propagates (deliver swallows).
 */

import { describe, expect, it } from 'bun:test'

import type { ButtonStore } from '@neutronai/channels/button-store.ts'
import type { ChatOutbound } from '@neutronai/landing/chat-protocol.ts'
import type { AppWsOutbound } from '@neutronai/channels/adapters/app-ws/envelope.ts'
import { InMemoryAppWsSessionRegistry } from '@neutronai/channels/adapters/app-ws/session-registry.ts'
import { InMemoryWebChatSenderRegistry } from '../chat-sender-registry.ts'
import { createDeliver, type DeliverPushTargets } from '../deliver.ts'

type AgentMessageOut = Extract<ChatOutbound, { type: 'agent_message' }>

interface Trace {
  order: string[]
  emits: Array<{ topic_id: string; body: string }>
  inerts: Array<{ topic_id: string; body: string }>
}

function fakeButtonStore(over: { throwOn?: 'emit' | 'inert' } = {}): {
  store: ButtonStore
  trace: Trace
} {
  const trace: Trace = { order: [], emits: [], inerts: [] }
  const store = {
    async emit(prompt: { body: string }, opts: { topic_id: string }) {
      if (over.throwOn === 'emit') throw new Error('db locked')
      trace.order.push('persist')
      trace.emits.push({ topic_id: opts.topic_id, body: prompt.body })
      return { prompt_id: 'reply-1', was_new: true }
    },
    async persistInertAgentTurn(input: { topic_id: string; body: string }) {
      if (over.throwOn === 'inert') throw new Error('db locked')
      trace.order.push('persist')
      trace.inerts.push({ topic_id: input.topic_id, body: input.body })
      return { prompt_id: 'inert-1' }
    },
  } as unknown as ButtonStore
  return { store, trace }
}

/** Recording app + web push targets that also log call order into `trace`. */
function recordingPush(trace: Trace): {
  push: DeliverPushTargets
  app: AgentMessageOut[]
  web: AgentMessageOut[]
} {
  const app: AgentMessageOut[] = []
  const web: AgentMessageOut[] = []
  return {
    app,
    web,
    push: {
      app: (_t, e) => {
        trace.order.push('push')
        app.push(e as AgentMessageOut)
        return true
      },
      web: (_t, e) => {
        web.push(e as AgentMessageOut)
        return true
      },
    },
  }
}

describe('createDeliver — durable-first + routed best-effort push', () => {
  it("durability 'reply' persists an emit row THEN pushes the app frame (with prompt_id)", async () => {
    const bs = fakeButtonStore()
    const p = recordingPush(bs.trace)
    const deliver = createDeliver({ buttonStore: bs.store, push: p.push })

    const r = await deliver('app:owner', { body: 'reminder!', durability: 'reply' })

    expect(r).toEqual({ prompt_id: 'reply-1', persisted: true, delivered_live: true })
    // Durable-row-first: persist strictly before push.
    expect(bs.trace.order).toEqual(['persist', 'push'])
    expect(bs.trace.emits).toEqual([{ topic_id: 'app:owner', body: 'reminder!' }])
    // Live frame carries the durable prompt_id + reply affordance.
    expect(p.app).toEqual([
      {
        type: 'agent_message',
        body: 'reminder!',
        topic_id: 'app:owner',
        options: [],
        allow_freeform: true,
        prompt_id: 'reply-1',
      },
    ])
  })

  it("durability 'inert' persists an inert turn THEN pushes", async () => {
    const bs = fakeButtonStore()
    const p = recordingPush(bs.trace)
    const deliver = createDeliver({ buttonStore: bs.store, push: p.push })

    const r = await deliver('app:owner', { body: 'brief', durability: 'inert' })

    expect(r.prompt_id).toBe('inert-1')
    expect(bs.trace.order).toEqual(['persist', 'push'])
    expect(bs.trace.inerts).toEqual([{ topic_id: 'app:owner', body: 'brief' }])
    expect(p.app[0]!.prompt_id).toBe('inert-1')
  })

  it("durability 'none' skips the durable row and pushes a live-only system_notice pill SYNCHRONOUSLY", async () => {
    const bs = fakeButtonStore()
    const p = recordingPush(bs.trace)
    const deliver = createDeliver({ buttonStore: bs.store, push: p.push })

    // Do NOT await — the 'none' push must run synchronously (no await before it)
    // so a sync caller (the substrate notice tick) observes delivery this tick.
    const pending = deliver('app:owner', { body: '⏳ rate-limited', durability: 'none' })
    expect(p.app.length).toBe(1)

    const r = await pending
    expect(r).toEqual({ prompt_id: null, persisted: true, delivered_live: true })
    expect(bs.trace.emits).toEqual([])
    expect(bs.trace.inerts).toEqual([])
    expect(p.app[0]).toEqual({
      type: 'agent_message',
      body: '⏳ rate-limited',
      topic_id: 'app:owner',
      system_notice: true,
    })
  })

  it('routes by topic grammar: web: → web push; tg:/unrecognised → dropped (no push, no throw)', async () => {
    const bs = fakeButtonStore()
    const p = recordingPush(bs.trace)
    const deliver = createDeliver({ buttonStore: bs.store, push: p.push })

    const web = await deliver('web:owner', { body: 'x', durability: 'reply' })
    expect(web.delivered_live).toBe(true)
    expect(p.web).toHaveLength(1)
    expect(p.app).toHaveLength(0)

    const tg = await deliver('tg:12345', { body: 'y', durability: 'reply' })
    // Persisted (durable row still written), but no live push target for tg.
    expect(tg.persisted).toBe(true)
    expect(tg.delivered_live).toBe(false)
    expect(p.app).toHaveLength(0)
    expect(p.web).toHaveLength(1)
  })

  it("'reply' persist failure SWALLOWS → not-delivered, no push", async () => {
    const bs = fakeButtonStore({ throwOn: 'emit' })
    const p = recordingPush(bs.trace)
    const deliver = createDeliver({ buttonStore: bs.store, push: p.push, log: () => {} })

    const r = await deliver('app:owner', { body: 'x', durability: 'reply' })
    expect(r).toEqual({ prompt_id: null, persisted: false, delivered_live: false })
    expect(p.app).toHaveLength(0)
  })

  it("'inert' persist failure SURFACES the throw (so the brief/nudge retries)", async () => {
    const bs = fakeButtonStore({ throwOn: 'inert' })
    const p = recordingPush(bs.trace)
    const deliver = createDeliver({ buttonStore: bs.store, push: p.push, log: () => {} })

    await expect(deliver('app:owner', { body: 'x', durability: 'inert' })).rejects.toThrow('db locked')
    expect(p.app).toHaveLength(0)
  })

  it('a throwing push never surfaces out of deliver (best-effort); the durable row is the guarantee', async () => {
    const bs = fakeButtonStore()
    const deliver = createDeliver({
      buttonStore: bs.store,
      push: {
        app: () => {
          throw new Error('socket closed')
        },
      },
      log: () => {},
    })
    const r = await deliver('app:owner', { body: 'x', durability: 'reply' })
    expect(r).toEqual({ prompt_id: 'reply-1', persisted: true, delivered_live: false })
    expect(bs.trace.emits).toHaveLength(1)
  })

  it('PRESERVES app-ws evict-and-continue: a throwing device is evicted but the fan-out still delivers', async () => {
    const bs = fakeButtonStore()
    const appRegistry = new InMemoryAppWsSessionRegistry()
    const live: AppWsOutbound[] = []
    const dead = (): void => {
      throw new Error('closed ws')
    }
    appRegistry.register('app:owner', dead)
    appRegistry.register('app:owner', (e) => live.push(e))

    const deliver = createDeliver({
      buttonStore: bs.store,
      push: { app: (t, e) => appRegistry.send(t, e as unknown as AppWsOutbound) },
      log: () => {},
    })
    const r = await deliver('app:owner', { body: 'hi', durability: 'reply' })

    // The dead device was evicted, the live one still received the frame — the
    // registry's fan-out semantics are unchanged by routing through deliver.
    expect(r.delivered_live).toBe(true)
    expect(live).toHaveLength(1)
    expect(appRegistry.deviceCount('app:owner')).toBe(1)
  })

  it('production app path (ASYNC): delivered_live is the REAL awaited fan-out result — offline→false, connected→true', async () => {
    // The composer's app push AWAITS the app-ws adapter and classifies its real
    // result marker — NOT a hardcoded true, NOT a stale pre-send registry snapshot.
    // This mirrors that: an async push returning the TRUE registry.send() result
    // (which evicts a throwing socket and reports actual delivery). An OFFLINE topic
    // was previously reported delivered_live:true (Codex P1).
    const bs = fakeButtonStore()
    const appRegistry = new InMemoryAppWsSessionRegistry()
    const deliver = createDeliver({
      buttonStore: bs.store,
      push: { app: async (t, e) => appRegistry.send(t, e as unknown as AppWsOutbound) },
      log: () => {},
    })
    // OFFLINE — no device connected → delivered_live false; durable row still written.
    const offline = await deliver('app:owner', { body: 'hi', durability: 'reply' })
    expect(offline.delivered_live).toBe(false)
    expect(offline.persisted).toBe(true)
    // CONNECTED — a device receives it → delivered_live true.
    const seen: AppWsOutbound[] = []
    appRegistry.register('app:owner', (e) => seen.push(e))
    const online = await deliver('app:owner', { body: 'hi', durability: 'reply' })
    expect(online.delivered_live).toBe(true)
    expect(seen).toHaveLength(1)
    // A registered-but-DEAD socket (throws) is evicted and reports NOT delivered.
    const bs2 = fakeButtonStore()
    const reg2 = new InMemoryAppWsSessionRegistry()
    reg2.register('app:owner', () => {
      throw new Error('closed ws')
    })
    const deliver2 = createDeliver({
      buttonStore: bs2.store,
      push: { app: async (t, e) => reg2.send(t, e as unknown as AppWsOutbound) },
      log: () => {},
    })
    const dead = await deliver2('app:owner', { body: 'hi', durability: 'reply' })
    expect(dead.delivered_live).toBe(false) // evicted throwing sender → not delivered
  })

  it('PRESERVES web-registry propagate: a throwing single sender is swallowed by deliver (best-effort)', async () => {
    const bs = fakeButtonStore()
    const webRegistry = new InMemoryWebChatSenderRegistry()
    webRegistry.register('web:owner', () => {
      // The web registry propagates this throw OUT of send (T10 semantic,
      // unchanged); deliver's best-effort push catches it for out-of-turn posts.
      throw new Error('closed ws')
    })
    const deliver = createDeliver({
      buttonStore: bs.store,
      push: { web: (t, e) => webRegistry.send(t, e) },
      log: () => {},
    })
    const r = await deliver('web:owner', { body: 'hi', durability: 'reply' })
    expect(r).toEqual({ prompt_id: 'reply-1', persisted: true, delivered_live: false })
  })
})
