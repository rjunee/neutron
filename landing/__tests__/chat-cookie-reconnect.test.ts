/**
 * ISSUES #94 — "session not started" when typing in General after onboarding
 * reaches `completed`.
 *
 * Reproduce-first: the one-shot `?start=` token is consumed ONCE at initial
 * bring-up. A reconnect (network blip, tab re-focus, post-completion General
 * socket) MUST drop to the session cookie — re-presenting the spent token
 * makes the server's atomic jti claim fail, which (pre-fix) closed the socket
 * with 4001 and stranded the authenticated user with "session not started"
 * on every inbound.
 *
 * This test drives `connect()` twice with a successful `open` in between
 * (first bring-up) and asserts the SECOND WS URL no longer carries the
 * `?start=` token, so the upgrade walks the server's cookie-only path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://atlas.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let mod: typeof import('../chat.ts')

interface MockWS {
  url: string
  readyState: number
  closeHandlers: Array<() => void>
  openHandlers: Array<() => void>
  messageHandlers: Array<(ev: { data: string }) => void>
  errorHandlers: Array<() => void>
  addEventListener(type: string, listener: (ev?: unknown) => void): void
  send(): void
  close(): void
}

let lastWS: MockWS | null = null
const wsUrls: string[] = []

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    readyState = 0
    constructor(url: string) {
      wsUrls.push(url)
      const self = this
      const mock: MockWS = {
        url,
        readyState: 0,
        closeHandlers: [],
        openHandlers: [],
        messageHandlers: [],
        errorHandlers: [],
        addEventListener(type: string, listener: (ev?: unknown) => void): void {
          if (type === 'close') mock.closeHandlers.push(listener as () => void)
          if (type === 'open') mock.openHandlers.push(listener as () => void)
          if (type === 'message') {
            mock.messageHandlers.push(listener as (ev: { data: string }) => void)
          }
          if (type === 'error') mock.errorHandlers.push(listener as () => void)
        },
        send(): void {},
        close(): void {},
      }
      lastWS = mock
      const target = self as unknown as Record<string, unknown>
      target['addEventListener'] = mock.addEventListener.bind(mock)
      target['send'] = mock.send.bind(mock)
      target['close'] = mock.close.bind(mock)
      target['readyState'] = mock.readyState
    }
  }
  mod = await import('../chat.ts')
})

function mountClient(): import('../chat.ts').ChatClient {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log"></div>
    <textarea id="input"></textarea>
    <button id="send"></button>
  `
  const log = document.getElementById('log') as HTMLElement
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  return new mod.ChatClient({
    url: 'wss://atlas.neutron.test/ws/chat',
    start_token: 'ONE_SHOT_TOKEN',
    log,
    status,
    input,
    sendBtn,
  })
}

function triggerOpen(): void {
  if (lastWS === null) throw new Error('no WS captured')
  for (const handler of lastWS.openHandlers) handler()
}

function triggerSessionReady(user_id = 'u-1'): void {
  if (lastWS === null) throw new Error('no WS captured')
  const data = JSON.stringify({ type: 'session_ready', user_id })
  for (const handler of lastWS.messageHandlers) handler({ data })
}

describe('ChatClient reconnect drops the one-shot start token (ISSUES #94)', () => {
  beforeEach(() => {
    lastWS = null
    wsUrls.length = 0
    try {
      localStorage.clear()
    } catch {
      // ignore
    }
  })

  test('first connect presents ?start=; reconnect after session_ready is cookie-only', () => {
    const client = mountClient()

    // First bring-up — the one-shot token rides the upgrade so the server
    // can atomically claim its jti and start the engine.
    client.connect()
    expect(wsUrls[0]).toContain('start=ONE_SHOT_TOKEN')

    // The WS opens AND the server confirms the session is genuinely live
    // (`session_ready` fires only after `session_started = true`). NOW the
    // token is provably consumed.
    triggerOpen()
    triggerSessionReady()

    // A reconnect (network blip / tab re-focus / post-completion General
    // socket). Re-presenting the now-spent token would fail the atomic
    // claim → 4001 → "session not started". The client MUST instead rely
    // on the session cookie.
    client.connect()
    expect(wsUrls.length).toBe(2)
    expect(wsUrls[1]).not.toContain('start=')
  })

  test('Codex r2 P1: open WITHOUT session_ready (startSession failed, jti unspent) → reconnect re-presents the token', () => {
    const client = mountClient()
    client.connect()
    expect(wsUrls[0]).toContain('start=ONE_SHOT_TOKEN')
    // The WS upgrade opened, but the server's startSession then FAILED before
    // consuming the jti and closed the socket — NO `session_ready` arrived.
    // The token is still valid; the retry MUST re-present it.
    triggerOpen()
    client.connect()
    expect(wsUrls[1]).toContain('start=ONE_SHOT_TOKEN')
  })

  test('without a prior bring-up the token is still presented (initial load unaffected)', () => {
    const client = mountClient()
    client.connect()
    expect(wsUrls[0]).toContain('start=ONE_SHOT_TOKEN')
    // No open()/session_ready — a pre-open reconnect (e.g. upgrade rejected)
    // still re-presents the token because the jti was never consumed.
    client.connect()
    expect(wsUrls[1]).toContain('start=ONE_SHOT_TOKEN')
  })
})
