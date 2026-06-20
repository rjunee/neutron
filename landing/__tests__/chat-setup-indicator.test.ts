/**
 * Onboarding loading indicator (2026-06-17 single-session rework, Step 1).
 *
 * Ryan-requested: a centered "Setting things up…" indicator on first chat load,
 * cleared the instant the first message renders. It covers the page-load →
 * WS-open → engine.start window — the same window the server uses to pre-warm
 * the conversational `claude` session behind it — so a fresh onboarding visit
 * never stares at a blank chat.
 *
 * 2026-06-18 (first-load client-render fix, Bug 1) — Ryan's live dogfood found
 * the loader cleared at ~0.5s (the on-open typing dots tore it down) leaving a
 * blank screen until the welcome painted. The loader now PERSISTS until the
 * first agent MESSAGE renders: it owns the screen and SUPPRESSES the on-open
 * typing dots while it is up.
 *
 * These tests assert the real DOM behaviour:
 *   - renders on first construction when `#log` is empty (fresh onboarding);
 *   - PERSISTS across WS-open + on-open typing (dots suppressed, no blank);
 *   - clears the instant the first agent MESSAGE renders;
 *   - a server error also clears it;
 *   - skipped when `#log` already has content (returning / server-rendered).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let mod: typeof import('../chat.ts')

interface StubWebSocket {
  url: string
  readyState: number
  onListeners: Array<(ev: Event) => void>
  messageListeners: Array<(ev: { data: string }) => void>
  closeListeners: Array<(ev: Event) => void>
  errorListeners: Array<(ev: Event) => void>
  addEventListener(kind: string, fn: unknown): void
  removeEventListener(): void
  send(): void
  close(): void
  fireOpen(): void
  fireMessage(payload: unknown): void
  fireClose(): void
}

function buildStubWebSocket(): { instances: StubWebSocket[] } {
  const instances: StubWebSocket[] = []
  class FakeWebSocket {
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    url: string
    readyState = 0
    onListeners: Array<(ev: Event) => void> = []
    messageListeners: Array<(ev: { data: string }) => void> = []
    closeListeners: Array<(ev: Event) => void> = []
    errorListeners: Array<(ev: Event) => void> = []
    constructor(url: string) {
      this.url = url
      instances.push(this as unknown as StubWebSocket)
    }
    addEventListener(kind: string, fn: unknown): void {
      if (kind === 'open') this.onListeners.push(fn as (ev: Event) => void)
      else if (kind === 'message')
        this.messageListeners.push(fn as (ev: { data: string }) => void)
      else if (kind === 'close') this.closeListeners.push(fn as (ev: Event) => void)
      else if (kind === 'error') this.errorListeners.push(fn as (ev: Event) => void)
    }
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
    fireOpen(): void {
      this.readyState = 1
      for (const fn of this.onListeners) fn(new Event('open'))
    }
    fireMessage(payload: unknown): void {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
      for (const fn of this.messageListeners) fn({ data })
    }
    fireClose(): void {
      this.readyState = 3
      for (const fn of this.closeListeners) fn(new Event('close'))
    }
  }
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
  return { instances }
}

interface Harness {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
  status: HTMLElement
  input: HTMLTextAreaElement
  sendBtn: HTMLButtonElement
  ws: StubWebSocket
}

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  mod = await import('../chat.ts')
})

/** Mount a ChatClient. `preexistingContent` seeds `#log` BEFORE construction so
 *  the "returning visit" case (non-empty log) can be exercised. Does NOT call
 *  connect() — the setup indicator is a first-construction concern. */
