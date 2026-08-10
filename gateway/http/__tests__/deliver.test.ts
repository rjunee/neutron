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

  it('SAFELY drops every unrecognised topic grammar — unknown prefix, empty, no-prefix (no push, still persists)', async () => {
    const bs = fakeButtonStore()
    const p = recordingPush(bs.trace)
    const deliver = createDeliver({ buttonStore: bs.store, push: p.push, log: () => {} })

    for (const bad of ['xyz:owner', 'unknownprefix:1', '', 'owner', ':owner', 'app', 'web']) {
      const r = await deliver(bad, { body: 'z', durability: 'reply' })
      // No live sender for an unrecognised grammar → delivered_live false, never a throw.
      expect(r.delivered_live).toBe(false)
      // The durable row is still written (the guarantee holds regardless of grammar).
      expect(r.persisted).toBe(true)
    }
    // NOT ONE push fired across all the malformed/unknown topics.
    expect(p.app).toHaveLength(0)
    expect(p.web).toHaveLength(0)
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

// ── plan task 8 — options / idempotency / metadata threading on 'reply' ──────

describe("createDeliver — envelope options (task 8, 'reply' only)", () => {
  function optionCapturingButtonStore(): {
    store: ButtonStore
    prompts: Array<{ options: unknown; idempotency_key?: string; metadata?: unknown }>
  } {
    const prompts: Array<{ options: unknown; idempotency_key?: string; metadata?: unknown }> = []
    const store = {
      async emit(prompt: { options: unknown; idempotency_key?: string; metadata?: unknown }) {
        const rec: { options: unknown; idempotency_key?: string; metadata?: unknown } = {
          options: prompt.options,
        }
        if (prompt.idempotency_key !== undefined) rec.idempotency_key = prompt.idempotency_key
        if (prompt.metadata !== undefined) rec.metadata = prompt.metadata
        prompts.push(rec)
        return { prompt_id: 'reply-1', was_new: true }
      },
      async persistInertAgentTurn() {
        return { prompt_id: 'inert-1' }
      },
    } as unknown as ButtonStore
    return { store, prompts }
  }

  const OPTS = [
    { label: 'Approve', body: 'Approve this ritual', value: 'rap:AAAAAAAAAAAAAAAAAAAAAA:a' },
    { label: 'Deny', body: 'Deny this ritual', value: 'rap:AAAAAAAAAAAAAAAAAAAAAA:d' },
  ]

  it('threads options into the emitted prompt AND the push event; carries idempotency_key + metadata', async () => {
    const bs = optionCapturingButtonStore()
    const app: AgentMessageOut[] = []
    const deliver = createDeliver({
      buttonStore: bs.store,
      push: { app: (_t, e) => (app.push(e as AgentMessageOut), true) },
    })
    await deliver('app:owner', {
      body: 'Ritual approval needed',
      durability: 'reply',
      options: OPTS,
      idempotency_key: 'ritual-approval:abc',
      metadata: { kind: 'ritual-approval', ritual_id: 'daily-digest' },
    })
    // emitted prompt carries the options + idempotency + metadata
    expect(bs.prompts).toHaveLength(1)
    expect(bs.prompts[0]!.options).toEqual(OPTS)
    expect(bs.prompts[0]!.idempotency_key).toBe('ritual-approval:abc')
    expect(bs.prompts[0]!.metadata).toEqual({ kind: 'ritual-approval', ritual_id: 'daily-digest' })
    // the push event carries the SAME options
    expect(app).toHaveLength(1)
    expect(app[0]!.options).toEqual(OPTS)
  })

  it('omitting options is byte-identical to the legacy zero-option reply', async () => {
    const bs = optionCapturingButtonStore()
    const app: AgentMessageOut[] = []
    const deliver = createDeliver({
      buttonStore: bs.store,
      push: { app: (_t, e) => (app.push(e as AgentMessageOut), true) },
    })
    await deliver('app:owner', { body: 'plain reminder', durability: 'reply' })
    expect(bs.prompts[0]!.options).toEqual([])
    expect(bs.prompts[0]!.idempotency_key).toBeUndefined()
    expect(bs.prompts[0]!.metadata).toBeUndefined()
    expect(app[0]!.options).toEqual([])
  })

  it("ignores options on durability 'inert' (options ride 'reply' only)", async () => {
    const bs = optionCapturingButtonStore()
    const app: AgentMessageOut[] = []
    const deliver = createDeliver({
      buttonStore: bs.store,
      push: { app: (_t, e) => (app.push(e as AgentMessageOut), true) },
    })
    // inert path never builds a ButtonPrompt with options; assert no throw + no option leak
    const r = await deliver('app:owner', {
      body: 'brief',
      durability: 'inert',
      options: OPTS,
    })
    expect(r.persisted).toBe(true)
    expect(bs.prompts).toHaveLength(0) // inert path does not call emit()
  })
})

/**
 * THE NATIVE NOTIFICATION, owned by deliver (2026-08-09).
 *
 * The owner's report was `ritual:kaizen` on his lock screen. The first fix
 * composed the notification in the reminder OUTBOUND — which cured the reported
 * message and left the morning brief, the idle nudge and the overnight report
 * silent, because those post through this seam on a different sink. So the
 * notification lives here, and these are the properties that make "a ritual
 * posting is just a chat message" true of every producer rather than one:
 *
 *   - a durable post notifies, whatever wrote it;
 *   - a transient pill does not (no row, so a tap has nowhere to land);
 *   - the notification carries the POSTED body and the DURABLE row id;
 *   - a notification failure can never cost the delivery, because `persisted` is
 *     what the reminder tick reads to decide whether to fire the row AGAIN.
 */
describe('deliver notifies the owner devices for a durable post', () => {
  interface Notice {
    project_id: string | null
    message_id: string
    body: string
  }

  function recordingNotify(): { notify: (n: Notice) => Promise<void>; sent: Notice[] } {
    const sent: Notice[] = []
    return {
      notify: async (n): Promise<void> => {
        sent.push(n)
      },
      sent,
    }
  }

  it("a 'reply' post (a fired reminder / ritual) notifies with the posted body + row id", async () => {
    const { store } = fakeButtonStore()
    const n = recordingNotify()
    const deliver = createDeliver({ buttonStore: store, push: {}, notify: n.notify })

    await deliver('app:owner', {
      body: 'Kaizen review: two things landed, one is blocked on the importer.',
      durability: 'reply',
    })

    expect(n.sent).toHaveLength(1)
    expect(n.sent[0]!.body).toBe(
      'Kaizen review: two things landed, one is blocked on the importer.',
    )
    // `reply-1` is what the fake store returns as the durable id. The tap anchors
    // the transcript on it, so a notification carrying anything else would open
    // the right chat and land in the wrong place.
    expect(n.sent[0]!.message_id).toBe('reply-1')
    // MUTATION-SENSITIVE, and the whole point: the reminder row's dispatch token
    // must not be able to reach the owner. deliver is only ever handed the body
    // that was posted, so there is no path by which it could.
    expect(n.sent[0]!.body).not.toContain('ritual:')
  })

  it("an 'inert' post (the brief / the nudge / the overnight report) notifies too", async () => {
    // THE BLOCKER THIS FIXES. Those producers post through
    // `buildButtonStoreProactiveSink`, never through the reminder outbound, so a
    // notification wired to the reminder path left every one of them silent.
    const { store } = fakeButtonStore()
    const n = recordingNotify()
    const deliver = createDeliver({ buttonStore: store, push: {}, notify: n.notify })

    await deliver('app:owner', {
      body: 'Morning brief: three things today.',
      durability: 'inert',
    })

    expect(n.sent).toHaveLength(1)
    expect(n.sent[0]!.body).toBe('Morning brief: three things today.')
    expect(n.sent[0]!.message_id).toBe('inert-1')
  })

  it("a transient 'none' pill notifies NOBODY — there is no row to tap", async () => {
    const { store } = fakeButtonStore()
    const n = recordingNotify()
    const deliver = createDeliver({ buttonStore: store, push: {}, notify: n.notify })
    await deliver('app:owner', { body: 'reconnecting…', durability: 'none' })
    expect(n.sent).toEqual([])
  })

  it('a failed durable persist notifies nobody — the notification would point at no row', async () => {
    const { store } = fakeButtonStore({ throwOn: 'emit' })
    const n = recordingNotify()
    const deliver = createDeliver({ buttonStore: store, push: {}, notify: n.notify })
    const r = await deliver('app:owner', { body: 'take a break', durability: 'reply' })
    expect(r.persisted).toBe(false)
    expect(n.sent).toEqual([])
  })

  it('the bare owner topic is the General scope; a suffixed one names its project', async () => {
    const { store } = fakeButtonStore()
    const n = recordingNotify()
    const deliver = createDeliver({ buttonStore: store, push: {}, notify: n.notify })
    await deliver('app:owner', { body: 'a', durability: 'reply' })
    await deliver('app:owner:beacon', { body: 'b', durability: 'reply' })
    expect(n.sent.map((s) => s.project_id)).toEqual([null, 'beacon'])
  })

  it('A THROWING notify cannot cost the delivery — otherwise the reminder double-posts', async () => {
    // `persisted` is the reminder tick's signal to KEEP its claim on the row
    // (#319). If an Expo outage escaped as a throw here, the claim would revert
    // and the same message would be posted again on the next tick, forever.
    const { store } = fakeButtonStore()
    const deliver = createDeliver({
      buttonStore: store,
      push: {},
      notify: async () => {
        throw new Error('expo unreachable')
      },
    })
    const r = await deliver('app:owner', { body: 'take a break', durability: 'reply' })
    expect(r.persisted).toBe(true)
    expect(r.prompt_id).toBe('reply-1')
  })

  it('an IDEMPOTENT RE-EMIT of a message he already has does not buzz again', async () => {
    // `(topic_id, idempotency_key)` is unique, so a re-emit — a reconnect
    // re-render, a retried approval prompt — collapses onto the existing row.
    // Notifying again would buzz him about a message already in his chat.
    const sent: string[] = []
    const store = {
      async emit() {
        return { prompt_id: 'reply-1', was_new: false, was_delivered: true }
      },
      async persistInertAgentTurn() {
        return { prompt_id: 'inert-1' }
      },
    } as unknown as ButtonStore
    const deliver = createDeliver({
      buttonStore: store,
      push: {},
      notify: async (n) => {
        sent.push(n.message_id)
      },
    })
    const r = await deliver('app:owner', {
      body: 'approve the kaizen ritual?',
      durability: 'reply',
      idempotency_key: 'ritual-approval-kaizen',
    })
    // The DELIVERY still succeeded — only the notification is suppressed.
    expect(r.persisted).toBe(true)
    expect(r.prompt_id).toBe('reply-1')
    expect(sent).toEqual([])
  })

  it('a re-emit he NEVER SAW still buzzes — the ButtonStore contract exception', async () => {
    // `was_new: false` with `was_delivered: false` means the row landed in the DB
    // but never reached him (a transient send failure on the prior call). The
    // channel adapters re-render in that case; the notification must fire for the
    // same reason, or a prompt he has never seen stays silent forever.
    const sent: string[] = []
    const store = {
      async emit() {
        return { prompt_id: 'reply-1', was_new: false, was_delivered: false }
      },
      async persistInertAgentTurn() {
        return { prompt_id: 'inert-1' }
      },
    } as unknown as ButtonStore
    const deliver = createDeliver({
      buttonStore: store,
      push: {},
      notify: async (n) => {
        sent.push(n.message_id)
      },
    })
    await deliver('app:owner', {
      body: 'approve the kaizen ritual?',
      durability: 'reply',
      idempotency_key: 'ritual-approval-kaizen',
    })
    expect(sent).toEqual(['reply-1'])
  })

  it('no notify wired → delivery behaves exactly as it did before push existed', async () => {
    const { store, trace } = fakeButtonStore()
    const deliver = createDeliver({ buttonStore: store, push: {} })
    const r = await deliver('app:owner', { body: 'take a break', durability: 'reply' })
    expect(r).toEqual({ prompt_id: 'reply-1', persisted: true, delivered_live: false })
    expect(trace.emits).toEqual([{ topic_id: 'app:owner', body: 'take a break' }])
  })
})
