/**
 * Bug 3 regression (2026-05-21) — typing indicator on WS-open.
 *
 * Symptom (verified in prod 2026-05-21): user reaches the chat page,
 * WS opens, but engine.start takes 4+ seconds to resolve the
 * phase-spec via the LLM router. During that window the user stares
 * at a blank chat with no feedback — they don't know if the page is
 * working or stuck.
 *
 * Fix: insert the optimistic "agent is typing" dots bubble
 * immediately when the WS opens, before the first agent envelope
 * arrives. Hide on the first inbound (agent_message or server error).
 * Defensive 15s timeout clears the dots if no envelope ever arrives
 * (terminal phase, misconfigured instance) so the dangling dots don't
 * stay forever.
 *
 * Cross-references:
 *   - Bug 1 fix (engine.ts) re-emits on session-open, so for typical
 *     onboarding phases an `agent_message` envelope WILL arrive on
 *     reconnect — making the typing dots a 2-3s placeholder instead
 *     of dangling indefinitely.
 *   - Pre-Bug-3 the dots only appeared after `sendInput` /
 *     `sendChoice` (user-driven turns).
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
  // First import — without the stub installed, the module's connect()
  // path uses `new WebSocket(...)` at call time. Install the stub
  // BEFORE we mount the harness in each test.
  mod = await import('../chat.ts')
})

function mountAndOpen(): Harness {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap"><div id="log"></div></div>
    <footer>
      <textarea id="input"></textarea>
      <button id="send"></button>
    </footer>
  `
  const log = document.getElementById('log') as HTMLElement
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
    now: () => Date.parse('2026-05-21T12:00:00Z'),
  })
  ;(client as unknown as { connect: () => void }).connect()
  // 2026-06-18 (Bug 1) — on a FRESH first load the "Setting things up…" loader
  // owns the screen and SUPPRESSES the on-open typing dots until the first agent
  // message paints. These tests exercise the on-open optimistic dots + the
  // ISSUES #115 reconciliation, which now apply to the no-loader case (WS
  // reconnect / returning session, or after the welcome has landed). Clear the
  // loader before the test drives `fireOpen` so the on-open dots render here.
  // First-load loader persistence is covered in chat-setup-indicator.test.ts.
  ;(client as unknown as { clearSetupIndicator: () => void }).clearSetupIndicator()
  const ws = wsState.instances[wsState.instances.length - 1]!
  return { client, log, status, input, sendBtn, ws }
}

function getTypingBubble(h: Harness): HTMLElement | null {
  return h.log.querySelector('.bubble.typing') as HTMLElement | null
}

describe('Bug 3 — typing indicator on WS-open', () => {
  test('dots appear the moment WS opens (before the first agent envelope)', () => {
    const h = mountAndOpen()
    expect(getTypingBubble(h)).toBeNull()
    h.ws.fireOpen()
    const bubble = getTypingBubble(h)
    expect(bubble).not.toBeNull()
    expect(bubble!.classList.contains('bubble-agent')).toBe(true)
    expect(bubble!.classList.contains('typing')).toBe(true)
    expect(bubble!.querySelectorAll('.dot').length).toBe(3)
    // The internal pendingAgentReplies counter is bumped to 1.
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(1)
  })

  test('dots vanish on the first agent_message envelope', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    expect(getTypingBubble(h)).not.toBeNull()
    h.ws.fireMessage({ type: 'agent_message', body: 'Hello, what should I call you?' })
    expect(getTypingBubble(h)).toBeNull()
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(0)
    // The real agent message landed.
    const bubbles = h.log.querySelectorAll('.bubble')
    const realAgent = Array.from(bubbles).find((b) =>
      (b.textContent ?? '').includes('Hello, what should I call you?'),
    )
    expect(realAgent).not.toBeUndefined()
  })

  test('dots vanish on server error envelope', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    expect(getTypingBubble(h)).not.toBeNull()
    h.ws.fireMessage({ type: 'error', message: 'engine.start failed' })
    expect(getTypingBubble(h)).toBeNull()
  })

  test('subsequent user-turn dots still work after the open-time dots cleared', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Hi' })
    expect(getTypingBubble(h)).toBeNull()
    // User types + sends. The existing user-turn typing-indicator
    // logic should fire identically to pre-Bug-3.
    ;(h.client as unknown as { inFlight: boolean }).inFlight = false
    h.input.value = 'Sam'
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {},
    }
    ;(h.client as unknown as { sendInput: () => void }).sendInput()
    expect(getTypingBubble(h)).not.toBeNull()
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(1)
  })

  test('WS close clears the open-time dots and zeroes the counter', async () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    expect(getTypingBubble(h)).not.toBeNull()
    delete (window as unknown as { __neutron_start_token?: string }).__neutron_start_token
    await (h.client as unknown as { handleClose: () => Promise<void> }).handleClose()
    expect(getTypingBubble(h)).toBeNull()
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(0)
  })

  test('open-time timeout handle is registered + cleared on first envelope', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    const internal = h.client as unknown as {
      openTypingTimeoutHandle: ReturnType<typeof setTimeout> | null
    }
    // Handle exists immediately after open.
    expect(internal.openTypingTimeoutHandle).not.toBeNull()
    h.ws.fireMessage({ type: 'agent_message', body: 'Hi' })
    // Cleared once envelope arrives.
    expect(internal.openTypingTimeoutHandle).toBeNull()
  })
})

/**
 * ISSUES #115 Argus r1 BLOCKER (2026-06-09) — the no-reply-start edge.
 *
 * Reproduce-first regression for the stuck-indicator class #115 set out
 * to fix. The server brackets `engine.start` with `agent_typing_start`
 * before the call and `agent_typing_end` in a `finally`
 * (gateway/http/chat-bridge.ts:1105/1131) — the bracket fires on EVERY
 * open, including the cases where engine.start emits no reply at all
 * (terminal phase, completed-onboarding reconnect, misconfigured instance).
 *
 * The regression: `handleAgentTypingStart` cancels the on-open defensive
 * timeout the moment that bracket opens. That removed the only safety net,
 * so when the bracket then CLOSED with no `agent_message`/`agent_ack` in
 * between, the on-open optimistic `pendingAgentReplies = 1` was never
 * decremented — `agent_typing_end` left `shouldShowTyping()` true and the
 * dots stranded forever.
 *
 * Fix: `handleAgentTypingEnd` reconciles the on-open optimistic pending
 * when the server bracket fully closes without delivering a reply.
 */
