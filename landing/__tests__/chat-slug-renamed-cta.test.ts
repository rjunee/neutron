/**
 * 2026-06-05 (click-button slug-rename) — `handleSlugRenamed` renders an
 * explicit "Open your agent →" CTA button instead of auto-navigating.
 *
 * Sam's call after another real signup failed: "show a big button on the
 * screen saying click here to login to your new agent, and then on that
 * click take them to the new URL." The auto-redirect kept losing a race
 * (the slug rename's Caddy work tears down the live WS before the navigate
 * envelope arrives / the host is ready). A user click is a deterministic
 * cross-host navigation — the human delay covers route + TLS readiness.
 *
 * Asserts:
 *   - the envelope renders a button (NO immediate navigation)
 *   - clicking the button navigates to https://<new_host>/chat?start=<token>
 *   - a duplicate envelope (reconnect-replay) does NOT render a 2nd card
 *   - after the CTA renders, a WS close does NOT auto-reload (Argus r2 P1):
 *     the rename drops the live socket, so a `close` is EXPECTED — we must
 *     wait for the user's explicit click, never `location.replace('/chat')`
 *     (which THIS PR's pending-redirect would 302 to the cold new host).
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
  status: HTMLElement
  now: { value: number }
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
  const now = { value: Date.parse('2026-06-05T12:00:00Z') }
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => now.value,
  })
  return { client, log, status, now }
}

/** Capture window.location.assign / replace WITHOUT actually navigating. */
function stubNavigation(): { assigned: string[]; replaced: string[] } {
  const assigned: string[] = []
  const replaced: string[] = []
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: 'https://t-test.neutron.test/chat',
      protocol: 'https:',
      pathname: '/chat',
      search: '',
      host: 't-test.neutron.test',
      assign: (url: string) => assigned.push(url),
      replace: (url: string) => replaced.push(url),
    },
  })
  return { assigned, replaced }
}

function dispatchSlugRenamed(
  client: import('../chat.ts').ChatClient,
  msg: { new_slug: string; new_host: string; new_token: string },
): void {
  const c = client as unknown as { handleSlugRenamed: (m: unknown) => void }
  c.handleSlugRenamed({ type: 'slug_renamed', ...msg })
}

describe('handleSlugRenamed — click-button CTA', () => {
  test('renders an "Open your agent →" button and does NOT auto-navigate', () => {
    const h = mountHarness()
    const nav = stubNavigation()
    dispatchSlugRenamed(h.client, {
      new_slug: 'zen',
      new_host: 'zen.neutron.example',
      new_token: 'tok-zen',
    })
    // A CTA card rendered with a button.
    const btn = h.log.querySelector('button.slug-ready-open') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toBe('Open your agent →')
    // The bubble names the destination host.
    const bubble = h.log.querySelector('.bubble')
    expect(bubble?.textContent ?? '').toContain('zen.neutron.example')
    // Crucially: NO navigation happened on render (the whole point of the
    // button model — never a spinner, never a lost race).
    expect(nav.assigned).toHaveLength(0)
    expect(nav.replaced).toHaveLength(0)
  })

  test('clicking the button navigates to https://<new_host>/chat?start=<token>', () => {
    const h = mountHarness()
    const nav = stubNavigation()
    dispatchSlugRenamed(h.client, {
      new_slug: 'zen',
      new_host: 'zen.neutron.example',
      new_token: 'tok-zen-abc',
    })
    const btn = h.log.querySelector('button.slug-ready-open') as HTMLButtonElement
    btn.click()
    expect(nav.assigned).toHaveLength(1)
    expect(nav.assigned[0]).toBe(
      'https://zen.neutron.example/chat?start=tok-zen-abc',
    )
    // Button consumed (disabled) so a double-tap can't double-navigate.
    expect(btn.disabled).toBe(true)
  })

  test('a duplicate envelope (reconnect-replay) does NOT render a second CTA card', () => {
    const h = mountHarness()
    stubNavigation()
    const payload = {
      new_slug: 'zen',
      new_host: 'zen.neutron.example',
      new_token: 'tok-zen',
    }
    dispatchSlugRenamed(h.client, payload)
    dispatchSlugRenamed(h.client, payload)
    const buttons = h.log.querySelectorAll('button.slug-ready-open')
    expect(buttons.length).toBe(1)
  })

  test('after the CTA renders, a WS close does NOT auto-reload (CTA stays, user click is the only nav)', async () => {
    const h = mountHarness()
    const nav = stubNavigation()
    try {
      localStorage.clear()
    } catch {
      // happy-dom always provides it; be defensive.
    }
    dispatchSlugRenamed(h.client, {
      new_slug: 'zen',
      new_host: 'zen.neutron.example',
      new_token: 'tok-zen',
    })
    // Sanity: the CTA is present before the close fires.
    expect(h.log.querySelector('button.slug-ready-open')).not.toBeNull()

    // The slug rename's route flip drops the live socket → a `close` fires.
    // Pre-fix, handleClose would `location.replace('/chat')`, which THIS PR's
    // unconditional pending-redirect would 302 to the (cold) new host BEFORE
    // the user clicks — the exact race the button exists to kill.
    const c = h.client as unknown as { handleClose: () => Promise<void> }
    await c.handleClose()

    // No auto-navigation of any kind.
    expect(nav.replaced).toHaveLength(0)
    expect(nav.assigned).toHaveLength(0)
    // The CTA is still on screen, waiting for the explicit click.
    const btn = h.log.querySelector('button.slug-ready-open') as HTMLButtonElement | null
    expect(btn).not.toBeNull()
    expect(btn!.disabled).toBe(false)

    // And the explicit click is still the (only) path that navigates.
    btn!.click()
    expect(nav.assigned).toEqual(['https://zen.neutron.example/chat?start=tok-zen'])
  })
})
