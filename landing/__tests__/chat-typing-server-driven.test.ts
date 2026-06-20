/**
 * ISSUES #115 — server-driven typing indicator (deterministic, not
 * intermittent).
 *
 * The prior typing indicator was client-optimistic only: dots on a
 * visible user send, cleared on the first `agent_message`. That model
 * went dark on (a) turns the user never triggered with a send
 * (proactively-emitted phase prompts) and (b) the gaps between messages
 * on multi-`agent_message` turns — so the indicator appeared after SOME
 * replies and not others (Sam, live signup).
 *
 * The gateway now brackets every turn with `agent_typing_start` /
 * `agent_typing_end`. These tests pin the client half: the dots show on
 * `agent_typing_start` and stay visible — across intervening
 * `agent_message`s — until the matching `agent_typing_end`, with proper
 * ref-counting, even when there was NO preceding user send.
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

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    readyState = 0
    addEventListener(): void {}
    send(): void {}
    close(): void {}
  }
  mod = await import('../chat.ts')
})

interface Harness {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
}

function mountHarness(): Harness {
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
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status: document.getElementById('status') as HTMLElement,
    input: document.getElementById('input') as HTMLTextAreaElement,
    sendBtn: document.getElementById('send') as HTMLButtonElement,
    now: () => Date.parse('2026-06-09T12:00:00Z'),
  })
  ;(client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
    readyState: 1,
    send: () => {},
  }
  // 2026-06-18 (Bug 1) — clear the first-load "Setting things up…" loader so the
  // server-driven typing-dot mechanics render here. While the loader is up it
  // owns the screen and suppresses the dots (it is the sole first-load liveness
  // signal until the welcome paints); these tests model later proactive phase
  // prompts, after the loader is gone. First-load behaviour: chat-setup-indicator.test.ts.
  ;(client as unknown as { clearSetupIndicator: () => void }).clearSetupIndicator()
  return { client, log }
}

type Priv = {
  handleAgentTypingStart: () => void
  handleAgentTypingEnd: () => void
  renderAgent: (m: unknown) => void
  handleClose: () => Promise<void>
  serverTypingActive: number
  typingBubble: HTMLElement | null
}
const priv = (h: Harness): Priv => h.client as unknown as Priv
const typingShown = (h: Harness): boolean =>
  h.log.querySelector('.bubble.typing') !== null
const startTurn = (h: Harness): void => priv(h).handleAgentTypingStart()
const endTurn = (h: Harness): void => priv(h).handleAgentTypingEnd()
const agentMsg = (h: Harness, body: string): void =>
  priv(h).renderAgent({ type: 'agent_message', body })

describe('ISSUES #115 — proactive turn (no preceding user send)', () => {
  test('typing_start shows the dots even though the user never sent', () => {
    const h = mountHarness()
    expect(typingShown(h)).toBe(false)
    startTurn(h)
    expect(typingShown(h)).toBe(true)
  })

  test('dots persist through the agent_message and clear on typing_end', () => {
    const h = mountHarness()
    startTurn(h)
    expect(typingShown(h)).toBe(true)
    agentMsg(h, 'Here is your **agent name** — keep it?')
    // The reply rendered, but the server turn is still open → dots re-arm
    // below the message rather than vanishing (the intermittency fix).
    expect(typingShown(h)).toBe(true)
    endTurn(h)
    // Turn fully done + no optimistic user-send pending → dots gone.
    expect(typingShown(h)).toBe(false)
  })
})

describe('ISSUES #115 — multi-message turn stays continuous', () => {
  test('dots stay visible across several agent_messages until typing_end', () => {
    const h = mountHarness()
    startTurn(h)
    agentMsg(h, 'first')
    expect(typingShown(h)).toBe(true)
    agentMsg(h, 'second')
    expect(typingShown(h)).toBe(true)
    agentMsg(h, 'third')
    expect(typingShown(h)).toBe(true)
    endTurn(h)
    expect(typingShown(h)).toBe(false)
  })
})

describe('ISSUES #115 — start/end ref-counting', () => {
  test('two starts require two ends before the dots clear', () => {
    const h = mountHarness()
    startTurn(h)
    startTurn(h)
    expect(priv(h).serverTypingActive).toBe(2)
    expect(typingShown(h)).toBe(true)
    endTurn(h)
    expect(priv(h).serverTypingActive).toBe(1)
    expect(typingShown(h)).toBe(true)
    endTurn(h)
    expect(priv(h).serverTypingActive).toBe(0)
    expect(typingShown(h)).toBe(false)
  })

  test('a stray end never drives the counter negative', () => {
    const h = mountHarness()
    endTurn(h)
    expect(priv(h).serverTypingActive).toBe(0)
    expect(typingShown(h)).toBe(false)
  })
})

describe('ISSUES #115 — WS close clears the server bracket', () => {
  test('handleClose zeroes serverTypingActive so the dots cannot strand', async () => {
    const h = mountHarness()
    startTurn(h)
    expect(typingShown(h)).toBe(true)
    await priv(h).handleClose()
    expect(priv(h).serverTypingActive).toBe(0)
    expect(typingShown(h)).toBe(false)
  })
})
