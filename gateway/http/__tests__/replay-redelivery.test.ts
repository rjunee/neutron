/**
 * replay-redelivery.test.ts — S3 §4 acceptance #4 (closes #106).
 *
 * When a warm REPL dies mid-turn, S2's pending-respawns queue replays the dropped
 * inbound after resume so conversation state advances — but the recovered reply
 * used to be discarded. S3 captures it and re-delivers it to the user:
 *   • online at replay time → deliver now via the WebChatSenderRegistry;
 *   • offline → persist a `delivered_at`-NULL row the EXISTING reconnect re-emit
 *     path drains, deduped on `turn_id`.
 *
 * This file proves both the gateway sink semantics (online/offline/reconnect/
 * dedupe) AND the full runtime→sink path: a real persistent substrate replay
 * invokes the injected `onRecoveredReply` sink with the recovered text + routing
 * handle (`topic_id` + `turn_id`).
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import type { AgentSpec } from '@neutronai/runtime/substrate.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { PtyChild, PtyHost } from '@neutronai/runtime/adapters/claude-code/persistent/pty-host.ts'
import {
  createPersistentReplSubstrate,
  drainPendingRespawns,
  getReplSinkInfo,
  registerSupervisedSubstrate,
  shutdownAllPersistentRepls,
  type PersistentReplSubstrateOptions,
  type RecoveredReply,
} from '@neutronai/runtime/adapters/claude-code/persistent/persistent-repl-substrate.ts'
import { loadPendingRespawns } from '@neutronai/runtime/adapters/claude-code/persistent/pending-respawns-queue.ts'
import { InMemoryWebChatSenderRegistry, webTopicId } from '../chat-bridge.ts'
import type { ChatOutbound } from '@neutronai/landing/server.ts'
import {
  InMemoryRecoveredReplyStore,
  makeRecoveredReplySink,
  drainRecoveredReplies,
  assertRecoveredReplyPersisted,
  type RecoveredReplyDelivery,
} from '../recovered-reply-store.ts'

afterEach(async () => {
  await shutdownAllPersistentRepls()
})

// ─── Part 1: the gateway sink semantics (deliver-or-persist, deduped) ─────────

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Deliver stub returning a fixed adapter result id (or throwing). */
const deliverReturning = (id: string | undefined) => (): RecoveredReplyDelivery => async () => id

