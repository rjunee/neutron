/**
 * Argus r3 fast-follower fixes (2026-05-30) — two Codex P2 findings in
 * pre-existing in-place-switch code (commit eb5fa0e from r1) on the
 * cookie-only navigation surface r3 just made work end-to-end.
 *
 *   P2 #1: switchTopic to General must work for cookie-only users
 *          (no `?start=` JWT on the client). The server pushes
 *          `session_ready{user_id}` over the WS right after the
 *          session is marked live; the client uses it to derive
 *          `web:<user_id>` for the General row.
 *
 *   P2 #2: handleTopicSwitched must drop acks whose `topic_id` does
 *          NOT match the most-recently-requested destination, so a
 *          rapid double-click (A → B → A) cannot resolve A's resolver
 *          with B's ack and render the wrong topic into the cleared
 *          log. Stale acks are logged + dropped; the in-flight
 *          switch's 3 s timeout remains armed.
 *
 * Coverage (per Argus r3 verdict's "Tests" rubric, brief 2026-05-30):
 *   1. Cookie-only user (empty start_token) → server pushes
 *      `session_ready{user_id:'u-cookie'}` → switchTopic(null) for
 *      General → assert ONE `topic_switch` frame sent over the WS
 *      (no early-return, no silent fail) → ack lands → hydrate fires.
 *   2. Cookie-only user WITHOUT a session_ready envelope (pre-r3
 *      server) → switchTopic(null) still falls back to the JWT-decode
 *      path — empty token → null sub → early-return preserved
 *      (pre-r3 behaviour intact for back-compat).
 *   3. Rapid double-switch (Project A → Project B) — only B's
 *      destination resolves. The first ack arrives for A (FIFO over
 *      the WS) and MUST be dropped as stale. switchTopic(B)'s
 *      hydrate must fire for B, not for A.
 *   4. Single switch (no rapid double) — ack with matching topic_id
 *      resolves cleanly (the new mismatch guard MUST NOT break the
 *      happy path).
 *   5. Token-auth path: server-pushed session_ready takes precedence
 *      over the JWT decode (uniformity — server is the source of
 *      truth even when the JWT is present).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

interface FakeWebSocket {
  readyState: number
  addEventListener(type: string, fn: (ev?: unknown) => void): void
  send(data: string): void
  close(): void
  fireOpen(): void
  fireMessage(data: unknown): void
  sentFrames: string[]
}

let activeSockets: FakeWebSocket[] = []
let mod: typeof import('../chat.ts')

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSED = 3
    private readonly listeners: Record<string, ((ev?: unknown) => void)[]> = {
      open: [],
      message: [],
      close: [],
      error: [],
    }
    constructor() {
      const fake: FakeWebSocket = {
        readyState: 0,
        sentFrames: [],
        addEventListener: (type, fn): void => {
          this.listeners[type]?.push(fn)
        },
        send: (data: string): void => {
          fake.sentFrames.push(data)
        },
        close: (): void => {
          fake.readyState = 3
        },
        fireOpen: (): void => {
          fake.readyState = 1
          for (const fn of this.listeners['open'] ?? []) fn({})
        },
        fireMessage: (data): void => {
          for (const fn of this.listeners['message'] ?? []) {
            fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })
          }
        },
      }
      activeSockets.push(fake)
      Object.defineProperty(this, 'readyState', {
        get: () => fake.readyState,
        configurable: true,
      })
      ;(this as unknown as Record<string, unknown>).addEventListener = fake.addEventListener
      ;(this as unknown as Record<string, unknown>).send = fake.send
      ;(this as unknown as Record<string, unknown>).close = fake.close
    }
  }
  Object.defineProperty(window.location, 'replace', {
    value: () => {},
    writable: true,
    configurable: true,
  })
  mod = await import('../chat.ts')
})

let fetchHistoryCalls: string[]
function installFetchStub(): void {
  fetchHistoryCalls = []
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    fetchHistoryCalls.push(url)
    return new Response(
      JSON.stringify({
        ok: true,
        turns: [],
        has_more: false,
        oldest_returned_at: null,
        oldest_returned_prompt_id: null,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

interface Harness {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
  socket: FakeWebSocket
}

function mountHarness(opts: {
  initialTopic?: string | null
  startToken?: string
}): Harness {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap">
      <div id="log"></div>
      <button id="new-pill" hidden></button>
    </div>
    <footer>
      <textarea id="input"></textarea>
      <button id="send"></button>
    </footer>
  `
  const log = document.getElementById('log') as HTMLElement
  Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(log, 'clientHeight', { value: 600, configurable: true })
  let scrollTopBacking = 0
  Object.defineProperty(log, 'scrollTop', {
    get: () => scrollTopBacking,
    set: (v: number) => {
      scrollTopBacking = v
    },
    configurable: true,
  })
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  activeSockets = []
  installFetchStub()
  const clientOpts: import('../chat.ts').ChatClientOptions = {
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: opts.startToken ?? '',
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-05-30T00:00:00Z'),
  }
  if (opts.initialTopic !== null && opts.initialTopic !== undefined) {
    clientOpts.topic_id = opts.initialTopic
  }
  const client = new mod.ChatClient(clientOpts)
  client.connect()
  expect(activeSockets.length).toBe(1)
  const socket = activeSockets[0]!
  socket.fireOpen()
  return { client, log, socket }
}

function makeSyntheticToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `${header}.${payload}.`
}

function sentTopicSwitches(socket: FakeWebSocket): Array<{ new_topic_id: string }> {
  return socket.sentFrames
    .map((f) => {
      try {
        return JSON.parse(f) as { type?: string; new_topic_id?: string }
      } catch {
        return null
      }
    })
    .filter((m): m is { type: string; new_topic_id: string } =>
      m !== null && m.type === 'topic_switch' && typeof m.new_topic_id === 'string',
    )
    .map((m) => ({ new_topic_id: m.new_topic_id }))
}

beforeEach(() => {
  try {
    localStorage.removeItem(mod.ACTIVE_TOPIC_LS_KEY)
  } catch {
    // ignore
  }
})

describe('Argus r3 P2 #1 fix — switchTopic to General works for cookie-only users', () => {
  test('cookie-only user (empty start_token) + session_ready{user_id} → switchTopic(null) sends ONE topic_switch + hydrate fires', async () => {
    // Cookie-only session: start_token is empty (the WS upgrade authed
    // via the session cookie; no `?start=` on the URL).
    const h = mountHarness({ startToken: '', initialTopic: 'web:u-cookie:my-project' })
    // Server pushes session_ready first thing on session open.
    h.socket.fireMessage({ type: 'session_ready', user_id: 'u-cookie' })
    // User clicks the General row → switchTopic(null).
    const switchPromise = h.client.switchTopic(null)
    // Let the synchronous setup run.
    await new Promise<void>((r) => setTimeout(r, 0))
    const sent = sentTopicSwitches(h.socket)
    expect(sent.length).toBe(1)
    // Must resolve to General — `web:<user_id>`.
    expect(sent[0]!.new_topic_id).toBe('web:u-cookie')
    // Server acks; hydrate proceeds.
    const sentBeforeAck = fetchHistoryCalls.length
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-cookie' })
    await switchPromise
    expect(fetchHistoryCalls.length).toBeGreaterThan(sentBeforeAck)
    // LocalStorage cleared (General is the null sentinel).
    expect(localStorage.getItem(mod.ACTIVE_TOPIC_LS_KEY)).toBeNull()
  })

  test('cookie-only user WITHOUT session_ready (pre-r3 server) → switchTopic(null) early-returns; no topic_switch sent (back-compat)', async () => {
    // No session_ready fired → fallback JWT decode runs against empty
    // start_token → null sub → early-return path PRESERVED for
    // back-compat. The bug exists in the pre-fix world; this test
    // pins that the new fallback chain doesn't accidentally invent a
    // General topic id when neither source can resolve user_id.
    const h = mountHarness({ startToken: '', initialTopic: 'web:u-cookie:my-project' })
    await h.client.switchTopic(null)
    expect(sentTopicSwitches(h.socket).length).toBe(0)
  })

  test('token-auth user: server-pushed session_ready takes precedence over JWT decode', async () => {
    // Both signals available; the server-pushed value wins. Pin this
    // so a future refactor can't silently un-prefer the trusted
    // source.
    const h = mountHarness({ startToken: makeSyntheticToken('u-jwt'), initialTopic: 'web:u-jwt:proj-a' })
    h.socket.fireMessage({ type: 'session_ready', user_id: 'u-server' })
    const switchPromise = h.client.switchTopic(null)
    await new Promise<void>((r) => setTimeout(r, 0))
    const sent = sentTopicSwitches(h.socket)
    expect(sent.length).toBe(1)
    // The server's u-server, NOT the JWT's u-jwt.
    expect(sent[0]!.new_topic_id).toBe('web:u-server')
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-server' })
    await switchPromise
  })

  test('token-auth user: session_ready never arrives → switchTopic(null) falls back to JWT decode', async () => {
    // Belt-and-braces fallback: if the envelope is lost mid-flight,
    // the JWT decode keeps the General switch working for any token
    // session.
    const h = mountHarness({ startToken: makeSyntheticToken('u-jwt'), initialTopic: 'web:u-jwt:proj-a' })
    const switchPromise = h.client.switchTopic(null)
    await new Promise<void>((r) => setTimeout(r, 0))
    const sent = sentTopicSwitches(h.socket)
    expect(sent.length).toBe(1)
    expect(sent[0]!.new_topic_id).toBe('web:u-jwt')
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-jwt' })
    await switchPromise
  })
})

describe('Argus r3 P2 #2 fix — handleTopicSwitched validates destination', () => {
  test('rapid double-switch A → B: B\'s ack (sent after A\'s, FIFO) resolves the in-flight switch; A\'s ack is dropped as stale', async () => {
    // Mirror the brief's Codex finding: with the destination guard,
    // a STALE ack (wrong topic_id) MUST NOT resolve the pending
    // resolver. Only the matching ack resolves.
    const h = mountHarness({ startToken: makeSyntheticToken('u-1'), initialTopic: null })
    h.socket.fireMessage({ type: 'session_ready', user_id: 'u-1' })
    // First switch: General → A. We don't await — the await is paused
    // on the topic_switched ack we haven't sent yet.
    const aPromise = h.client.switchTopic('web:u-1:a')
    await new Promise<void>((r) => setTimeout(r, 0))
    // Second switch (overlapping): A → B. Overwrites the pending
    // resolver + destination. aPromise's outer await is now orphaned
    // — that's the same pre-fix behaviour; the fix is narrowly
    // about not corrupting B's resolution.
    const bPromise = h.client.switchTopic('web:u-1:b')
    await new Promise<void>((r) => setTimeout(r, 0))
    // The most-recent destination is B.
    // Stale ack arrives first (server processed A first; FIFO over WS).
    const historyBefore = fetchHistoryCalls.length
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:a' })
    // Microtask flush — the stale ack must be a no-op, NOT resolve B.
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(fetchHistoryCalls.length).toBe(historyBefore)
    // Now the matching ack arrives.
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:b' })
    await bPromise
    // Exactly ONE hydrate ran after both acks (B's), not A's.
    expect(fetchHistoryCalls.length).toBe(historyBefore + 1)
    // The hydrate was for B.
    const lastFetch = fetchHistoryCalls[fetchHistoryCalls.length - 1] ?? ''
    expect(lastFetch).toContain('topic_id=web%3Au-1%3Ab')
    // aPromise is orphaned (pre-fix behaviour) — not relevant to this
    // test, but we silence the unhandled-rejection lint by binding it.
    void aPromise
  })

  test('happy-path single switch: ack with matching topic_id resolves cleanly (mismatch guard does NOT break normal flow)', async () => {
    const h = mountHarness({ startToken: makeSyntheticToken('u-1'), initialTopic: null })
    h.socket.fireMessage({ type: 'session_ready', user_id: 'u-1' })
    const switchPromise = h.client.switchTopic('web:u-1:topline')
    await new Promise<void>((r) => setTimeout(r, 0))
    const historyBefore = fetchHistoryCalls.length
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:topline' })
    await switchPromise
    expect(fetchHistoryCalls.length).toBeGreaterThan(historyBefore)
  })

  test('orphan stale ack with NO pending switch is dropped silently (handler still null-guards)', async () => {
    // Pin the existing null-resolver early-return — a stray ack with
    // no in-flight switch (e.g. late ack after a 3 s timeout already
    // resolved the prior switch) must not throw.
    const h = mountHarness({ startToken: makeSyntheticToken('u-1'), initialTopic: null })
    h.socket.fireMessage({ type: 'session_ready', user_id: 'u-1' })
    // No switch in flight.
    expect(() => h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:whatever' })).not.toThrow()
  })
})
