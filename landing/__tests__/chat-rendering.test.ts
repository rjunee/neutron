/**
 * DOM rendering tests for ChatClient.
 *
 * Asserts the structure of the rendered conversation under happy-dom:
 *   - empty state: no .run elements
 *   - single-agent run: one .run.run-agent with avatar + .bubble.tail + .ts
 *   - single-user run: one .run.run-user (no avatar) + .bubble.tail + .ts
 *   - sender-switching A/U/A: three runs, each with their own tail + ts
 *   - same-sender consecutive: one run with two bubbles, only the last is .tail
 *   - button prompt: in-stream <div class="buttons"> with full-width buttons
 *   - button picked: grid gets `consumed` class, all buttons disabled, picked
 *     button gets `picked` class
 *   - image-gallery prompt: <div class="buttons image-gallery"> grid preserved
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  // Register the happy-dom globals BEFORE we import chat.ts so the
  // `typeof window === 'undefined'` self-bootstrap guard doesn't fire
  // a real connect() at import time.
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// Dynamic import AFTER GlobalRegistrator.register so the chat.ts
// auto-boot-on-load doesn't see a real `document.readyState === 'complete'`.
let mod: typeof import('../chat.ts')

beforeAll(async () => {
  // Ensure the document is in a 'loading' state so the bottom-of-file
  // guard doesn't immediately call bootChatFromQueryString().
  // happy-dom defaults to 'complete'; we override the readonly property
  // by going through the prototype.
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  // Stub WebSocket so connect() doesn't reach for the network.
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
  input: HTMLTextAreaElement
  sendBtn: HTMLButtonElement
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
  const now = { value: Date.parse('2026-05-09T12:00:00Z') }
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => now.value,
  })
  // 2026-06-18 (Bug 1) — clear the first-load "Setting things up…" loader. While
  // up it owns the screen and suppresses the optimistic typing dots (the sole
  // first-load liveness signal until the welcome paints), which would otherwise
  // drop the post-send typing run these mechanics tests assert. The "no .run at
  // mount" / "single run" assertions are unaffected (the loader is not a .run).
  // First-load loader behaviour lives in chat-setup-indicator.test.ts.
  ;(client as unknown as { clearSetupIndicator: () => void }).clearSetupIndicator()
  return { client, log, status, input, sendBtn, now }
}

// ChatClient's renderAgent and sendInput are private; test through the
// behavior they trigger by stubbing the WebSocket message dispatch.
function renderAgent(client: import('../chat.ts').ChatClient, body: string, options?: {
  prompt_id?: string
  options?: { label: string; body: string; value: string; image_url?: string }[]
  kind?: 'buttons' | 'image-gallery'
  allow_freeform?: boolean
}): void {
  // We exploit the fact that `connect()` wires a 'message' listener.
  // Easier: dispatch through a fake WS that captures the listener.
  // Simpler still — the class is JS-private (#field syntax not used),
  // so we cast to any and call renderAgent directly.
  const c = client as unknown as { renderAgent: (m: unknown) => void }
  c.renderAgent({ type: 'agent_message', body, ...options })
}

function typeAndSend(h: Harness, body: string): void {
  h.input.value = body
  ;(h.client as unknown as { sendInput: () => void }).sendInput()
}

describe('ChatClient rendering — empty state', () => {
  test('no .run elements at mount time', () => {
    const h = mountHarness()
    expect(h.log.querySelectorAll('.run').length).toBe(0)
  })
})

describe('ChatClient rendering — single agent message', () => {
  test('opens a .run.run-agent with avatar + tail bubble + timestamp', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Hello there')
    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(1)
    const run = runs[0]!
    expect(run.classList.contains('run-agent')).toBe(true)
    expect(run.querySelector('.avatar')).not.toBeNull()
    const bubbles = run.querySelectorAll('.bubble')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0]!.classList.contains('tail')).toBe(true)
    expect(bubbles[0]!.textContent).toBe('Hello there')
    const ts = run.querySelector('.ts')
    expect(ts).not.toBeNull()
    expect(ts!.textContent).toBe('now')
  })
})

describe('ChatClient rendering — single user message', () => {
  test('opens a .run.run-user with NO avatar + tail bubble + timestamp', () => {
    const h = mountHarness()
    // Stub WS into OPEN so sendInput proceeds.
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {},
    }
    typeAndSend(h, 'Hi back')
    const runs = h.log.querySelectorAll('.run')
    // 2026-05-13 — sendInput now ALSO inserts an optimistic typing
    // bubble in a fresh agent run AFTER the user message so the
    // 2-3s engine.advance + LLM gap doesn't look like the page froze.
    // The user run is still the first one; the typing run is second.
    expect(runs.length).toBe(2)
    const run = runs[0]!
    expect(run.classList.contains('run-user')).toBe(true)
    expect(run.querySelector('.avatar')).toBeNull()
    const bubbles = run.querySelectorAll('.bubble')
    expect(bubbles.length).toBe(1)
    expect(bubbles[0]!.classList.contains('tail')).toBe(true)
    expect(bubbles[0]!.textContent).toBe('Hi back')
    expect(runs[1]!.classList.contains('run-agent')).toBe(true)
    expect(runs[1]!.querySelector('.bubble.typing')).not.toBeNull()
  })
})

describe('ChatClient rendering — sender switching A/U/A', () => {
  test('produces three independent runs', () => {
    const h = mountHarness()
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {},
    }
    renderAgent(h.client, 'one')
    typeAndSend(h, 'two')
    renderAgent(h.client, 'three')
    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(3)
    expect(runs[0]!.classList.contains('run-agent')).toBe(true)
    expect(runs[1]!.classList.contains('run-user')).toBe(true)
    expect(runs[2]!.classList.contains('run-agent')).toBe(true)
    // Each run has a tail bubble + timestamp.
    Array.from(runs).forEach((run) => {
      expect(run.querySelector('.bubble.tail')).not.toBeNull()
      expect(run.querySelector(':scope > .ts')).not.toBeNull()
    })
  })
})

describe('ChatClient rendering — same-sender consecutive messages', () => {
  test('two agent messages collapse into one run with one tail bubble', () => {
    const h = mountHarness()
    renderAgent(h.client, 'first')
    renderAgent(h.client, 'second')
    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(1)
    const bubbles = runs[0]!.querySelectorAll('.bubble')
    expect(bubbles.length).toBe(2)
    // Only the LAST bubble in the run carries the tail.
    expect(bubbles[0]!.classList.contains('tail')).toBe(false)
    expect(bubbles[1]!.classList.contains('tail')).toBe(true)
    // The single timestamp lives at the end of the run.
    const tsList = runs[0]!.querySelectorAll(':scope > .ts')
    expect(tsList.length).toBe(1)
  })
})

describe('ChatClient rendering — button prompts in-stream', () => {
  test('vertical full-width buttons appear inside the agent run', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick one:', {
      prompt_id: 'p-1',
      options: [
        { label: 'A', body: 'Apple', value: 'apple' },
        { label: 'B', body: 'Banana', value: 'banana' },
      ],
    })
    const run = h.log.querySelector('.run.run-agent')!
    const buttons = run.querySelector('.buttons')!
    expect(buttons).not.toBeNull()
    expect(buttons.classList.contains('image-gallery')).toBe(false)
    const btnEls = buttons.querySelectorAll('button')
    expect(btnEls.length).toBe(2)
    expect(btnEls[0]!.textContent).toContain('Apple')
    expect(btnEls[1]!.textContent).toContain('Banana')
    // Buttons live inside the run, NOT as a sibling fixed panel.
    expect(buttons.parentElement === run).toBe(true)
  })

  // Issue 1 (2026-05-09 chat-UX): the visual button block IS the
  // affordance — drop the "A — " / "B — " letter-prefix legend on
  // every multi-choice phase. Telegram still renders the legend in
  // its body text via render-button-prompt.ts; web /chat doesn't need it.
  test('button text is the body only — no "A — " / "B — " letter prefix', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick one:', {
      prompt_id: 'p-1',
      options: [
        { label: 'A', body: 'Apple', value: 'apple' },
        { label: 'B', body: 'Banana', value: 'banana' },
        { label: 'C', body: 'Cherry', value: 'cherry' },
      ],
    })
    const btnEls = h.log.querySelectorAll('.buttons > button')
    expect(btnEls.length).toBe(3)
    expect(btnEls[0]!.textContent).toBe('Apple')
    expect(btnEls[1]!.textContent).toBe('Banana')
    expect(btnEls[2]!.textContent).toBe('Cherry')
    // Defensive: no rendered button starts with the letter+em-dash prefix.
    Array.from(btnEls).forEach((b) => {
      expect(b.textContent ?? '').not.toMatch(/^[A-Z] — /)
    })
  })

  // Image-gallery captions follow the same rule — caption is the
  // body text only, not "1 — Smile" / "2 — Wave".
  test('image-gallery caption text is the body only — no letter prefix', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick a portrait:', {
      prompt_id: 'pic-1',
      kind: 'image-gallery',
      options: [
        { label: '1', body: 'Smile', value: 'a', image_url: '/profile-pic/candidate/a.png' },
        { label: '2', body: 'Wave', value: 'b', image_url: '/profile-pic/candidate/b.png' },
      ],
    })
    const captions = h.log.querySelectorAll('.thumb-caption')
    expect(captions.length).toBe(2)
    expect(captions[0]!.textContent).toBe('Smile')
    expect(captions[1]!.textContent).toBe('Wave')
  })

  test('clicking a button consumes the grid: all disabled, picked marked, grid `.consumed`', () => {
    const h = mountHarness()
    // Stub WS into OPEN so sendChoice proceeds.
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {},
    }
    renderAgent(h.client, 'Pick one:', {
      prompt_id: 'p-1',
      options: [
        { label: 'A', body: 'Apple', value: 'apple' },
        { label: 'B', body: 'Banana', value: 'banana' },
      ],
    })
    const grid = h.log.querySelector('.buttons')! as HTMLElement
    const [btn1, btn2] = Array.from(grid.querySelectorAll('button')) as HTMLButtonElement[]
    btn2!.click()
    expect(grid.classList.contains('consumed')).toBe(true)
    expect(btn1!.disabled).toBe(true)
    expect(btn2!.disabled).toBe(true)
    expect(btn2!.classList.contains('picked')).toBe(true)
    expect(btn1!.classList.contains('picked')).toBe(false)
  })
})

describe('ChatClient rendering — agent message AFTER a button choice', () => {
  test('the follow-up agent message opens a NEW run (not stacked under consumed buttons)', () => {
    const h = mountHarness()
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {},
    }
    renderAgent(h.client, 'Pick one:', {
      prompt_id: 'p-1',
      options: [
        { label: 'A', body: 'Apple', value: 'apple' },
        { label: 'B', body: 'Banana', value: 'banana' },
      ],
    })
    const grid = h.log.querySelector('.buttons')! as HTMLElement
    const [, btn2] = Array.from(grid.querySelectorAll('button')) as HTMLButtonElement[]
    btn2!.click()

    // Server replies with a follow-up agent message.
    renderAgent(h.client, 'Got it.')

    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(2)
    // The new run should NOT contain the prompt buttons — they live
    // in run #1, frozen in their consumed state.
    expect(runs[1]!.querySelector('.buttons')).toBeNull()
    expect(runs[1]!.textContent).toContain('Got it.')
    // Run #1 still has its consumed buttons.
    expect(runs[0]!.querySelector('.buttons.consumed')).not.toBeNull()
  })
})

describe('ChatClient rendering — image-gallery prompt (Sprint 28 compat)', () => {
  test('renders a CSS-grid of thumbnails with caption', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick a portrait:', {
      prompt_id: 'pic-1',
      kind: 'image-gallery',
      options: [
        { label: '1', body: 'Smile', value: 'a', image_url: '/profile-pic/candidate/a.png' },
        { label: '2', body: 'Wave', value: 'b', image_url: '/profile-pic/candidate/b.png' },
        // Trailing skip option without an image — still in the grid.
        { label: 'Skip', body: 'pick later', value: 'skip' },
      ],
    })
    const grid = h.log.querySelector('.buttons.image-gallery') as HTMLElement
    expect(grid).not.toBeNull()
    const thumbs = grid.querySelectorAll('.thumb')
    expect(thumbs.length).toBe(2)
    expect((thumbs[0]!.querySelector('img') as HTMLImageElement).src).toContain('a.png')
    expect(grid.querySelectorAll('button').length).toBe(3)
  })
})

describe('ChatClient rendering — multi-line input behavior', () => {
  test('Enter (no shift) triggers send; Shift-Enter does NOT', () => {
    const h = mountHarness()
    let sent: unknown = null
    ;(h.client as unknown as { ws: { readyState: number; send: (s: string) => void } }).ws = {
      readyState: 1,
      send: (s: string) => {
        sent = JSON.parse(s)
      },
    }
    h.input.value = 'first line'
    // Shift-Enter: should NOT send.
    h.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(sent).toBeNull()
    expect(h.input.value).toBe('first line')

    // Plain Enter: SHOULD send.
    h.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false, bubbles: true, cancelable: true }),
    )
    expect(sent).toEqual({ type: 'user_message', body: 'first line' })
    // Input cleared after send.
    expect(h.input.value).toBe('')
  })
})

describe('ChatClient rendering — timestamp ages from "now" → "Nm" → "Nh"', () => {
  test('refreshAllTimestamps re-formats ts labels using each elements data-ts anchor', () => {
    const h = mountHarness()
    renderAgent(h.client, 'first')
    // Advance the clock by a minute and a half. We do NOT add a new
    // bubble — this simulates an idle chat where the only thing that
    // should happen is the timestamps tick.
    h.now.value += 90_000
    ;(h.client as unknown as { refreshAllTimestamps: () => void }).refreshAllTimestamps()
    const ts = h.log.querySelector('.run.run-agent .ts')!
    expect(ts.textContent).toBe('1m')

    // Another hour (60m later → 61m total), should now read "1h".
    h.now.value += 60 * 60 * 1000
    ;(h.client as unknown as { refreshAllTimestamps: () => void }).refreshAllTimestamps()
    expect(ts.textContent).toBe('1h')
  })

  test('a new bubble in the same run resets the run timestamp anchor to now', () => {
    const h = mountHarness()
    renderAgent(h.client, 'first')
    // 3 minutes pass.
    h.now.value += 3 * 60 * 1000
    // Same-sender new bubble resets the anchor.
    renderAgent(h.client, 'second')
    const ts = h.log.querySelector('.run.run-agent .ts')!
    expect(ts.textContent).toBe('now')
  })
})

describe('ChatClient rendering — empty input does not send', () => {
  test('typing only whitespace + Enter sends nothing', () => {
    const h = mountHarness()
    let sentCount = 0
    ;(h.client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
      readyState: 1,
      send: () => {
        sentCount += 1
      },
    }
    h.input.value = '   \n  '
    ;(h.client as unknown as { sendInput: () => void }).sendInput()
    expect(sentCount).toBe(0)
    // Run list also stays empty — we don't render an empty bubble.
    expect(h.log.querySelectorAll('.run').length).toBe(0)
  })
})

/**
 * Argus r1 (2026-05-10) — freeform-button suppression matrix.
 *
 * Web /chat suppresses A/B/C buttons on `allow_freeform=true` prompts ONLY
 * when every option is a known escape-ramp value (skip / pause). When the
 * option list contains real branches, the engine routes a typed reply as
 * `__freeform__` and would never resolve to those branch values, so
 * suppressing the buttons would make those branches unreachable. These
 * tests pin the allowlist behaviour so a future "tidy-up" doesn't regress
 * signup / archetype-picked / Sean-Ellis survey flows.
 */