describe('makeRecoveredReplySink — claim-first, real async delivery result', () => {
  it('a live-delivered reply stays claimed (delivered) — nothing left to drain', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-1')
    let clock = 1000
    const sent: ChatOutbound[] = []
    const sink = makeRecoveredReplySink({
      deliver: () => async (_t, e) => {
        sent.push(e)
        return 'app-ws:msg-1'
      },
      store,
      now: () => ++clock,
    })

    sink({ topic_id: topic, turn_id: 'abc:1', text: 'recovered answer' })
    await flush()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({ type: 'agent_message', body: 'recovered answer', topic_id: topic })
    // Delivered → claimed, nothing left to drain on reconnect.
    expect(store.peekUndelivered(topic)).toHaveLength(0)
  })

  it('a persisted-but-offline (dropped) reply counts delivered — resume shows it (nothing to drain)', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-2')
    const sink = makeRecoveredReplySink({ deliver: deliverReturning('app-ws:dropped:msg-1'), store, now: () => 1 })

    sink({ topic_id: topic, turn_id: 'def:1', text: 'answer for offline user' })
    await flush()

    // dropped == persisted to chat_log → delivered, not re-pending.
    expect(store.peekUndelivered(topic)).toHaveLength(0)
  })

  it('a LOST reply (captured nowhere) is RELEASED back to pending for the reconnect drain', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-3')
    const sink = makeRecoveredReplySink({ deliver: deliverReturning('app-ws:lost:msg-1'), store, now: () => 1 })

    sink({ topic_id: topic, turn_id: 'lost:1', text: 'must survive a double failure' })
    await flush()

    // Neither persisted nor delivered → pending, retried on the next reconnect.
    expect(store.peekUndelivered(topic)).toHaveLength(1)
  })

  it('no adapter bound (undefined) → released to pending', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-3b')
    const sink = makeRecoveredReplySink({ deliver: () => undefined, store, now: () => 1 })

    sink({ topic_id: topic, turn_id: 'unbound:1', text: 'no adapter yet' })
    await flush()

    expect(store.peekUndelivered(topic)).toHaveLength(1)
  })

  it('a delivery that THROWS → released to pending (not lost)', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-4')
    const sink = makeRecoveredReplySink({
      deliver: () => async () => {
        throw new Error('socket closed mid-send')
      },
      store,
      now: () => 1,
    })

    sink({ topic_id: topic, turn_id: 'thr:1', text: 'recovered despite throw' })
    await flush()

    expect(store.peekUndelivered(topic)).toHaveLength(1)
  })

  it('dedupes a duplicate replay on turn_id (the second sink call is a no-op)', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-5b')
    let sends = 0
    const sink = makeRecoveredReplySink({
      deliver: () => async () => {
        sends += 1
        return 'app-ws:msg-x'
      },
      store,
      now: () => 1,
    })

    sink({ topic_id: topic, turn_id: 'race:1', text: 'once' })
    await flush()
    sink({ topic_id: topic, turn_id: 'race:1', text: 'once' }) // seen → no-op
    await flush()

    expect(sends).toBe(1)
    expect(store.peekUndelivered(topic)).toHaveLength(0)
  })

  it('drain leaves a row PENDING when send throws, retried on the next reconnect — Codex r1 P2', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-5')
    let clock = 5000
    store.persistUndelivered({ topic_id: topic, turn_id: 'retry:1', text: 'must survive a failed drain', now: ++clock })

    // First reconnect: the send throws → the row must NOT be consumed.
    const failingEmitted = await drainRecoveredReplies({
      topic_id: topic,
      store,
      send: () => {
        throw new Error('socket died mid-drain')
      },
      now: () => ++clock,
      log_tag: '[test]',
    })
    expect(failingEmitted).toBe(0)
    expect(store.peekUndelivered(topic)).toHaveLength(1) // still pending

    // Second reconnect with a working socket: delivered exactly once.
    const sent: ChatOutbound[] = []
    const emitted = await drainRecoveredReplies({ topic_id: topic, store, send: (e) => void sent.push(e), now: () => ++clock })
    expect(emitted).toBe(1)
    expect((sent[0] as { body: string }).body).toContain('must survive a failed drain')
    expect(store.peekUndelivered(topic)).toHaveLength(0)
  })

  it('drain leaves a row PENDING when an ASYNC send REJECTS, retried on the next reconnect (the async loss path)', async () => {
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-6')
    let clock = 6000
    store.persistUndelivered({ topic_id: topic, turn_id: 'areject:1', text: 'must survive an async rejection', now: ++clock })

    // First reconnect: an ASYNC send that REJECTS. The row must NOT be consumed.
    const failing = await drainRecoveredReplies({
      topic_id: topic,
      store,
      send: async (): Promise<void> => {
        throw new Error('adapter.send rejected / dropped')
      },
      now: () => ++clock,
      log_tag: '[test]',
    })
    expect(failing).toBe(0)
    expect(store.peekUndelivered(topic)).toHaveLength(1) // still pending — NOT lost

    // Second reconnect with a working async send: delivered exactly once.
    const sent: ChatOutbound[] = []
    const ok = await drainRecoveredReplies({
      topic_id: topic,
      store,
      send: async (e): Promise<void> => {
        sent.push(e)
      },
      now: () => ++clock,
    })
    expect(ok).toBe(1)
    expect(store.peekUndelivered(topic)).toHaveLength(0)
    expect((sent[0] as { body: string }).body).toContain('must survive an async rejection')
  })

  it('two SIMULTANEOUS reconnect drains emit a row exactly ONCE (atomic claim)', async () => {
    // The claim-first design (takeUndelivered marks synchronously, before any await)
    // makes the second concurrent drain see nothing.
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-7')
    let clock = 7000
    store.persistUndelivered({ topic_id: topic, turn_id: 'conc:1', text: 'shown exactly once', now: ++clock })

    const sentA: ChatOutbound[] = []
    const sentB: ChatOutbound[] = []
    // Start BOTH drains before awaiting either — the synchronous claim in the first
    // invocation must prevent the second from re-emitting. Async sends keep them
    // genuinely overlapping.
    const drainA = drainRecoveredReplies({
      topic_id: topic,
      store,
      send: async (e): Promise<void> => {
        await Promise.resolve()
        sentA.push(e)
      },
      now: () => ++clock,
    })
    const drainB = drainRecoveredReplies({
      topic_id: topic,
      store,
      send: async (e): Promise<void> => {
        await Promise.resolve()
        sentB.push(e)
      },
      now: () => ++clock,
    })
    const [a, b] = await Promise.all([drainA, drainB])

    // Exactly one drain claimed + emitted the row; the other saw nothing.
    expect(a + b).toBe(1)
    expect(sentA.length + sentB.length).toBe(1)
    expect(store.peekUndelivered(topic)).toHaveLength(0) // delivered, not re-pending
  })

  // The app-ws adapter PERSISTS to chat_log BEFORE the live socket send, so a
  // `dropped` result is durably captured and must NOT be retried (a retry would
  // double-append the same reply). Only an unbound adapter persisted nothing.
  describe('assertRecoveredReplyPersisted — persisted-counts-as-delivered (Codex)', () => {
    it('a real message id counts as delivered (no throw → drain marks delivered)', () => {
      expect(() => assertRecoveredReplyPersisted('app-ws:app:owner:42')).not.toThrow()
    })

    it('an app-ws:dropped marker ALSO counts as delivered — persisted, resume shows it once (no double-append)', () => {
      // THE BUG this guards: socket closed AFTER chat_log.append but before the
      // live send → the adapter returns `dropped`. Retrying would append the reply
      // a SECOND time. Persisted == delivered, so the drain must NOT retry.
      expect(() => assertRecoveredReplyPersisted('app-ws:dropped:app:owner')).not.toThrow()
    })

    it('undefined (adapter unbound → nothing persisted) throws → the drain leaves the row pending', () => {
      expect(() => assertRecoveredReplyPersisted(undefined)).toThrow()
    })

    it('an app-ws:lost marker (append FAILED + offline → captured nowhere) throws → row stays pending', () => {
      // Codex combined-failure boundary: chat_log.append rejected AND no socket
      // received it, so the reply is neither persisted nor delivered — it MUST be
      // retried, not marked delivered.
      expect(() => assertRecoveredReplyPersisted('app-ws:lost:msg-1')).toThrow()
    })
  })

  it('drain retries when the adapter reports LOST (combined persist+delivery failure) — Codex', async () => {
    // End-to-end at the drain: a send whose adapter result is `lost` (append failed
    // AND socket offline) must leave the row pending, then deliver on a later
    // reconnect once persistence works.
    const store = new InMemoryRecoveredReplyStore()
    const topic = webTopicId('u-8')
    let clock = 8000
    store.persistUndelivered({ topic_id: topic, turn_id: 'lost:1', text: 'must not be lost on double failure', now: ++clock })

    // First reconnect: the adapter reported `lost` → the drain's send throws.
    const failing = await drainRecoveredReplies({
      topic_id: topic,
      store,
      send: (): void => {
        assertRecoveredReplyPersisted('app-ws:lost:msg-x')
      },
      now: () => ++clock,
      log_tag: '[test]',
    })
    expect(failing).toBe(0)
    expect(store.peekUndelivered(topic)).toHaveLength(1) // still pending — NOT lost

    // Second reconnect: persistence works (a real id) → delivered exactly once.
    const sent: ChatOutbound[] = []
    const ok = await drainRecoveredReplies({
      topic_id: topic,
      store,
      send: (e): void => {
        assertRecoveredReplyPersisted('app-ws:msg-y')
        sent.push(e)
      },
      now: () => ++clock,
    })
    expect(ok).toBe(1)
    expect(store.peekUndelivered(topic)).toHaveLength(0)
    expect((sent[0] as { body: string }).body).toContain('must not be lost on double failure')
  })
})

