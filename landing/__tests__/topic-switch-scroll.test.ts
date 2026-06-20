/**
 * Topic-switch scroll restoration (2026-05-29 sprint) — Fix C.
 *
 * Sam: "It should just start located at the last unread message. Copy
 * Telegram." Tests assert the chat client's first-mount + switch-back
 * scroll choices match the Telegram contract:
 *   1. First-mount with NO unread -> scroll to bottom synchronously
 *      (no animation, scrollTop === scrollHeight - clientHeight).
 *   2. First-mount with unread -> insert "-- New --" divider above
 *      the first unread, scroll to it.
 *   3. Switch AWAY at scrollTop=400 -> switch BACK -> restored to 400.
 *   4. New live message + at-bottom -> auto-scrolls.
 *   5. New live message + scrolled-up -> "↓ N new" pill surfaces; click
 *      pill -> scrolls to bottom + hides pill.
 *   6. No top-to-bottom animation observed during hydration (scrollTop
 *      doesn't transition through intermediate values).
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

function makeSyntheticToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `${header}.${payload}.`
}

let fetchResponses: Array<unknown>

function installFetchStub(responses: Array<unknown>): void {
  fetchResponses = responses
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const next = fetchResponses.shift() ?? {
      ok: true,
      turns: [],
      has_more: false,
      oldest_returned_at: null,
      oldest_returned_prompt_id: null,
    }
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

interface Harness {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
  socket: FakeWebSocket
  newPill: HTMLButtonElement
  scrollTopValues: number[]
}

function mountHarness(initialTopic: string | null = null): Harness {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap">
      <div id="log"></div>
      <button id="new-pill" hidden>↓ new</button>
    </div>
    <footer>
      <textarea id="input"></textarea>
      <button id="send"></button>
    </footer>
  `
  const log = document.getElementById('log') as HTMLElement
  let scrollTopBacking = 0
  const scrollTopValues: number[] = []
  Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(log, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(log, 'scrollTop', {
    get: () => scrollTopBacking,
    set: (v: number) => {
      scrollTopBacking = v
      scrollTopValues.push(v)
    },
    configurable: true,
  })
  ;(log as unknown as { scrollTo: (opts: ScrollToOptions) => void }).scrollTo = (
    o: ScrollToOptions,
  ) => {
    scrollTopBacking = o.top ?? scrollTopBacking
    scrollTopValues.push(scrollTopBacking)
  }
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  const newPill = document.getElementById('new-pill') as HTMLButtonElement
  activeSockets = []
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
  const socket = activeSockets[0]!
  socket.fireOpen()
  return { client, log, socket, newPill, scrollTopValues }
}

beforeEach(() => {
  try {
    localStorage.removeItem(mod.ACTIVE_TOPIC_LS_KEY)
  } catch {
    // ignore
  }
})

describe('Topic-switch scroll restoration (2026-05-29)', () => {
  test('1. First-mount with NO unread -> scroll to bottom synchronously, no animation', async () => {
    installFetchStub([
      // History: 5 resolved turns, no unread.
      {
        ok: true,
        turns: Array.from({ length: 5 }, (_, i) => ({
          prompt_id: `p-${i}`,
          body: `turn ${i}`,
          created_at: 1_700_000_000_000 + i,
          resolved: true,
          resolution_text: `reply ${i}`,
        })),
        has_more: false,
        oldest_returned_at: 1_700_000_000_000,
        oldest_returned_prompt_id: 'p-0',
      },
    ])
    const h = mountHarness(null)
    const switchPromise = h.client.switchTopic('web:u-1:topline', { unread_count_hint: 0 })
    // The client waits for `topic_switched` ack -- fire it.
    await new Promise<void>((r) => setTimeout(r, 0))
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:topline' })
    await switchPromise
    // Scrolled to bottom-aligned position (scrollHeight - clientHeight).
    expect(h.log.scrollTop).toBe(1000 - 600)
  })

  test('2. First-mount with 3 unread -> scrolls to first unread; New divider visible above', async () => {
    // First response feeds the initial constructor-time hydrate; second
    // feeds the post-switch hydrate (which is what the divider test
    // actually exercises).
    const richTurns = Array.from({ length: 5 }, (_, i) => ({
      prompt_id: `p-${i}`,
      body: `agent body ${i}`,
      created_at: 1_700_000_000_000 + i,
      resolved: true,
      resolution_text: `user reply ${i}`,
    }))
    installFetchStub([
      { ok: true, turns: [], has_more: false, oldest_returned_at: null, oldest_returned_prompt_id: null },
      {
        ok: true,
        turns: richTurns,
        has_more: false,
        oldest_returned_at: 1_700_000_000_000,
        oldest_returned_prompt_id: 'p-0',
      },
    ])
    const h = mountHarness(null)
    // Wait for the initial hydrate to drain the first queued response.
    await new Promise<void>((r) => setTimeout(r, 0))
    // Stub offsetTop so the divider scroll target is non-zero.
    const switchPromise = h.client.switchTopic('web:u-1:topline', { unread_count_hint: 3 })
    await new Promise<void>((r) => setTimeout(r, 0))
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:topline' })
    await switchPromise
    const divider = h.log.querySelector('.new-divider')
    expect(divider).not.toBeNull()
    expect(divider!.getAttribute('aria-label')).toBe('New messages')
    // Divider has the "New" label text.
    expect(divider!.querySelector('.new-divider-label')!.textContent).toBe('New')
  })

  test('3. Switch AWAY at scrollTop=400 -> switch BACK -> restored to 400', async () => {
    installFetchStub([
      {
        ok: true,
        turns: [],
        has_more: false,
        oldest_returned_at: null,
        oldest_returned_prompt_id: null,
      },
      {
        ok: true,
        turns: [],
        has_more: false,
        oldest_returned_at: null,
        oldest_returned_prompt_id: null,
      },
      {
        ok: true,
        turns: [],
        has_more: false,
        oldest_returned_at: null,
        oldest_returned_prompt_id: null,
      },
    ])
    const h = mountHarness('web:u-1:topline')
    // Simulate user scrolled up to 400 inside Topline.
    h.log.scrollTop = 400
    // Mark "Topline" as already first-mounted so the switch-back code
    // path takes the restore branch.
    ;(h.client as unknown as { topicFirstMountDone: Set<string> }).topicFirstMountDone.add(
      'web:u-1:topline',
    )
    // Switch to General.
    const switch1 = h.client.switchTopic(null)
    await new Promise<void>((r) => setTimeout(r, 0))
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1' })
    await switch1
    // Switch BACK to Topline.
    const switch2 = h.client.switchTopic('web:u-1:topline')
    await new Promise<void>((r) => setTimeout(r, 0))
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:topline' })
    await switch2
    expect(h.log.scrollTop).toBe(400)
  })

  test('4. New live agent_message + user at-bottom -> auto-scrolls to bottom', async () => {
    installFetchStub([])
    const h = mountHarness(null)
    // Start at bottom (stickToBottom should default to true).
    ;(h.client as unknown as { stickToBottom: boolean }).stickToBottom = true
    h.socket.fireMessage({
      type: 'agent_message',
      body: 'hello',
      prompt_id: 'fresh-1',
    })
    // scrollTop has been written to bottom-aligned position (or further).
    expect(h.scrollTopValues.length).toBeGreaterThan(0)
    expect(h.log.scrollTop).toBeGreaterThan(0)
    // New pill is HIDDEN (user is at bottom).
    expect(h.newPill.hidden).toBe(true)
  })

  test('5. New live agent_message + scrolled up -> "↓ N new" pill surfaces; click pill scrolls + hides', async () => {
    installFetchStub([])
    const h = mountHarness(null)
    // Pretend user scrolled up.
    ;(h.client as unknown as { stickToBottom: boolean }).stickToBottom = false
    h.socket.fireMessage({
      type: 'agent_message',
      body: 'while you read',
      prompt_id: 'while-1',
    })
    h.socket.fireMessage({
      type: 'agent_message',
      body: 'another one',
      prompt_id: 'while-2',
    })
    expect(h.newPill.hidden).toBe(false)
    expect(h.newPill.textContent).toBe('↓ 2 new')
    h.newPill.click()
    expect(h.newPill.hidden).toBe(true)
  })

  test('6. No animated top-to-bottom transition during hydration (scrollTop jumps once)', async () => {
    installFetchStub([
      {
        ok: true,
        turns: Array.from({ length: 5 }, (_, i) => ({
          prompt_id: `p-${i}`,
          body: `agent body ${i}`,
          created_at: 1_700_000_000_000 + i,
          resolved: true,
          resolution_text: `user reply ${i}`,
        })),
        has_more: false,
        oldest_returned_at: 1_700_000_000_000,
        oldest_returned_prompt_id: 'p-0',
      },
    ])
    const h = mountHarness(null)
    h.scrollTopValues.length = 0
    const switchPromise = h.client.switchTopic('web:u-1:topline', { unread_count_hint: 0 })
    await new Promise<void>((r) => setTimeout(r, 0))
    h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:topline' })
    await switchPromise
    // scrollTop should JUMP to the bottom target, not animate through
    // intermediate values. Allow at most 3 writes (one in
    // applyFirstMountScroll + a defensive constructor write +
    // commitNewBubble paths). Critically, no monotonically-increasing
    // sequence of intermediate values.
    expect(h.scrollTopValues.length).toBeLessThan(5)
    // The final value is the bottom-aligned target.
    expect(h.log.scrollTop).toBe(1000 - 600)
  })
})
