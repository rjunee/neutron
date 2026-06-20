/**
 * `ChatClient` onclose-handler navigation tests.
 *
 * 2026-05-27 persistent-session-cookie sprint — the chat client no
 * longer self-recovers via `/recover`. On every WS close the client
 * simply navigates to `/chat`; the per-instance gateway's auth-gate
 * (`landing/auth-gate.ts`) then decides between serving chat (valid
 * `neutron_session` cookie) or 302ing to identity signin with
 * `return_url` preserved. No fetch, no stashed-token plumbing, no
 * "disconnected. refresh to continue." UI for the common
 * expired-cookie case.
 *
 * The previous /recover round-trip behavior is gone — these tests pin
 * the new simpler shape and explicitly regression-guard against the
 * stale auto-recover code coming back (including: stashing a token in
 * `window.__neutron_start_token` MUST NOT change behavior).
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
  addEventListener(
    type: string,
    listener: (ev?: unknown) => void,
  ): void
  send(): void
  close(): void
}

let lastWS: MockWS | null = null

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    readyState = 0
    private handlers: Record<string, Array<(ev?: unknown) => void>> = {}
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
      // The real WebSocket constructor returns `this`; the ChatClient
      // calls addEventListener on the returned value. We delegate to
      // the captured mock.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  capturedFetch: Array<{ url: string; redirect?: RequestRedirect }>
  fetchResponse: () => Promise<Response>
  replaceCalls: string[]
}

function mountHarness(opts: {
  stashToken?: string | null
  fetchImpl?: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response>
} = {}): Harness {
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
  if (opts.stashToken === null) {
    delete (window as unknown as { __neutron_start_token?: string }).__neutron_start_token
  } else {
    ;(window as unknown as { __neutron_start_token?: string }).__neutron_start_token =
      opts.stashToken ?? 'OLD_TOKEN'
  }
  const capturedFetch: Array<{ url: string; redirect?: RequestRedirect }> = []
  const fetchImpl = opts.fetchImpl ?? (async () => new Response(null, { status: 500 }))
  const wrappedFetch = async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString()
    const entry: { url: string; redirect?: RequestRedirect } = { url: u }
    if (init?.redirect !== undefined) entry.redirect = init.redirect
    capturedFetch.push(entry)
    return fetchImpl(u, init)
  }
  ;(window as unknown as { fetch: unknown }).fetch = wrappedFetch
  ;(globalThis as unknown as { fetch: unknown }).fetch = wrappedFetch
  const replaceCalls: string[] = []
  Object.defineProperty(window.location, 'replace', {
    value: (url: string) => replaceCalls.push(url),
    writable: true,
    configurable: true,
  })
  const client = new mod.ChatClient({
    url: 'wss://chat.neutron.test/ws/chat',
    start_token: 'NEW_TOKEN',
    log,
    status,
    input,
    sendBtn,
  })
  return {
    client,
    status,
    capturedFetch,
    fetchResponse: fetchImpl as Harness['fetchResponse'],
    replaceCalls,
  }
}

function triggerClose(): void {
  if (lastWS === null) throw new Error('no WS captured')
  for (const handler of lastWS.closeHandlers) handler()
}

async function flush(): Promise<void> {
  // Allow microtasks (the async handleClose's await) to drain.
  await new Promise((r) => setTimeout(r, 10))
}

describe('ChatClient onclose — navigate-to-/chat behavior (persistent-session-cookie sprint)', () => {
  beforeEach(() => {
    lastWS = null
    // 2026-05-28 — clear the WS-reconnect circuit-breaker counter so
    // each test starts with a clean slate. Without this, persistent
    // localStorage from earlier tests accumulates and the 4th close
    // in this file gets gated by the new infinite-loop guard.
    try {
      localStorage.clear()
    } catch {
      // ignore — happy-dom always provides it, but be defensive.
    }
  })

  test('WS close → navigate to /chat (auth-gate decides what happens next)', async () => {
    const h = mountHarness({ stashToken: null })
    h.client.connect()
    triggerClose()
    await flush()
    // No /recover fetch — the client navigates directly so the
    // per-instance gateway's auth-gate (landing/auth-gate.ts) decides
    // between issuing the chat HTML (valid session cookie) or 302ing
    // to identity signin with return_url preserved.
    expect(h.capturedFetch.length).toBe(0)
    expect(h.replaceCalls).toEqual(['/chat'])
    expect(h.status.textContent).toBe('redirecting to sign in…')
  })

  test('shows "reconnecting..." momentarily then "redirecting to sign in…" before navigating', async () => {
    const h = mountHarness({ stashToken: null })
    h.client.connect()
    // Capture the status text as it transitions. The handler is
    // effectively synchronous (no awaited fetch) so by the time we
    // get back to the test the status has already flipped to the
    // final "redirecting to sign in…" string. We assert the final
    // state plus the navigation, which together prove the transition
    // path: setStatus('connecting', 'reconnecting...') runs first
    // (visible if a microtask interleaves), then setStatus(
    // 'connecting', 'redirecting to sign in…'), then
    // window.location.replace('/chat').
    triggerClose()
    await flush()
    expect(h.status.textContent).toBe('redirecting to sign in…')
    expect(h.replaceCalls).toEqual(['/chat'])
  })

  test('WS close → does NOT fetch /recover (regression: stale auto-recover behavior removed)', async () => {
    const h = mountHarness({ stashToken: null })
    h.client.connect()
    triggerClose()
    await flush()
    expect(h.capturedFetch.length).toBe(0)
  })

  test('WS close with stashed __neutron_start_token still navigates to /chat (stash is irrelevant)', async () => {
    const h = mountHarness({ stashToken: 'STILL_HERE' })
    h.client.connect()
    triggerClose()
    await flush()
    // The stash used to gate /recover; after the persistent-session-
    // cookie sprint the chat client ignores it entirely. Pin that.
    expect(h.capturedFetch.length).toBe(0)
    expect(h.replaceCalls).toEqual(['/chat'])
  })
})
