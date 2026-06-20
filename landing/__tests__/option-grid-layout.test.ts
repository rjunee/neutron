/**
 * 2026-05-28 sprint — chat button grid layout (Telegram model).
 *
 * The longest option's label drives the column count:
 *   maxLen ≤ 12          → 3 columns
 *   12 < maxLen ≤ 24     → 2 columns
 *   maxLen > 24          → 1 column
 *
 * The decision lives in chat.ts's renderAgent branch; this test exercises
 * the full path via the same harness chat-rendering.test.ts uses so the
 * DOM contract (class names + structure) is pinned.
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
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  const now = { value: Date.parse('2026-05-28T12:00:00Z') }
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => now.value,
  })
  return { client, log }
}

function renderAgent(
  client: import('../chat.ts').ChatClient,
  body: string,
  options: { prompt_id: string; options: { label: string; body: string; value: string }[] },
): void {
  const c = client as unknown as { renderAgent: (m: unknown) => void }
  c.renderAgent({ type: 'agent_message', body, ...options })
}

describe('chat button grid — column count by max label length', () => {
  test('3 short labels (≤ 12 chars each) → grid is 3 columns', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'short-1',
      options: [
        { label: 'A', body: 'Yes', value: 'yes' },
        { label: 'B', body: 'No', value: 'no' },
        { label: 'C', body: 'Skip', value: 'skip' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid).not.toBeNull()
    expect(grid.classList.contains('cols-3')).toBe(true)
    expect(grid.classList.contains('cols-2')).toBe(false)
    expect(grid.classList.contains('cols-1')).toBe(false)
  })

  test('boundary: label exactly 12 chars stays in cols-3', () => {
    const h = mountHarness()
    const label12 = 'abcdefghijkl' // 12 chars
    expect(label12.length).toBe(12)
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'boundary-12',
      options: [
        { label: 'A', body: label12, value: 'a' },
        { label: 'B', body: 'Ok', value: 'b' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid.classList.contains('cols-3')).toBe(true)
  })

  test('boundary: a 13-char label drops to cols-2', () => {
    const h = mountHarness()
    const label13 = 'abcdefghijklm' // 13 chars
    expect(label13.length).toBe(13)
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'boundary-13',
      options: [
        { label: 'A', body: label13, value: 'a' },
        { label: 'B', body: 'Ok', value: 'b' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid.classList.contains('cols-2')).toBe(true)
    expect(grid.classList.contains('cols-3')).toBe(false)
  })

  test('medium labels (one between 13–24 chars) → grid is 2 columns', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'medium-1',
      options: [
        { label: 'A', body: 'Keep all of these', value: 'keep' },
        { label: 'B', body: 'Drop one', value: 'drop' },
        { label: 'C', body: 'Skip', value: 'skip' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid).not.toBeNull()
    expect(grid.classList.contains('cols-2')).toBe(true)
    expect(grid.classList.contains('cols-1')).toBe(false)
    expect(grid.classList.contains('cols-3')).toBe(false)
  })

  test('boundary: label exactly 24 chars stays in cols-2', () => {
    const h = mountHarness()
    const label24 = 'abcdefghijklmnopqrstuvwx' // 24 chars
    expect(label24.length).toBe(24)
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'boundary-24',
      options: [
        { label: 'A', body: label24, value: 'a' },
        { label: 'B', body: 'Ok', value: 'b' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid.classList.contains('cols-2')).toBe(true)
  })

  test('boundary: a 25-char label collapses to cols-1', () => {
    const h = mountHarness()
    const label25 = 'abcdefghijklmnopqrstuvwxy' // 25 chars
    expect(label25.length).toBe(25)
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'boundary-25',
      options: [
        { label: 'A', body: label25, value: 'a' },
        { label: 'B', body: 'Ok', value: 'b' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid.classList.contains('cols-1')).toBe(true)
    expect(grid.classList.contains('cols-2')).toBe(false)
  })

  test('long labels (one > 24 chars) → grid collapses to 1 column', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'long-1',
      options: [
        { label: 'A', body: 'Show me curated archetype suggestions', value: 'show' },
        { label: 'B', body: 'Skip archetypes for now', value: 'skip' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid).not.toBeNull()
    expect(grid.classList.contains('cols-1')).toBe(true)
    expect(grid.classList.contains('cols-2')).toBe(false)
    expect(grid.classList.contains('cols-3')).toBe(false)
  })

  test('mixed lengths: longest wins (one long + two short → cols-1)', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'mixed-1',
      options: [
        { label: 'A', body: 'Yes', value: 'yes' },
        { label: 'B', body: 'No', value: 'no' },
        { label: 'C', body: 'I would like to think about this longer', value: 'wait' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid.classList.contains('cols-1')).toBe(true)
  })

  test('single option is still rendered (cols-3 for a short label)', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Confirm:', {
      prompt_id: 'single-1',
      options: [{ label: 'A', body: 'Good to go', value: 'confirm' }],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid).not.toBeNull()
    expect(grid.classList.contains('cols-3')).toBe(true)
    expect(grid.querySelectorAll('button').length).toBe(1)
  })

  test('image-gallery prompts keep the gallery class and do NOT get a cols-N class', () => {
    const h = mountHarness()
    const c = h.client as unknown as { renderAgent: (m: unknown) => void }
    c.renderAgent({
      type: 'agent_message',
      body: 'Pick a portrait:',
      prompt_id: 'gallery-1',
      kind: 'image-gallery',
      options: [
        { label: '1', body: 'Smile', value: 'a', image_url: '/profile-pic/candidate/a.png' },
        { label: '2', body: 'Wave', value: 'b', image_url: '/profile-pic/candidate/b.png' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid).not.toBeNull()
    expect(grid.classList.contains('image-gallery')).toBe(true)
    expect(grid.classList.contains('cols-1')).toBe(false)
    expect(grid.classList.contains('cols-2')).toBe(false)
    expect(grid.classList.contains('cols-3')).toBe(false)
  })
})