// 2026-05-09 regression — Sam typed a slug in slug_chosen and saw
// silence. One of the failure modes was the landing-server WS handler
// emitting `{type:'error', message: '...'}` when the bridge threw, but
// the client `message` listener silently dropped any envelope that
// wasn't `agent_message` / `redirect`. Surfacing the error inline lets
// the user know their input was received and what failed.
describe('ChatClient rendering — server-side error envelope', () => {
  function dispatchError(client: import('../chat.ts').ChatClient, message: string): void {
    const c = client as unknown as { renderServerError: (m: unknown) => void }
    c.renderServerError({ type: 'error', message })
  }
  test('renders {type:"error"} as an agent bubble with the server message', () => {
    const h = mountHarness()
    dispatchError(h.client, 'Slug picker is not configured.')
    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(1)
    const run = runs[0]!
    expect(run.classList.contains('run-agent')).toBe(true)
    const bubble = run.querySelector('.bubble')
    expect(bubble).not.toBeNull()
    expect(bubble!.textContent).toBe('Slug picker is not configured.')
  })
  test('falls back to a generic message when the envelope body is empty', () => {
    const h = mountHarness()
    const c = h.client as unknown as { renderServerError: (m: unknown) => void }
    c.renderServerError({ type: 'error', message: '' })
    const bubble = h.log.querySelector('.bubble')
    expect(bubble).not.toBeNull()
    expect(bubble!.textContent).toBe('something went wrong, please try again')
  })
})

