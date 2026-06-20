/**
 * ISSUES #116 — the live chat bubble renders agent markdown (not raw
 * `**` markers), while user bubbles stay literal plain text.
 *
 * This pins the `appendBubble` wiring end-to-end through `renderAgent` /
 * the user-send path, complementing the pure-function coverage in
 * markdown.test.ts. The defect Sam hit: an agent reply containing
 * `**agent name**` showed the literal asterisks in the bubble.
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

function mount(): { client: import('../chat.ts').ChatClient; log: HTMLElement } {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap"><div id="log"></div><button id="new-pill" hidden></button></div>
    <footer><textarea id="input"></textarea><button id="send"></button></footer>
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
  return { client, log }
}

function renderAgent(client: import('../chat.ts').ChatClient, body: string): void {
  ;(client as unknown as { renderAgent: (m: unknown) => void }).renderAgent({
    type: 'agent_message',
    body,
  })
}

describe('ISSUES #116 — agent bubble renders markdown', () => {
  test('the Sam-signup defect: **agent name** renders <strong>, no literal **', () => {
    const { client, log } = mount()
    renderAgent(client, "Here's your **agent name** — keep it?")
    const bubble = log.querySelector('.run-agent .bubble.md') as HTMLElement
    expect(bubble).not.toBeNull()
    expect(bubble.querySelector('strong')?.textContent).toBe('agent name')
    expect(bubble.innerHTML).not.toContain('**')
    // textContent still reads naturally (markers stripped, text intact).
    expect(bubble.textContent).toBe("Here's your agent name — keep it?")
  })

  test('inline code + list render as <code> and <ul><li>', () => {
    const { client, log } = mount()
    renderAgent(client, 'Try:\n- run `bun test`\n- ship it')
    const bubble = log.querySelector('.run-agent .bubble.md') as HTMLElement
    expect(bubble.querySelector('code')?.textContent).toBe('bun test')
    expect(bubble.querySelectorAll('ul li')).toHaveLength(2)
  })

  test('an injected tag in agent output is inert (escaped, not a real node)', () => {
    const { client, log } = mount()
    renderAgent(client, 'hello <img src=x onerror=alert(1)> world')
    const bubble = log.querySelector('.run-agent .bubble.md') as HTMLElement
    expect(bubble.querySelector('img')).toBeNull()
    expect(bubble.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('ISSUES #116 — user bubble stays literal', () => {
  test('a user typing ** sees their own literal characters, no formatting', () => {
    const { client, log } = mount()
    ;(client as unknown as { inFlight: boolean }).inFlight = false
    const input = document.getElementById('input') as HTMLTextAreaElement
    input.value = 'why **two stars**?'
    ;(client as unknown as { sendInput: () => void }).sendInput()
    const bubble = log.querySelector('.run-user .bubble') as HTMLElement
    expect(bubble).not.toBeNull()
    expect(bubble.classList.contains('md')).toBe(false)
    expect(bubble.querySelector('strong')).toBeNull()
    expect(bubble.textContent).toBe('why **two stars**?')
  })
})
