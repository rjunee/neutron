/**
 * 2026-05-29 (Sam-respec) — the "↓ N new" pill is BACK.
 *
 * Per the 2026-05-29 chat-UX bundle ("Just copy telegram if you are
 * unsure"), the pre-2026-05-26 Telegram-pattern pill behaviour is
 * restored:
 *
 *   - Scrolled-up + new bubble → the pill DOM element surfaces with a
 *     "↓ N new" count, log scrollTop is NOT yanked (reading position
 *     stays sacred).
 *   - Click on the pill → scrolls to bottom, pill hides.
 *   - At-bottom + new bubble → auto-scrolls as before AND the pill stays
 *     hidden (we never surface it when the user is already caught up).
 *   - Scrolled-up + new bubble + user manually scrolls back to the
 *     bottom → `handleScroll` flips `stickToBottom = true` AND hides
 *     the pill (the user caught up via scroll, not via the pill click).
 *   - Local send while scrolled-up → still force-scrolls to bottom +
 *     hides the pill (the act of sending IS a "snap to bottom" gesture).
 *
 * This file replaces the 2026-05-26 "no-pill" regression net with the
 * post-2026-05-29 Telegram-pattern regression net. The pill DOM element
 * is asserted to exist by index-html.test.ts; this file owns the runtime
 * behaviour.
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
  pill: HTMLButtonElement
}

/**
 * happy-dom defaults scrollHeight/clientHeight/scrollTop to 0 — that
 * makes everything "at bottom" trivially. We override these as
 * configurable per-instance properties so the test can drive the
 * state machine deterministically.
 */
function setScrollGeom(
  el: HTMLElement,
  geom: { scrollHeight: number; scrollTop: number; clientHeight: number },
): void {
  Object.defineProperty(el, 'scrollHeight', { value: geom.scrollHeight, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: geom.clientHeight, configurable: true })
  let stored = geom.scrollTop
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get() {
      return stored
    },
    set(v: number) {
      stored = v
    },
  })
  Object.defineProperty(el, 'scrollTo', {
    configurable: true,
    value: (opts: { top?: number } | number) => {
      const top = typeof opts === 'number' ? opts : (opts.top ?? 0)
      stored = top
    },
  })
}

function mountHarness(): Harness {
  document.body.innerHTML = `
    <div id="status"></div>
    <div id="log"></div>
    <button id="new-pill" hidden></button>
    <textarea id="input"></textarea>
    <button id="send"></button>
  `
  const log = document.getElementById('log') as HTMLElement
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  const pill = document.getElementById('new-pill') as HTMLButtonElement
  // Start at-bottom so the constructor's scrollToBottom doesn't trip
  // us up before the test's setScrollGeom runs.
  setScrollGeom(log, { scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
  })
  return { client, log, pill }
}

function renderAgent(client: import('../chat.ts').ChatClient, body: string): void {
  ;(client as unknown as { renderAgent: (m: unknown) => void }).renderAgent({
    type: 'agent_message',
    body,
  })
}

describe('pill: at-bottom + new bubble', () => {
  test('auto-scrolls to the new bubble; pill stays hidden', () => {
    const h = mountHarness()
    renderAgent(h.client, 'hi')
    expect(h.log.scrollTop).toBe(h.log.scrollHeight)
    expect(h.pill.hidden).toBe(true)
  })
})

