/**
 * `ChatClient` onclose-handler infinite-loop circuit breaker.
 *
 * 2026-05-28 — guards the navigate-back-to-/chat path PR #320 added. If
 * the destination keeps rejecting (instance gateway down, synthetic E2E
 * instance with no real backend, slug-rename mid-flight), the pre-fix
 * shape was an infinite WS-fail → /chat → WS-fail → /chat loop. The
 * counter in `landing/chat.ts` caps attempts at WS_RECONNECT_MAX_ATTEMPTS
 * (3) within WS_RECONNECT_WINDOW_MS (10s); the 4th close in that window
 * renders a static disconnected banner instead of navigating.
 *
 * Tests:
 *   1. Single WS close → 1 navigation + counter bumped to 1.
 *   2. WS_RECONNECT_MAX_ATTEMPTS closes within the window → all navigate;
 *      the (MAX+1)-th close STOPS navigating and renders the banner.
 *   3. A successful WS open between closes resets the counter so the
 *      next close navigates again.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://chat.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let mod: typeof import('../chat.ts')

interface MockWS {
  readyState: number
  closeHandlers: Array<(ev?: { code?: number; reason?: string }) => void>
  openHandlers: Array<() => void>
  messageHandlers: Array<(ev: { data: string }) => void>
  errorHandlers: Array<() => void>
  addEventListener(type: string, listener: (ev?: unknown) => void): void
  send(): void
  close(): void
}

let lastWS: MockWS | null = null

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    readyState = 0
    constructor() {
      const self = this
      const mock: MockWS = {
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

interface Harness {
  client: import('../chat.ts').ChatClient
  status: HTMLElement
  replaceCalls: string[]
}

function mountHarness(opts: { now?: () => number } = {}): Harness {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log"></div>
    <textarea id="input"></textarea>
    <button id="send"></button>
  `
  const status = document.getElementById('status') as HTMLElement
  const log = document.getElementById('log') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  const replaceCalls: string[] = []
  Object.defineProperty(window.location, 'replace', {
    value: (url: string) => replaceCalls.push(url),
    writable: true,
    configurable: true,
  })
  const clientOpts: import('../chat.ts').ChatClientOptions = {
    url: 'wss://chat.neutron.test/ws/chat',
    start_token: 'NEW_TOKEN',
    log,
    status,
    input,
    sendBtn,
  }
  if (opts.now !== undefined) clientOpts.now = opts.now
  const client = new mod.ChatClient(clientOpts)
  return { client, status, replaceCalls }
}

function triggerClose(): void {
  if (lastWS === null) throw new Error('no WS captured')
  for (const handler of lastWS.closeHandlers) handler()
}

function triggerOpen(): void {
  if (lastWS === null) throw new Error('no WS captured')
  for (const handler of lastWS.openHandlers) handler()
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
}

describe('ChatClient WS-close infinite-loop circuit breaker', () => {
  beforeEach(() => {
    lastWS = null
    try {
      localStorage.clear()
    } catch {
      // ignore
    }
  })

  test('single WS close → 1 navigation + counter bumped to 1', async () => {
    let t = 1_000_000
    const h = mountHarness({ now: () => t })
    h.client.connect()
    triggerClose()
    await flush()
    expect(h.replaceCalls).toEqual(['/chat'])
    expect(h.status.textContent).toBe('redirecting to sign in…')
    // localStorage state survives the navigation (it would survive a
    // real-browser page reload too — the next mount reads it back).
    const raw = localStorage.getItem(mod.WS_RECONNECT_LS_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw ?? '{}') as { count?: number; first_ts?: number }
    expect(parsed.count).toBe(1)
    expect(parsed.first_ts).toBe(1_000_000)
  })

  test(
    `${mod?.WS_RECONNECT_MAX_ATTEMPTS ?? 3} closes navigate, the next is GATED — banner shown, no navigation`,
    async () => {
      let t = 1_000_000
      const h = mountHarness({ now: () => t })
      // Hit the close handler exactly WS_RECONNECT_MAX_ATTEMPTS times,
      // each re-opening the WS to simulate the reload cycle. All three
      // should navigate. Use a time-advance of 1s between attempts so
      // we stay well inside the 10s window.
      for (let i = 0; i < mod.WS_RECONNECT_MAX_ATTEMPTS; i += 1) {
        h.client.connect()
        triggerClose()
        await flush()
        t += 1_000
      }
      expect(h.replaceCalls.length).toBe(mod.WS_RECONNECT_MAX_ATTEMPTS)
      // The (MAX+1)-th close: counter goes to MAX+1 (> MAX), gated.
      h.client.connect()
      triggerClose()
      await flush()
      // No new navigation — same length as before.
      expect(h.replaceCalls.length).toBe(mod.WS_RECONNECT_MAX_ATTEMPTS)
      // Banner shown.
      expect(h.status.textContent).toContain('Connection lost')
      expect(h.status.textContent).toContain('sign in again')
    },
  )

  test('successful WS open resets the counter — next close navigates again', async () => {
    let t = 1_000_000
    const h = mountHarness({ now: () => t })
    // Burn 3 attempts to put us at the cap.
    for (let i = 0; i < mod.WS_RECONNECT_MAX_ATTEMPTS; i += 1) {
      h.client.connect()
      triggerClose()
      await flush()
      t += 1_000
    }
    // Now the cookie / network recovered; the next connect succeeds.
    h.client.connect()
    triggerOpen()
    await flush()
    // Counter should be cleared.
    expect(localStorage.getItem(mod.WS_RECONNECT_LS_KEY)).toBeNull()
    // Subsequent close starts a fresh window — navigates.
    const before = h.replaceCalls.length
    triggerClose()
    await flush()
    expect(h.replaceCalls.length).toBe(before + 1)
    expect(h.replaceCalls[h.replaceCalls.length - 1]).toBe('/chat')
  })

  test('window expiry resets the counter — closes after 10s navigate again', async () => {
    let t = 1_000_000
    const h = mountHarness({ now: () => t })
    // Burn 3 attempts.
    for (let i = 0; i < mod.WS_RECONNECT_MAX_ATTEMPTS; i += 1) {
      h.client.connect()
      triggerClose()
      await flush()
      t += 1_000
    }
    // Jump past the window — counter should reset on next close.
    t += mod.WS_RECONNECT_WINDOW_MS + 1_000
    h.client.connect()
    triggerClose()
    await flush()
    // Navigation count went up by 1 — the close after the window
    // expiry navigated cleanly (not gated, not the banner).
    expect(h.replaceCalls.length).toBe(mod.WS_RECONNECT_MAX_ATTEMPTS + 1)
  })
})

describe('shouldGateWsReconnect — pure-function semantics', () => {
  beforeEach(() => {
    try {
      localStorage.clear()
    } catch {
      // ignore
    }
  })

  test('first call → not gated, persists count=1', () => {
    const gated = mod.shouldGateWsReconnect(5_000)
    expect(gated).toBe(false)
    const raw = JSON.parse(localStorage.getItem(mod.WS_RECONNECT_LS_KEY) ?? '{}') as {
      count?: number
      first_ts?: number
    }
    expect(raw.count).toBe(1)
    expect(raw.first_ts).toBe(5_000)
  })

  test('Nth call within window → gates once count exceeds MAX', () => {
    for (let i = 0; i < mod.WS_RECONNECT_MAX_ATTEMPTS; i += 1) {
      expect(mod.shouldGateWsReconnect(5_000 + i * 100)).toBe(false)
    }
    // The next call pushes count to MAX+1 → gated.
    expect(mod.shouldGateWsReconnect(5_000 + mod.WS_RECONNECT_MAX_ATTEMPTS * 100)).toBe(true)
  })

  test('call after window expiry resets, returns false', () => {
    expect(mod.shouldGateWsReconnect(5_000)).toBe(false)
    // Just past the window.
    expect(mod.shouldGateWsReconnect(5_000 + mod.WS_RECONNECT_WINDOW_MS + 1)).toBe(false)
    const raw = JSON.parse(localStorage.getItem(mod.WS_RECONNECT_LS_KEY) ?? '{}') as {
      count?: number
    }
    // Count was reset on the second call.
    expect(raw.count).toBe(1)
  })

  test('clearWsReconnectState wipes localStorage', () => {
    mod.shouldGateWsReconnect(5_000)
    expect(localStorage.getItem(mod.WS_RECONNECT_LS_KEY)).not.toBeNull()
    mod.clearWsReconnectState()
    expect(localStorage.getItem(mod.WS_RECONNECT_LS_KEY)).toBeNull()
  })
})