describe('ISSUES #115 — no-reply engine.start leaves no stranded dots', () => {
  test('open → typing_start → typing_end (no agent_message) clears the dots', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    // On-open optimism: dots up, pending = 1, flagged optimistic.
    expect(getTypingBubble(h)).not.toBeNull()
    const internal = h.client as unknown as {
      pendingAgentReplies: number
      serverTypingActive: number
      openOptimisticPending: boolean
    }
    expect(internal.pendingAgentReplies).toBe(1)
    expect(internal.openOptimisticPending).toBe(true)

    // Server brackets engine.start. The start cancels the defensive
    // timeout (a real bracket opened) — this is what removed the old
    // safety net.
    h.ws.fireMessage({ type: 'agent_typing_start' })
    expect(internal.serverTypingActive).toBe(1)
    const after = h.client as unknown as {
      openTypingTimeoutHandle: ReturnType<typeof setTimeout> | null
    }
    expect(after.openTypingTimeoutHandle).toBeNull()

    // engine.start emitted NOTHING — bracket closes with no reply.
    h.ws.fireMessage({ type: 'agent_typing_end' })

    // Pre-fix: dots stranded forever (pending stuck at 1). Post-fix: the
    // on-open optimism is reconciled and the indicator clears.
    expect(internal.serverTypingActive).toBe(0)
    expect(internal.pendingAgentReplies).toBe(0)
    expect(internal.openOptimisticPending).toBe(false)
    expect(getTypingBubble(h)).toBeNull()
  })

  test('a real agent_message inside the bracket is NOT double-counted', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    const internal = h.client as unknown as {
      pendingAgentReplies: number
      serverTypingActive: number
      openOptimisticPending: boolean
    }
    // Normal happy path: bracket opens, reply lands, bracket closes.
    h.ws.fireMessage({ type: 'agent_typing_start' })
    h.ws.fireMessage({ type: 'agent_message', body: 'Hello, what should I call you?' })
    // The reply fulfils the on-open optimism: pending back to 0, flag off.
    expect(internal.pendingAgentReplies).toBe(0)
    expect(internal.openOptimisticPending).toBe(false)
    // Closing the bracket must NOT over-decrement (counter clamps at 0).
    h.ws.fireMessage({ type: 'agent_typing_end' })
    expect(internal.pendingAgentReplies).toBe(0)
    expect(internal.serverTypingActive).toBe(0)
    expect(getTypingBubble(h)).toBeNull()
    // The real reply is still on screen.
    const realAgent = Array.from(h.log.querySelectorAll('.bubble')).find((b) =>
      (b.textContent ?? '').includes('Hello, what should I call you?'),
    )
    expect(realAgent).not.toBeUndefined()
  })

  test('a user-sent turn pending is NOT reconciled away by a bracket close', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    // Clear the on-open optimism with a first real reply.
    h.ws.fireMessage({ type: 'agent_typing_start' })
    h.ws.fireMessage({ type: 'agent_message', body: 'Hi' })
    h.ws.fireMessage({ type: 'agent_typing_end' })
    expect(getTypingBubble(h)).toBeNull()

    // User sends a turn — this pending is a real owed reply, NOT the
    // on-open optimistic one.
    ;(h.client as unknown as { inFlight: boolean }).inFlight = false
    h.input.value = 'Sam'
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {},
    }
    ;(h.client as unknown as { sendInput: () => void }).sendInput()
    const internal = h.client as unknown as {
      pendingAgentReplies: number
      openOptimisticPending: boolean
    }
    expect(internal.pendingAgentReplies).toBe(1)
    expect(internal.openOptimisticPending).toBe(false)

    // Server brackets the turn but (hypothetically) the bracket closes
    // before the reply. The owed reply must keep the dots up — the
    // reconciliation is scoped strictly to the on-open optimism.
    h.ws.fireMessage({ type: 'agent_typing_start' })
    h.ws.fireMessage({ type: 'agent_typing_end' })
    expect(internal.pendingAgentReplies).toBe(1)
    expect(getTypingBubble(h)).not.toBeNull()
  })
})