// ─── Part 2: the full runtime replay → injected sink path ─────────────────────

function tmpRegistry(): string {
  return join(mkdtempSync(join(tmpdir(), 'neutron-redeliv-')), 'repl-registry.json')
}
function pendingPathFor(registryPath: string): string {
  return join(dirname(registryPath), '.pending-respawns.json')
}

/** Crash-capable fake host (one-shot __DIE__): the first inbound carrying it
 *  crashes the REPL mid-turn; a replay of that same inbound then succeeds and
 *  echoes a reply (so the recovered text is observable). */
function makeCrashHost(): { host: PtyHost } {
  let dieArmed = true
  const host: PtyHost = {
    spawn(argv: string[]): PtyChild {
      const r = argv.indexOf('--resume')
      const s = argv.indexOf('--session-id')
      const sid = (r >= 0 ? argv[r + 1] : s >= 0 ? argv[s + 1] : undefined) as string
      const { port: sinkPort, token } = getReplSinkInfo()
      let hasExited = false
      let exitResolve: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((res) => {
        exitResolve = res
      })
      const post = (path: string, body: unknown): Promise<unknown> =>
        fetch(`http://127.0.0.1:${sinkPort}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sink-Token': token },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return Response.json({ ok: true })
          if (req.method === 'POST' && url.pathname === '/message') {
            const body = (await req.json()) as { text: string; turn_id?: string }
            if (body.text.includes('__DIE__') && dieArmed) {
              dieArmed = false
              setTimeout(() => {
                hasExited = true
                try {
                  server.stop(true)
                } catch {
                  /* ignore */
                }
                exitResolve(143)
              }, 5)
              return Response.json({ status: 'accepted' })
            }
            void post('/reply', { session_id: sid, text: `RECOVERED:${body.text}`, turn_id: body.turn_id })
            return Response.json({ status: 'delivered' })
          }
          return new Response('nf', { status: 404 })
        },
      })
      void post('/channel-ready', { session_id: sid, channel_port: server.port, pid: 271828 })
      void post('/channel-bound', { session_id: sid })
      return {
        pid: 271828,
        write() {},
        resize() {},
        kill() {
          if (hasExited) return
          hasExited = true
          try {
            server.stop(true)
          } catch {
            /* ignore */
          }
          exitResolve(143)
        },
        exited,
        hasExited: () => hasExited,
      }
    },
  }
  return { host }
}

function spec(prompt: string): AgentSpec {
  return { prompt, tools: [], model_preference: ['claude-opus-4-7'] }
}
async function drain(handle: SessionHandle): Promise<Event[]> {
  const events: Event[] = []
  try {
    for await (const ev of handle.events as AsyncIterable<Event>) {
      events.push(ev)
      if (ev.kind === 'completion' || ev.kind === 'error') return events
    }
  } catch {
    /* iterator ended */
  }
  return events
}
async function waitForQueueEntry(path: string, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const loaded = loadPendingRespawns(path)
    if (loaded.kind === 'loaded' && loaded.entries.length > 0) return true
    await Bun.sleep(15)
  }
  return false
}

describe('runtime replay invokes the injected onRecoveredReply sink (#106 end-to-end)', () => {
  it('a crash-dropped reply is captured on replay and re-delivered to the user', async () => {
    const { host } = makeCrashHost()
    const registryPath = tmpRegistry()
    const pendingRespawnsPath = pendingPathFor(registryPath)
    const cwd = mkdtempSync(join(tmpdir(), 'neutron-redeliv-cwd-'))
    const topic = webTopicId('owner-1')

    // Wire the REAL gateway sink as the injected redelivery sink. The user is
    // OFFLINE at replay time → no live adapter delivery (deliver resolves undefined),
    // so the sink persists the row for the reconnect drain (asserted below).
    const registry = new InMemoryWebChatSenderRegistry()
    const store = new InMemoryRecoveredReplyStore()
    let clock = 5000
    const sink = makeRecoveredReplySink({ deliver: () => undefined, store, now: () => ++clock })
    const recovered: RecoveredReply[] = []

    const opts: PersistentReplSubstrateOptions = {
      substrate_instance_id: 'cc-llm-owner1',
      user_id: 'owner-1',
      project_id: 'default',
      credential_identity: 'cred-1',
      cwd,
      ptyHost: host,
      skipTrustSeed: true,
      idleQuietMs: 0,
      captureConfig: { maxAttempts: 1, attemptDelayMs: 1 },
      assertConfig: { readyBudgetMs: 5000, readyIntervalMs: 25, healthBudgetMs: 5000, healthIntervalMs: 25 },
      replRegistryPath: registryPath,
      pendingRespawnsPath,
      jsonlExistsProbe: () => true,
      delivery_topic_id: topic,
      instance_slug: 'owner1',
      onRecoveredReply: (r) => {
        recovered.push(r)
        sink(r)
      },
    }
    registerSupervisedSubstrate(opts)
    const sub = createPersistentReplSubstrate(opts)

    // Turn 1: seed (becomes resumable).
    await drain(sub.start(spec('seed')))

    // Turn 2: crash mid-turn — the inbound is dropped + enqueued WITH the
    // redelivery routing (topic_id + turn_id).
    const dropped = 'tell me a joke __DIE__'
    await drain(sub.start(spec(dropped)))
    expect(await waitForQueueEntry(pendingRespawnsPath)).toBe(true)
    const queued = loadPendingRespawns(pendingRespawnsPath)
    expect(queued.kind).toBe('loaded')
    if (queued.kind === 'loaded') {
      const entry = queued.entries[0]
      expect(entry?.droppedInbound).toBe(dropped)
      expect(entry?.topic_id).toBe(topic)
      expect(typeof entry?.turn_id).toBe('string')
      expect(entry?.turn_id?.length ?? 0).toBeGreaterThan(0)
    }

    // The user is OFFLINE at replay time (no sender registered).
    expect(registry.has(topic)).toBe(false)

    // Drain (watchdog tick / boot): replays + captures + hands to the sink.
    const results = await drainPendingRespawns(opts, { baseDelayMs: 0, sleep: async () => {} })
    expect(results.some((r) => r.replayed)).toBe(true)

    // The recovered reply reached the injected sink with the routing handle.
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.topic_id).toBe(topic)
    expect(recovered[0]?.text).toContain('RECOVERED:')

    // Offline → persisted as undelivered. Now the user reconnects → drained once.
    const sent: ChatOutbound[] = []
    const emitted = await drainRecoveredReplies({ topic_id: topic, store, send: (e) => void sent.push(e), now: () => ++clock })
    expect(emitted).toBe(1)
    expect((sent[0] as { type: string; body: string }).body).toContain('RECOVERED:')

    // Idempotency: a second reconnect drains nothing.
    const sent2: ChatOutbound[] = []
    await drainRecoveredReplies({ topic_id: topic, store, send: (e) => void sent2.push(e), now: () => ++clock })
    expect(sent2).toHaveLength(0)
  })
})