describe('ChatClient rendering — freeform-button suppression matrix', () => {
  test('name-intake (allow_freeform + only skip+pause) → buttons SUPPRESSED', () => {
    const h = mountHarness()
    renderAgent(h.client, 'What should I call you?', {
      prompt_id: 'name-intake-1',
      allow_freeform: true,
      options: [
        { label: 'A', body: 'Skip', value: '__skip__' },
        { label: 'B', body: 'Pause', value: '__pause__' },
      ],
    })
    expect(h.log.querySelector('.buttons')).toBeNull()
    expect(h.log.querySelector('.run.run-agent')).not.toBeNull()
  })

  test('signup (allow_freeform + use-telegram-name + skip + pause) → buttons SHOWN', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Sign in?', {
      prompt_id: 'signup-1',
      allow_freeform: true,
      options: [
        { label: 'A', body: 'Use Telegram name', value: 'use-telegram-name' },
        { label: 'B', body: 'Skip', value: '__skip__' },
        { label: 'C', body: 'Pause', value: '__pause__' },
      ],
    })
    const grid = h.log.querySelector('.buttons')
    expect(grid).not.toBeNull()
    expect(grid!.querySelectorAll('button').length).toBe(3)
  })

  test('work_pattern_captured (allow_freeform + 4 named options) → buttons SHOWN', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Reply freeform OR pick:', {
      prompt_id: 'work-pattern-1',
      allow_freeform: true,
      options: [
        { label: 'A', body: 'Maker mornings', value: 'maker-mornings' },
        { label: 'B', body: 'Manager schedule', value: 'manager-schedule' },
        { label: 'C', body: 'Deep blocks', value: 'deep-blocks' },
        { label: 'D', body: 'Reactive', value: 'reactive' },
      ],
    })
    const grid = h.log.querySelector('.buttons')
    expect(grid).not.toBeNull()
    expect(grid!.querySelectorAll('button').length).toBe(4)
  })

  test('Sean-Ellis (allow_freeform + 3 disappointment options) → buttons SHOWN', () => {
    const h = mountHarness()
    renderAgent(h.client, 'How would you feel if you could no longer use Neutron?', {
      prompt_id: 'sean-ellis-1',
      allow_freeform: true,
      options: [
        { label: 'A', body: 'Very disappointed', value: 'very_disappointed' },
        { label: 'B', body: 'Somewhat disappointed', value: 'somewhat_disappointed' },
        { label: 'C', body: 'Not disappointed', value: 'not_disappointed' },
      ],
    })
    const grid = h.log.querySelector('.buttons')
    expect(grid).not.toBeNull()
    expect(grid!.querySelectorAll('button').length).toBe(3)
  })

  test('image-gallery (allow_freeform + 8 portrait options) → buttons SHOWN', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Pick a portrait:', {
      prompt_id: 'pic-1',
      allow_freeform: true,
      kind: 'image-gallery',
      options: [
        { label: '1', body: 'p1', value: 'p1', image_url: '/profile-pic/candidate/p1.png' },
        { label: '2', body: 'p2', value: 'p2', image_url: '/profile-pic/candidate/p2.png' },
        { label: '3', body: 'p3', value: 'p3', image_url: '/profile-pic/candidate/p3.png' },
        { label: '4', body: 'p4', value: 'p4', image_url: '/profile-pic/candidate/p4.png' },
        { label: '5', body: 'p5', value: 'p5', image_url: '/profile-pic/candidate/p5.png' },
        { label: '6', body: 'p6', value: 'p6', image_url: '/profile-pic/candidate/p6.png' },
        { label: '7', body: 'p7', value: 'p7', image_url: '/profile-pic/candidate/p7.png' },
        { label: '8', body: 'p8', value: 'p8', image_url: '/profile-pic/candidate/p8.png' },
      ],
    })
    const grid = h.log.querySelector('.buttons.image-gallery')
    expect(grid).not.toBeNull()
    expect(grid!.querySelectorAll('.thumb').length).toBe(8)
  })

  test('import_offered (allow_freeform + show-curated + skip-archetypes) → buttons SHOWN', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Import a sample of your writing?', {
      prompt_id: 'import-offered-1',
      allow_freeform: true,
      options: [
        { label: 'A', body: 'Show curated', value: 'show-curated' },
        { label: 'B', body: 'Skip archetypes', value: 'skip-archetypes' },
      ],
    })
    const grid = h.log.querySelector('.buttons')
    expect(grid).not.toBeNull()
    expect(grid!.querySelectorAll('button').length).toBe(2)
  })

  test('archetype_picked (allow_freeform + keep-display-name) → buttons SHOWN', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Picked! Keep your display name?', {
      prompt_id: 'archetype-picked-1',
      allow_freeform: true,
      options: [
        { label: 'A', body: 'Keep display name', value: 'keep-display-name' },
      ],
    })
    const grid = h.log.querySelector('.buttons')
    expect(grid).not.toBeNull()
    expect(grid!.querySelectorAll('button').length).toBe(1)
  })

  test('allow_freeform=false + skip+pause options → buttons SHOWN (suppression only fires under allow_freeform)', () => {
    const h = mountHarness()
    renderAgent(h.client, 'Static buttons:', {
      prompt_id: 'p-no-freeform',
      // allow_freeform omitted (i.e. false) — suppression must NOT trigger
      options: [
        { label: 'A', body: 'Skip', value: '__skip__' },
        { label: 'B', body: 'Pause', value: '__pause__' },
      ],
    })
    const grid = h.log.querySelector('.buttons')
    expect(grid).not.toBeNull()
    expect(grid!.querySelectorAll('button').length).toBe(2)
  })
})
