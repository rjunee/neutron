/**
 * 2026-05-28 sprint — button visual styling pinned via DOM + CSS source.
 *
 * Sam walkthrough 2026-05-28: the legacy `.buttons button` rendered
 * indistinguishable from `.bubble` (neutral surface + neutral border)
 * which made the affordance illegible. The new style is an
 * accent-tinted gradient + accent-tinted border (Telegram inline
 * keyboard model). Visual regression is best caught by an E2E
 * screenshot diff; this file pins the DOM contract + the relevant CSS
 * rules in chat.html so a refactor can't silently regress the styling.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

function mountHarness(): {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
} {
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
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-05-28T12:00:00Z'),
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

describe('chat button — DOM + class contract', () => {
  test('button lives inside `.buttons`, not inside a `.bubble`', () => {
    // The pre-fix problem was VISUAL: buttons looked exactly like
    // chat bubbles. Structurally they were already separate (`.buttons`
    // grid, not `.bubble`), so the regression risk is in CSS. This test
    // pins the structural separation so a future refactor doesn't fuse
    // them into the bubble element.
    const h = mountHarness()
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'p-vis-1',
      options: [
        { label: 'A', body: 'Yes', value: 'yes' },
        { label: 'B', body: 'No', value: 'no' },
      ],
    })
    const grid = h.log.querySelector('.buttons') as HTMLElement
    expect(grid).not.toBeNull()
    const btn = grid.querySelector('button')!
    // The button's closest .bubble must be the prompt-body bubble, but
    // the button itself is NOT inside any .bubble element.
    expect(btn.closest('.bubble')).toBeNull()
  })

  test('button is a real <button> element (not a styled div)', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick:', {
      prompt_id: 'p-vis-2',
      options: [{ label: 'A', body: 'Yes', value: 'yes' }],
    })
    const btn = h.log.querySelector('.buttons > button')
    expect(btn).not.toBeNull()
    expect(btn!.tagName).toBe('BUTTON')
    expect((btn as HTMLButtonElement).type).toBe('button')
  })
})

describe('chat button — CSS contract (chat.html source)', () => {
  // The CSS lives inline in landing/chat.html. We read the source and
  // assert the key rules survive — a regression here would re-introduce
  // the "buttons look like chat bubbles" visual bug.
  const html = readFileSync(join(import.meta.dir, '..', 'chat.html'), 'utf8')

  test('`.buttons` is a CSS grid (not flex column)', () => {
    expect(html).toMatch(/\.buttons\s*\{[^}]*display:\s*grid/)
    // The legacy flex-direction: column on .buttons would render every
    // option in a tall vertical stack — defeats the Telegram-style
    // grid the 2026-05-28 sprint introduced.
    const buttonsBlock = html.match(/\.buttons\s*\{[^}]*\}/)?.[0] ?? ''
    expect(buttonsBlock).not.toMatch(/flex-direction:\s*column/)
  })

  test('`.buttons.cols-2` + `.buttons.cols-3` modifiers exist', () => {
    expect(html).toMatch(/\.buttons\.cols-2\s*\{[^}]*grid-template-columns:\s*repeat\(2/)
    expect(html).toMatch(/\.buttons\.cols-3\s*\{[^}]*grid-template-columns:\s*repeat\(3/)
  })

  test('`.buttons button` has accent-tinted background gradient', () => {
    // The accent is `#6cf` (RGB 108, 204, 255). The button background
    // is a linear-gradient over that RGB — distinct from the neutral
    // chat-bubble surface (`var(--surface)` / `#16181d`).
    const btnBlock = html.match(/\.buttons button\s*\{[^}]*\}/)?.[0] ?? ''
    expect(btnBlock).toMatch(/background:\s*linear-gradient[^;]*rgba\(108,\s*204,\s*255/)
  })

  test('`.buttons button` has accent-tinted border (not neutral border)', () => {
    const btnBlock = html.match(/\.buttons button\s*\{[^}]*\}/)?.[0] ?? ''
    // border accent uses rgba(108, 204, 255, ...) — NOT var(--border).
    expect(btnBlock).toMatch(/border:\s*1px\s+solid\s+rgba\(108,\s*204,\s*255/)
    expect(btnBlock).not.toMatch(/border:\s*1px\s+solid\s+var\(--border\)/)
  })

  test('`.buttons button` has bolder weight than body copy (≥ 500)', () => {
    const btnBlock = html.match(/\.buttons button\s*\{[^}]*\}/)?.[0] ?? ''
    const fontMatch = btnBlock.match(/font:\s*(\d+)/)
    expect(fontMatch).not.toBeNull()
    const weight = Number(fontMatch![1])
    expect(weight).toBeGreaterThanOrEqual(500)
  })

  test('`.buttons button` centers text (Telegram inline keyboard model)', () => {
    const btnBlock = html.match(/\.buttons button\s*\{[^}]*\}/)?.[0] ?? ''
    expect(btnBlock).toMatch(/text-align:\s*center/)
    // The pre-fix `text-align: left` made buttons look like list rows
    // / bubbles. Centered text reads as a tap target.
    expect(btnBlock).not.toMatch(/text-align:\s*left/)
  })

  test('`.buttons button:hover` brightens the background (affordance feedback)', () => {
    const hoverBlock = html.match(/\.buttons button:hover[^{]*\{[^}]*\}/)?.[0] ?? ''
    expect(hoverBlock).toMatch(/background:\s*linear-gradient/)
  })

  test('consumed/picked state preserves the accent vocabulary', () => {
    const consumedBlock =
      html.match(/\.buttons\.consumed button\.picked\s*\{[^}]*\}/)?.[0] ?? ''
    expect(consumedBlock).toMatch(/border-color:\s*var\(--accent\)/)
    expect(consumedBlock).toMatch(/background:\s*rgba\(108,\s*204,\s*255/)
  })
})
