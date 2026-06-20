/**
 * Item 15 (2026-06-19, owner live-dogfood) — cross-project message bleed.
 *
 * "When new chat responses come in for another project, they incorrectly
 * display in whatever project is currently in focus; switching to another
 * project and back fixes it." A slow (cold) reply for topic A can arrive
 * over the single socket AFTER the user switched to topic B; the client
 * used to paint it into the focused view. The live-agent reply now stamps
 * `topic_id`, and renderAgent drops a paint whose topic_id differs from the
 * focused topic (it hydrates from history on switch). Onboarding prompts
 * (no topic_id) and the initial General view (no focused topic_id) always
 * render.
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

function mountClient(focusedTopicId?: string): {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
} {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap"><div id="log"></div><button id="new-pill" hidden></button></div>
    <footer><textarea id="input"></textarea><button id="send"></button></footer>
  `
  const log = document.getElementById('log') as HTMLElement
  const opts: Record<string, unknown> = {
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status: document.getElementById('status') as HTMLElement,
    input: document.getElementById('input') as HTMLTextAreaElement,
    sendBtn: document.getElementById('send') as HTMLButtonElement,
    now: () => Date.parse('2026-06-19T12:00:00Z'),
  }
  if (focusedTopicId !== undefined) opts['topic_id'] = focusedTopicId
  const client = new mod.ChatClient(opts as never)
  ;(client as unknown as { clearSetupIndicator: () => void }).clearSetupIndicator()
  return { client, log }
}

function render(client: import('../chat.ts').ChatClient, msg: Record<string, unknown>): void {
  ;(client as unknown as { renderAgent: (m: unknown) => void }).renderAgent({
    type: 'agent_message',
    ...msg,
  })
}

describe('renderAgent — cross-topic routing (Item 15)', () => {
  test('a reply for ANOTHER topic is NOT painted into the focused topic', () => {
    const { client, log } = mountClient('proj-B')
    render(client, { body: 'answer for project A', topic_id: 'proj-A' })
    expect(log.textContent ?? '').not.toContain('answer for project A')
  })

  test('a reply for the FOCUSED topic IS painted', () => {
    const { client, log } = mountClient('proj-B')
    render(client, { body: 'answer for project B', topic_id: 'proj-B' })
    expect(log.textContent ?? '').toContain('answer for project B')
  })

  test('a message with NO topic_id always renders (onboarding back-compat)', () => {
    const { client, log } = mountClient('proj-B')
    render(client, { body: 'onboarding prompt body' })
    expect(log.textContent ?? '').toContain('onboarding prompt body')
  })

  test('initial General view (no focused topic_id) renders everything', () => {
    const { client, log } = mountClient(undefined)
    render(client, { body: 'general reply', topic_id: 'web:u-1' })
    expect(log.textContent ?? '').toContain('general reply')
  })
})
