/**
 * In-place topic switch (2026-05-29 sprint) — TopicRail click handler
 * MUST call `chatClient.switchTopic(...)` over the existing WS instead
 * of triggering a page reload.
 *
 * Coverage (per the sprint brief — § Tests, file 2):
 *   1. Click a non-active row → chatClient.switchTopic called; NO
 *      window.location.reload invoked.
 *   2. switchTopic clears `#log` + sends the topic_switch event (single
 *      send call asserted via the FakeWebSocket; WS readyState stays
 *      OPEN -- no reconnect).
 *   3. WS state persists across switch (readyState === OPEN).
 *   4. Active topic row updates aria-current="page" without DOM
 *      teardown -- the row element identity survives the click (no
 *      full re-render).
 *   5. localStorage.neutron.active_topic_id updated on switch.
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
      // The chat client looks at this.readyState; mirror the fake's
      // mutable readyState via a getter.
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

function installFetchStub(): void {
  // Default to a happy empty-history response so hydrate doesn't 404.
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    return new Response(
      JSON.stringify({ ok: true, turns: [], has_more: false, oldest_returned_at: null, oldest_returned_prompt_id: null }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

interface Harness {
  client: import('../chat.ts').ChatClient
  rail: import('../chat.ts').TopicRail
  list: HTMLElement
  log: HTMLElement
  socket: FakeWebSocket
  navigations: string[]
}

// A JWT with `sub:"u-1"` so `decodeJwtSubClaim` resolves the General
// topic for this synthetic user. The signature is meaningless to the
// client (signature verification happens server-side).
function makeSyntheticToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `${header}.${payload}.`
}

function mountHarness(initialTopic: string | null = null): Harness {
  document.body.innerHTML = `
    <aside id="topic-rail" aria-label="Chat topics">
      <nav class="rail-list" id="rail-list"></nav>
    </aside>
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
  Object.defineProperty(log, 'scrollTop', { value: 0, writable: true, configurable: true })
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  activeSockets = []
  installFetchStub()
  const opts: import('../chat.ts').ChatClientOptions = {
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: makeSyntheticToken('u-1'),
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-05-29T12:00:00Z'),
  }
  if (initialTopic !== null) opts.topic_id = initialTopic
  const client = new mod.ChatClient(opts)
  client.connect()
  expect(activeSockets.length).toBe(1)
  const socket = activeSockets[0]!
  socket.fireOpen()
  const navigations: string[] = []
  const list = document.getElementById('rail-list') as HTMLElement
  const rail = new mod.TopicRail({
    rail: document.getElementById('topic-rail') as HTMLElement,
    list,
    activeTopicId: initialTopic,
    chatClient: client,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: true, topics: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    reload: (target) => navigations.push(target),
  })
  return { client, rail, list, log, socket, navigations }
}

beforeEach(() => {
  // Reset localStorage so the active-topic key doesn't leak across tests.
  try {
    localStorage.removeItem(mod.ACTIVE_TOPIC_LS_KEY)
  } catch {
    // ignore
  }
})

describe('In-place topic switch (2026-05-29 sprint)', () => {
  test('1. Click a non-active project row -> switchTopic called; NO page navigation', async () => {
    const h = mountHarness(null)
    h.rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:topline', project_id: 'topline', name: 'Topline', last_body: null, last_created_at: 1, unread_count: 0 },
    ])
    const tabsRow = h.list.querySelectorAll('.topic-row')[1] as HTMLElement
    tabsRow.click()
    // Wait a tick for the async switchTopic flow to fire the WS send.
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(h.navigations).toHaveLength(0)
    // Topic_switch event was sent over the WS (not via a reload).
    const sentTopicSwitch = h.socket.sentFrames.filter((f) => {
      try {
        return (JSON.parse(f) as { type?: string }).type === 'topic_switch'
      } catch {
        return false
      }
    })
    expect(sentTopicSwitch.length).toBe(1)
    const parsed = JSON.parse(sentTopicSwitch[0]!) as { new_topic_id: string }
    expect(parsed.new_topic_id).toBe('web:u-1:topline')
  })

  test('2. switchTopic clears #log + sends a single topic_switch event; NO WS reconnect', async () => {
    const h = mountHarness(null)
    // Seed `#log` with content so we can verify the clear.
    h.log.innerHTML = '<div class="run run-agent"><div class="bubble bubble-agent">old</div></div>'
    expect(h.log.children.length).toBe(1)
    h.rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:topline', project_id: 'topline', name: 'Topline', last_body: null, last_created_at: 1, unread_count: 0 },
    ])
    const initialSocket = h.socket
    const tabsRow = h.list.querySelectorAll('.topic-row')[1] as HTMLElement
    tabsRow.click()
    await new Promise<void>((r) => setTimeout(r, 0))
    // Log cleared.
    expect(h.log.children.length).toBe(0)
    // Single topic_switch sent.
    const sentTopicSwitch = h.socket.sentFrames.filter((f) => {
      try {
        return (JSON.parse(f) as { type?: string }).type === 'topic_switch'
      } catch {
        return false
      }
    })
    expect(sentTopicSwitch.length).toBe(1)
    // NO new WS opened (still on the same socket).
    expect(activeSockets.length).toBe(1)
    expect(activeSockets[0]).toBe(initialSocket)
    // Socket still OPEN.
    expect(h.socket.readyState).toBe(1)
  })

  test('3. WS state persists across switch (readyState stays OPEN)', async () => {
    const h = mountHarness(null)
    h.rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:topline', project_id: 'topline', name: 'Topline', last_body: null, last_created_at: 1, unread_count: 0 },
    ])
    expect(h.socket.readyState).toBe(1) // OPEN
    const tabsRow = h.list.querySelectorAll('.topic-row')[1] as HTMLElement
    tabsRow.click()
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(h.socket.readyState).toBe(1) // STILL OPEN
  })

  test('4. Active row updates aria-current=page in-place (no full re-render)', async () => {
    const h = mountHarness(null)
    h.rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:topline', project_id: 'topline', name: 'Topline', last_body: null, last_created_at: 1, unread_count: 0 },
    ])
    const rowsBefore = h.list.querySelectorAll('.topic-row')
    const generalBefore = rowsBefore[0] as HTMLElement
    const tabsBefore = rowsBefore[1] as HTMLElement
    expect(generalBefore.getAttribute('aria-current')).toBe('page')
    expect(tabsBefore.getAttribute('aria-current')).toBeNull()
    tabsBefore.click()
    await new Promise<void>((r) => setTimeout(r, 0))
    // Same element references survive the click (no full re-render).
    const rowsAfter = h.list.querySelectorAll('.topic-row')
    expect(rowsAfter[0]).toBe(generalBefore)
    expect(rowsAfter[1]).toBe(tabsBefore)
    expect(generalBefore.getAttribute('aria-current')).toBeNull()
    expect(tabsBefore.getAttribute('aria-current')).toBe('page')
  })

  test('5. localStorage.neutron.active_topic_id updated on switch + cleared on switch to General', async () => {
    const h = mountHarness(null)
    h.rail.render([
      { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
      { topic_id: 'web:u-1:topline', project_id: 'topline', name: 'Topline', last_body: null, last_created_at: 1, unread_count: 0 },
    ])
    // Switch to Topline.
    const tabsRow = h.list.querySelectorAll('.topic-row')[1] as HTMLElement
    tabsRow.click()
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(localStorage.getItem(mod.ACTIVE_TOPIC_LS_KEY)).toBe('web:u-1:topline')
    // Switch back to General.
    const generalRow = h.list.querySelectorAll('.topic-row')[0] as HTMLElement
    generalRow.click()
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(localStorage.getItem(mod.ACTIVE_TOPIC_LS_KEY)).toBeNull()
  })
})
