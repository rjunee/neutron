/**
 * GO-LIVE chat-surface defects #3 + #4 (2026-06-20, owner live-dogfood).
 *
 * #3: switching topics must render the FULL prior conversation, not just the
 *     single re-emitted active prompt ("only the last message renders").
 * #4: after a switch the typing indicator must re-attach — an agent turn on
 *     the newly-selected topic shows the dots again.
 *
 * Drives the REAL switchTopic → topic_switched ack → hydrateInitialHistory
 * path against a fake WS + a fetch stub that returns a multi-turn history for
 * the destination topic.
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

// Mutable per-test history payload the fetch stub returns for /chat/history.
let nextHistoryTurns: unknown[] = []
let hangFirstHistory = false
let firstHistoryHung = false

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
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    if (url.includes('/api/v1/chat/history')) {
      // Optional: make the FIRST (General) hydrate hang until the switch
      // aborts it, reproducing the in-flight-fetch-during-switch race.
      if (hangFirstHistory && !firstHistoryHung) {
        firstHistoryHung = true
        await new Promise<void>((resolve, reject) => {
          const sig = init?.signal
          if (sig) sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }
      const turns = nextHistoryTurns
      const last = turns.length > 0 ? (turns[turns.length - 1] as { created_at: number; prompt_id: string }) : null
      return new Response(
        JSON.stringify({
          ok: true,
          turns,
          has_more: false,
          oldest_returned_at: last !== null ? last.created_at : null,
          oldest_returned_prompt_id: last !== null ? last.prompt_id : null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // Topics rail etc.
    return new Response(JSON.stringify({ ok: true, topics: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  mod = await import('../chat.ts')
})

function makeSyntheticToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `${header}.${payload}.`
}

/** DESC (newest-first) batch as the server delivers it. */
function descTurns(n: number, opts: { newestUnresolved?: boolean } = {}): unknown[] {
  const out: unknown[] = []
  for (let i = n; i >= 1; i--) {
    const isNewest = i === n
    const unresolved = isNewest && opts.newestUnresolved === true
    out.push(
      unresolved
        ? {
            prompt_id: `p-${i}`,
            body: `agent message ${i}`,
            created_at: Date.parse('2026-06-20T00:00:00Z') + i * 60_000,
            resolved: false,
            resolution_text: null,
          }
        : {
            prompt_id: `p-${i}`,
            body: `agent message ${i}`,
            created_at: Date.parse('2026-06-20T00:00:00Z') + i * 60_000,
            resolved: true,
            resolution_text: `user reply ${i}`,
          },
    )
  }
  return out
}

interface Harness {
  client: import('../chat.ts').ChatClient
  rail: import('../chat.ts').TopicRail
  list: HTMLElement
  log: HTMLElement
  socket: FakeWebSocket
}

function mountHarness(): Harness {
  document.body.innerHTML = `
    <aside id="topic-rail" aria-label="Chat topics"><nav class="rail-list" id="rail-list"></nav></aside>
    <header><div id="status"></div></header>
    <div id="log-wrap"><div id="log"></div><button id="new-pill" hidden></button></div>
    <footer><textarea id="input"></textarea><button id="send"></button></footer>
  `
  const log = document.getElementById('log') as HTMLElement
  Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
  Object.defineProperty(log, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(log, 'scrollTop', { value: 0, writable: true, configurable: true })
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  activeSockets = []
  const opts: import('../chat.ts').ChatClientOptions = {
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: makeSyntheticToken('u-1'),
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-06-20T12:00:00Z'),
  }
  const client = new mod.ChatClient(opts)
  client.connect()
  const socket = activeSockets[0]!
  socket.fireOpen()
  socket.fireMessage({ type: 'session_ready', user_id: 'u-1' })
  const list = document.getElementById('rail-list') as HTMLElement
  const rail = new mod.TopicRail({
    rail: document.getElementById('topic-rail') as HTMLElement,
    list,
    activeTopicId: null,
    chatClient: client,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: true, topics: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    reload: () => {},
  })
  return { client, rail, list, log, socket }
}

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  try {
    localStorage.removeItem(mod.ACTIVE_TOPIC_LS_KEY)
  } catch {
    /* ignore */
  }
  nextHistoryTurns = []
  hangFirstHistory = false
  firstHistoryHung = false
})

async function switchToTopline(h: Harness): Promise<void> {
  h.rail.render([
    { topic_id: 'web:u-1', project_id: null, name: 'General', last_body: null, last_created_at: null, unread_count: 0 },
    { topic_id: 'web:u-1:topline', project_id: 'topline', name: 'Topline', last_body: null, last_created_at: 1, unread_count: 0 },
  ])
  const row = h.list.querySelectorAll('.topic-row')[1] as HTMLElement
  row.click()
  await tick()
  // Server acks the switch (reEmit happens server-side before this).
  h.socket.fireMessage({ type: 'topic_switched', topic_id: 'web:u-1:topline' })
  await tick()
  await tick()
}

describe('GO-LIVE #3 — topic switch renders FULL history, not just the last message', () => {
  test('switching to a project with 4 prior turns renders all 4 agent bubbles', async () => {
    const h = mountHarness()
    await tick()
    // Destination topic has 4 resolved turns + a newest unresolved active row.
    nextHistoryTurns = descTurns(5, { newestUnresolved: true })
    await switchToTopline(h)
    const agentBubbles = h.log.querySelectorAll('.bubble-agent')
    // 4 resolved historical turns render their agent bubble; the newest
    // unresolved row is the active prompt (left for the live re-emit).
    expect(agentBubbles.length).toBeGreaterThanOrEqual(4)
  })

  test('abort-race: a still-in-flight initial General hydrate does not strand the destination on one message', async () => {
    hangFirstHistory = true
    const h = mountHarness()
    // Do NOT await a tick — the initial General hydrate is hanging.
    nextHistoryTurns = descTurns(4, { newestUnresolved: true })
    await switchToTopline(h)
    const agentBubbles = h.log.querySelectorAll('.bubble-agent')
    expect(agentBubbles.length).toBeGreaterThanOrEqual(3)
  })

  test('switching to a project whose only row is an unanswered seed still renders it', async () => {
    const h = mountHarness()
    await tick()
    nextHistoryTurns = descTurns(3) // all resolved, none "active"
    await switchToTopline(h)
    const agentBubbles = h.log.querySelectorAll('.bubble-agent')
    expect(agentBubbles.length).toBe(3)
  })
})

describe('GO-LIVE #4 — typing indicator re-attaches after a topic switch', () => {
  test('an agent_typing_start on the new topic shows the dots again', async () => {
    const h = mountHarness()
    await tick()
    nextHistoryTurns = descTurns(2)
    await switchToTopline(h)
    // A fresh agent turn begins on the newly-selected topic.
    h.socket.fireMessage({ type: 'agent_typing_start' })
    await tick()
    const typing = h.log.querySelector('.typing, .typing-bubble, [data-typing]')
    expect(typing).not.toBeNull()
  })
})