function mount(preexistingContent = false): Harness {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap"><div id="log"></div></div>
    <footer>
      <textarea id="input"></textarea>
      <button id="send"></button>
    </footer>
  `
  const log = document.getElementById('log') as HTMLElement
  if (preexistingContent) {
    const prior = document.createElement('div')
    prior.className = 'run run-agent'
    prior.textContent = 'a prior turn'
    log.appendChild(prior)
  }
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  const wsState = buildStubWebSocket()
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-06-17T12:00:00Z'),
  })
  ;(client as unknown as { connect: () => void }).connect()
  const ws = wsState.instances[wsState.instances.length - 1]!
  return { client, log, status, input, sendBtn, ws }
}

function getSetupIndicator(h: Harness): HTMLElement | null {
  return h.log.querySelector('.setup-indicator') as HTMLElement | null
}

describe('onboarding loading indicator — "Setting things up…"', () => {
  test('renders on first load (empty #log) with the expected copy', () => {
    const h = mount()
    const indicator = getSetupIndicator(h)
    expect(indicator).not.toBeNull()
    expect((indicator!.textContent ?? '').toLowerCase()).toContain('setting things up')
    // It lives directly in #log as a transient first child.
    expect(indicator!.dataset['transient']).toBe('setup')
    expect(indicator!.parentElement).toBe(h.log)
  })

  test('clears the instant the first agent message renders', () => {
    const h = mount()
    expect(getSetupIndicator(h)).not.toBeNull()
    h.ws.fireOpen()
    // The loader persists across WS-open (see the next test). The first real
    // agent message is the canonical clear and must leave NO indicator.
    h.ws.fireMessage({ type: 'agent_message', body: 'Hi — what should I call you?' })
    expect(getSetupIndicator(h)).toBeNull()
    // The real message landed.
    const landed = Array.from(h.log.querySelectorAll('.bubble')).find((b) =>
      (b.textContent ?? '').includes('what should I call you?'),
    )
    expect(landed).not.toBeUndefined()
  })

  test('Bug 1 — PERSISTS across WS-open; the on-open typing dots are suppressed', () => {
    const h = mount()
    expect(getSetupIndicator(h)).not.toBeNull()
    h.ws.fireOpen()
    // The loader owns the screen until the welcome paints. The on-open
    // optimistic dots must NOT render over it (that was the 0.5s-then-blank
    // bug Ryan hit). Loader still up, no typing bubble.
    expect(getSetupIndicator(h)).not.toBeNull()
    expect(h.log.querySelector('.bubble.typing')).toBeNull()
    // The counter bookkeeping still ran (so ISSUES #115 reconciliation holds):
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(1)
  })

  test('Bug 1 — also persists across the server-driven agent_typing_start', () => {
    const h = mount()
    h.ws.fireOpen()
    // The server brackets engine.start with agent_typing_start; even that must
    // not paint dots over the loader.
    h.ws.fireMessage({ type: 'agent_typing_start' })
    expect(getSetupIndicator(h)).not.toBeNull()
    expect(h.log.querySelector('.bubble.typing')).toBeNull()
    // Welcome lands → loader clears, message paints.
    h.ws.fireMessage({
      type: 'agent_message',
      body: 'Hi — what should I call you?',
      prompt_id: 'p-welcome',
    })
    expect(getSetupIndicator(h)).toBeNull()
    const landed = Array.from(h.log.querySelectorAll('.bubble')).find((b) =>
      (b.textContent ?? '').includes('what should I call you?'),
    )
    expect(landed).not.toBeUndefined()
  })

  test('Bug 1 — import_progress does NOT clear the loader (only a message does)', () => {
    const h = mount()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'import_progress', status: 'running', pass: 1, pct: 10 })
    // Progress envelopes are not "the first message" — the loader stays.
    expect(getSetupIndicator(h)).not.toBeNull()
  })

  test('a server error also clears the indicator', () => {
    const h = mount()
    h.ws.fireOpen()
    // Re-show to isolate the error path from the open-dots path: simulate a
    // pre-open error by clearing then asserting the error handler clears.
    h.ws.fireMessage({ type: 'error', message: 'engine.start failed' })
    expect(getSetupIndicator(h)).toBeNull()
  })

  test('NOT shown when #log already has content (returning / server-rendered visit)', () => {
    const h = mount(true)
    expect(getSetupIndicator(h)).toBeNull()
  })
})

/**
 * Bug 2 (2026-06-18) — the first agent message must ALWAYS paint. The
 * field-reported failure was typing → blank: the welcome arrived but never
 * rendered. Hardening: the first message paints even after the on-open typing +
 * a history-hydrate race; dedup records the prompt_id only AFTER a successful
 * paint (so a throw can't poison it); and a render throw paints a plain-text
 * fallback instead of leaving the screen blank.
 */
describe('Bug 2 — first agent message always paints', () => {
  function agentBubbles(h: Harness): Element[] {
    return Array.from(h.log.querySelectorAll('.bubble.bubble-agent:not(.typing)'))
  }

  test('first message paints even when on-open typing fired first', () => {
    const h = mount()
    h.ws.fireOpen() // on-open optimistic dots are suppressed by the loader
    h.ws.fireMessage({
      type: 'agent_message',
      body: 'Welcome — what should I call you?',
      prompt_id: 'p-welcome',
    })
    expect(getSetupIndicator(h)).toBeNull()
    const landed = agentBubbles(h).find((b) =>
      (b.textContent ?? '').includes('what should I call you?'),
    )
    expect(landed).not.toBeUndefined()
  })

  test('a re-emit of the SAME prompt_id is deduped (first paint kept, no double)', () => {
    const h = mount()
    h.ws.fireOpen()
    const msg = {
      type: 'agent_message' as const,
      body: 'Welcome aboard',
      prompt_id: 'p-welcome',
    }
    h.ws.fireMessage(msg)
    h.ws.fireMessage(msg) // live re-emit / hydrate collision
    const painted = agentBubbles(h).filter((b) => (b.textContent ?? '').includes('Welcome aboard'))
    expect(painted.length).toBe(1)
  })

  test('a render throw paints a plain-text fallback — never a blank screen', () => {
    const h = mount()
    h.ws.fireOpen()
    // A null body throws inside the markdown renderer (escapeHtml(null)). Pre-fix
    // that throw was swallowed by the WS handler with the dots already cleared →
    // blank. Now renderAgent catches it and paints a plain-text fallback.
    h.ws.fireMessage({ type: 'agent_message', body: null, prompt_id: 'p-bad' })
    // The screen is not blank: an agent bubble exists, and the loader cleared.
    expect(agentBubbles(h).length).toBeGreaterThanOrEqual(1)
    expect(getSetupIndicator(h)).toBeNull()
    expect(h.log.querySelector('.bubble.typing')).toBeNull()
  })

  test('after a fallback, a subsequent real message still paints', () => {
    const h = mount()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: null, prompt_id: 'p-bad' })
    h.ws.fireMessage({
      type: 'agent_message',
      body: 'Recovered — what should I call you?',
      prompt_id: 'p-welcome',
    })
    const landed = agentBubbles(h).find((b) => (b.textContent ?? '').includes('Recovered'))
    expect(landed).not.toBeUndefined()
  })

  // 2026-06-20 GO-LIVE #2 (owner live-dogfood) — on a RELOAD of a completed
  // instance the server emits NO fresh-onboarding first agent message, and the
  // General topic's history can be empty, so the loader (which only ever
  // cleared on first rendered content) hung FOREVER until a topic switch tore
  // it down. The server now stamps `resumed: true` on a returning session's
  // `session_ready`; the client clears the loader on that signal.
  test('GO-LIVE #2: a resumed session_ready clears the stuck loader (completed-instance reload)', () => {
    const h = mount()
    h.ws.fireOpen()
    // Completed instance: no agent_message, no history. Pre-fix the loader
    // would hang here forever.
    expect(getSetupIndicator(h)).not.toBeNull()
    h.ws.fireMessage({ type: 'session_ready', user_id: 'u-1', resumed: true })
    expect(getSetupIndicator(h)).toBeNull()
  })

  test('GO-LIVE #2: a non-resumed session_ready (fresh onboarding) keeps the loader until the first message', () => {
    const h = mount()
    h.ws.fireOpen()
    // Fresh onboarding arrives WITHOUT `resumed` — the loader must keep
    // covering the bring-up window so there is no blank-then-paint flash.
    h.ws.fireMessage({ type: 'session_ready', user_id: 'u-1' })
    expect(getSetupIndicator(h)).not.toBeNull()
    // The engine.start welcome lands → NOW it clears.
    h.ws.fireMessage({ type: 'agent_message', body: 'Hi — what should I call you?', prompt_id: 'p-w' })
    expect(getSetupIndicator(h)).toBeNull()
  })
})