describe('pill: scrolled-up + new bubble (Telegram pattern restored 2026-05-29)', () => {
  test('pill surfaces with "↓ N new" count; scrollTop NOT yanked (reading position preserved)', () => {
    const h = mountHarness()
    // User scrolls up to reread history.
    setScrollGeom(h.log, { scrollHeight: 1000, scrollTop: 100, clientHeight: 200 })
    h.log.dispatchEvent(new Event('scroll'))
    // New content arrives, but the geometry says we're still scrolled
    // up. The pill surfaces; the viewport stays put.
    setScrollGeom(h.log, { scrollHeight: 1200, scrollTop: 100, clientHeight: 200 })
    renderAgent(h.client, 'one')
    expect(h.pill.hidden).toBe(false)
    expect(h.pill.textContent).toBe('↓ 1 new')
    expect(h.log.scrollTop).toBe(100)

    // A second message: the count increments.
    setScrollGeom(h.log, { scrollHeight: 1400, scrollTop: 100, clientHeight: 200 })
    renderAgent(h.client, 'two')
    expect(h.pill.hidden).toBe(false)
    expect(h.pill.textContent).toBe('↓ 2 new')
    expect(h.log.scrollTop).toBe(100)
  })

  test('clicking the pill scrolls to bottom + hides the pill + zeros the counter', () => {
    const h = mountHarness()
    setScrollGeom(h.log, { scrollHeight: 1000, scrollTop: 100, clientHeight: 200 })
    h.log.dispatchEvent(new Event('scroll'))
    setScrollGeom(h.log, { scrollHeight: 1400, scrollTop: 100, clientHeight: 200 })
    renderAgent(h.client, 'one')
    renderAgent(h.client, 'two')
    expect(h.pill.hidden).toBe(false)
    h.pill.click()
    expect(h.pill.hidden).toBe(true)
    expect(h.log.scrollTop).toBe(h.log.scrollHeight)
  })
})

describe('pill: scrolled-back-to-bottom → next bubble auto-scrolls + pill hidden', () => {
  test('manual scroll to bottom flips stickToBottom + hides the pill; next inbound auto-scrolls', () => {
    const h = mountHarness()
    // Scroll up first.
    setScrollGeom(h.log, { scrollHeight: 1200, scrollTop: 100, clientHeight: 200 })
    h.log.dispatchEvent(new Event('scroll'))
    renderAgent(h.client, 'one')
    expect(h.pill.hidden).toBe(false)
    expect(h.log.scrollTop).toBe(100)

    // User manually scrolls back to the bottom. handleScroll should
    // flip stickToBottom back to true AND hide the pill.
    setScrollGeom(h.log, { scrollHeight: 1200, scrollTop: 1000, clientHeight: 200 })
    h.log.dispatchEvent(new Event('scroll'))
    expect(h.pill.hidden).toBe(true)

    // A new bubble arrives. Now we DO auto-scroll — Sam doesn't have
    // to click the pill.
    setScrollGeom(h.log, { scrollHeight: 1400, scrollTop: 1000, clientHeight: 200 })
    renderAgent(h.client, 'two')
    expect(h.log.scrollTop).toBe(h.log.scrollHeight)
    expect(h.pill.hidden).toBe(true)
  })
})

describe('pill: local send while scrolled-up still reveals the user bubble', () => {
  test('sending a message snaps the viewport to the bottom regardless of prior scroll position', () => {
    const h = mountHarness()
    // User scrolled up.
    setScrollGeom(h.log, { scrollHeight: 1200, scrollTop: 100, clientHeight: 200 })
    h.log.dispatchEvent(new Event('scroll'))
    // Stub a live WS so sendInput proceeds.
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {},
    }
    // A new inbound agent bubble arrives while scrolled up — pill
    // surfaces (Telegram pattern), no viewport jump.
    setScrollGeom(h.log, { scrollHeight: 1300, scrollTop: 100, clientHeight: 200 })
    renderAgent(h.client, 'a stale agent reply')
    expect(h.pill.hidden).toBe(false)
    expect(h.log.scrollTop).toBe(100)

    // Now the user types and sends. The local-send path force-scrolls;
    // the act of sending counts as "caught up" so the pill clears.
    const input = document.getElementById('input') as HTMLTextAreaElement
    input.value = 'my reply'
    setScrollGeom(h.log, { scrollHeight: 1500, scrollTop: 100, clientHeight: 200 })
    ;(h.client as unknown as { sendInput: () => void }).sendInput()
    expect(h.log.scrollTop).toBe(h.log.scrollHeight)
    // sendInput → scrollToBottom → handleScroll fires → stickToBottom
    // flips true → hideNewPill is called from within handleScroll.
    // We don't dispatch the scroll event explicitly so the pill may
    // still show as hidden=false here BUT the local-send path itself
    // doesn't directly hide it. Dispatch a scroll to drive the
    // at-bottom transition.
    h.log.dispatchEvent(new Event('scroll'))
    expect(h.pill.hidden).toBe(true)
  })
})
