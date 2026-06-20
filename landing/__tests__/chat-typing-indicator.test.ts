/**
 * Typing-indicator lifecycle tests.
 *
 * Context: 2026-05-13 — Sam ran the M2 dry-run and noticed a 2-3 second
 * gap between hitting Send and the agent's reply landing (engine.advance
 * + LLM call). During that gap the chat surface showed nothing — no
 * acknowledgement that the input was received. The fix is a purely
 * client-side optimistic "typing dots" bubble:
 *
 *   - Inserted on user_message send (inside sendInput, after this.send)
 *   - Removed when the next agent_message arrives (inside renderAgent)
 *   - Removed when the WS closes (no longer represents a real action)
 *   - Also removed on a server-side error envelope (it IS the response)
 *
 * No protocol change — the engine has no "typing" event. The indicator
 * is pure client-side UX. These tests pin the four lifecycle states +
 * the rendered DOM structure (3 .dot children in a .bubble.typing).
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
  input: HTMLTextAreaElement
  sendBtn: HTMLButtonElement
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
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-05-13T12:00:00Z'),
  })
  // Stub the WS into OPEN so sendInput proceeds.
  ;(client as unknown as { ws: { readyState: number; send: () => void } }).ws = {
    readyState: 1,
    send: () => {},
  }
  // 2026-06-18 (Bug 1) — these tests isolate the typing-dot DOM mechanics for a
  // conversation that is already underway (the first agent message has landed,
  // so the first-load "Setting things up…" loader is gone). The loader, when
  // up, deliberately SUPPRESSES the typing dots (it owns the screen until the
  // welcome paints). Clear it here so the dots render as the mechanics tests
  // expect — first-load loader behaviour is covered in chat-setup-indicator.test.ts.
  ;(client as unknown as { clearSetupIndicator: () => void }).clearSetupIndicator()
  return { client, log, status, input, sendBtn }
}

function typeAndSend(h: Harness, body: string): void {
  // The `inFlight` flag is set to `true` for 50ms after every send to
  // debounce double-Enter — synchronous test calls would otherwise hit
  // the guard and silently no-op the second send. Reset it before
  // each send so the test models a user whose keystrokes are more
  // than 50ms apart.
  ;(h.client as unknown as { inFlight: boolean }).inFlight = false
  h.input.value = body
  ;(h.client as unknown as { sendInput: () => void }).sendInput()
}

function renderAgent(client: import('../chat.ts').ChatClient, body: string): void {
  const c = client as unknown as { renderAgent: (m: unknown) => void }
  c.renderAgent({ type: 'agent_message', body })
}

function getTypingBubble(h: Harness): HTMLElement | null {
  return h.log.querySelector('.bubble.typing') as HTMLElement | null
}

describe('typing indicator — after sendInput', () => {
  test('typingBubble is non-null and a .bubble.typing element exists in the log', () => {
    const h = mountHarness()
    typeAndSend(h, 'hello')
    const internal = h.client as unknown as { typingBubble: HTMLElement | null }
    expect(internal.typingBubble).not.toBeNull()
    const dom = getTypingBubble(h)
    expect(dom).not.toBeNull()
    // The internal pointer and the DOM element are the same node.
    expect(internal.typingBubble === dom).toBe(true)
  })

  test('typing bubble is an agent-styled bubble with exactly 3 .dot children', () => {
    const h = mountHarness()
    typeAndSend(h, 'hi')
    const bubble = getTypingBubble(h)!
    expect(bubble.classList.contains('bubble')).toBe(true)
    expect(bubble.classList.contains('bubble-agent')).toBe(true)
    expect(bubble.classList.contains('typing')).toBe(true)
    const dots = bubble.querySelectorAll('.dot')
    expect(dots.length).toBe(3)
  })

  test('typing bubble lives inside an agent run that sits AFTER the user run', () => {
    const h = mountHarness()
    typeAndSend(h, 'hi')
    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(2)
    expect(runs[0]!.classList.contains('run-user')).toBe(true)
    expect(runs[1]!.classList.contains('run-agent')).toBe(true)
    // The agent run has an avatar (per the existing run template) +
    // the typing bubble; no separate timestamp is attached because the
    // dots are ephemeral.
    expect(runs[1]!.querySelector('.avatar')).not.toBeNull()
    expect(runs[1]!.querySelector('.bubble.typing')).not.toBeNull()
  })
})

describe('typing indicator — after renderAgent', () => {
  test('typingBubble is null and the .bubble.typing element is removed', () => {
    const h = mountHarness()
    typeAndSend(h, 'hello')
    expect(getTypingBubble(h)).not.toBeNull()

    renderAgent(h.client, 'hi back')
    const internal = h.client as unknown as { typingBubble: HTMLElement | null }
    expect(internal.typingBubble).toBeNull()
    expect(getTypingBubble(h)).toBeNull()
  })

  test('the real agent bubble lands in its own run with the body text', () => {
    const h = mountHarness()
    typeAndSend(h, 'hello')
    renderAgent(h.client, 'real reply')

    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(2)
    expect(runs[0]!.classList.contains('run-user')).toBe(true)
    expect(runs[1]!.classList.contains('run-agent')).toBe(true)
    const agentBubble = runs[1]!.querySelector('.bubble')
    expect(agentBubble).not.toBeNull()
    expect(agentBubble!.classList.contains('typing')).toBe(false)
    expect(agentBubble!.textContent).toBe('real reply')
  })
})

describe('typing indicator — WS close removes the bubble', () => {
  test('handleClose drops the typing bubble (with no stash, navigates to /chat so auth-gate redirects to signin — 2026-05-27 returning-user resume sprint)', async () => {
    const h = mountHarness()
    typeAndSend(h, 'hello')
    expect(getTypingBubble(h)).not.toBeNull()

    // No stashed start_token → handleClose navigates to /chat (the
    // per-instance gateway's auth-gate then 302s the browser to identity
    // signin). The bubble MUST drop regardless of the recovery shape.
    delete (window as unknown as { __neutron_start_token?: string }).__neutron_start_token
    // Stub window.location.replace so happy-dom doesn't try to navigate.
    Object.defineProperty(window.location, 'replace', {
      value: () => {},
      writable: true,
      configurable: true,
    })
    await (h.client as unknown as { handleClose: () => Promise<void> }).handleClose()

    const internal = h.client as unknown as { typingBubble: HTMLElement | null }
    expect(internal.typingBubble).toBeNull()
    expect(getTypingBubble(h)).toBeNull()
    // New status emitted by the sprint's tokenless-recover redirect.
    expect(h.status.textContent).toBe('redirecting to sign in…')
  })
})

describe('typing indicator — double-send race', () => {
  test('second sendInput while typing bubble exists does NOT double-render', () => {
    const h = mountHarness()
    typeAndSend(h, 'first')
    const first = getTypingBubble(h)
    expect(first).not.toBeNull()

    // Second send before the agent has replied. The spec: keep the
    // existing typing bubble; don't double-render.
    typeAndSend(h, 'second')
    const allTyping = h.log.querySelectorAll('.bubble.typing')
    expect(allTyping.length).toBe(1)
    // Same DOM node as before — not torn down and re-created.
    expect(allTyping[0] === first).toBe(true)
  })
})

/**
 * Codex r2 P2 (2026-05-13) — the original implementation hid the typing
 * bubble on the FIRST agent_message after a double-send, even when the
 * second send was still outstanding. That left the chat looking idle
 * for the remaining backend latency, recreating the exact gap the
 * feature was supposed to remove. Fix: a pending-replies counter so
 * the dots survive the first reply when more turns are still queued.
 */
describe('typing indicator — multi-send queue (Codex r2 P2)', () => {
  test('two sends + one reply: typing bubble STAYS (second turn still outstanding)', () => {
    const h = mountHarness()
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')
    expect(getTypingBubble(h)).not.toBeNull()
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(2)

    renderAgent(h.client, 'reply to first')
    // Counter dropped to 1 → bubble still present.
    expect(internal.pendingAgentReplies).toBe(1)
    expect(getTypingBubble(h)).not.toBeNull()
  })

  test('Codex r3 P2 / r6 P3 — first real reply lands BEFORE the still-pending typing dots (separate transient run)', () => {
    // The dots are the placeholder for what's STILL pending, not for
    // what just arrived. Under the r6 refactor the typing bubble
    // lives in a separate `data-transient="typing"` run so it doesn't
    // co-mingle with the real-reply run; the document-order invariant
    // is asserted across the LOG, not within a single run.
    const h = mountHarness()
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')
    renderAgent(h.client, 'reply to first')

    const allBubbles = Array.from(
      h.log.querySelectorAll<HTMLElement>('.run.run-agent .bubble'),
    )
    const replyIndex = allBubbles.findIndex((b) => b.textContent === 'reply to first')
    const typingIndex = allBubbles.findIndex((b) => b.classList.contains('typing'))
    expect(replyIndex).toBeGreaterThanOrEqual(0)
    expect(typingIndex).toBeGreaterThanOrEqual(0)
    expect(replyIndex).toBeLessThan(typingIndex)
    // The typing bubble lives in its own transient run.
    const typingRun = h.log.querySelector('.run[data-transient="typing"]')
    expect(typingRun).not.toBeNull()
    expect(typingRun!.querySelector('.bubble.typing')).not.toBeNull()
  })

  test('two sends + two replies: typing bubble disappears after the second reply', () => {
    const h = mountHarness()
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')
    renderAgent(h.client, 'reply to first')
    renderAgent(h.client, 'reply to second')

    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(0)
    expect(getTypingBubble(h)).toBeNull()
  })

  test('one send + unsolicited agent_message + the real reply: no negative-counter drift', () => {
    // Edge case: the server pushes an unsolicited agent_message before
    // the user has sent anything. The counter must clamp at 0 instead
    // of going negative; the eventual reply to a later send must still
    // resolve properly.
    const h = mountHarness()
    renderAgent(h.client, 'unsolicited welcome')
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(0)

    typeAndSend(h, 'hello')
    expect(internal.pendingAgentReplies).toBe(1)
    renderAgent(h.client, 'hi')
    expect(internal.pendingAgentReplies).toBe(0)
    expect(getTypingBubble(h)).toBeNull()
  })

  test('WS close after a multi-send queue force-clears the counter and the bubble', async () => {
    const h = mountHarness()
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')
    typeAndSend(h, 'third')
    const internal = h.client as unknown as {
      pendingAgentReplies: number
      handleClose: () => Promise<void>
    }
    expect(internal.pendingAgentReplies).toBe(3)

    delete (window as unknown as { __neutron_start_token?: string }).__neutron_start_token
    await internal.handleClose()

    expect(internal.pendingAgentReplies).toBe(0)
    expect(getTypingBubble(h)).toBeNull()
  })
})

describe('typing indicator — button-choice replies (Codex r1 P2)', () => {
  function renderAgentButtonPrompt(client: import('../chat.ts').ChatClient): void {
    const c = client as unknown as { renderAgent: (m: unknown) => void }
    c.renderAgent({
      type: 'agent_message',
      body: 'Pick one:',
      prompt_id: 'p-1',
      options: [
        { label: 'A', body: 'Apple', value: 'apple' },
        { label: 'B', body: 'Banana', value: 'banana' },
      ],
    })
  }

  test('clicking a button fires the typing indicator (same 2-3s gap as typed input)', () => {
    const h = mountHarness()
    renderAgentButtonPrompt(h.client)
    const grid = h.log.querySelector('.buttons')! as HTMLElement
    const [, btn2] = Array.from(grid.querySelectorAll('button')) as HTMLButtonElement[]
    btn2!.click()

    const internal = h.client as unknown as { typingBubble: HTMLElement | null }
    expect(internal.typingBubble).not.toBeNull()
    expect(getTypingBubble(h)).not.toBeNull()
  })

  test('Codex r5 P2 — button-choice send snaps the viewport to bottom before showing dots', () => {
    // Regression: sendInput goes through commitLocalSend which forces
    // stickToBottom=true via scrollToBottom; sendChoice did NOT, so a
    // user who'd scrolled up to read history and then tapped a prompt
    // option got the typing dots silently appended off-screen with no
    // visible acknowledgement of their tap. Fix: sendChoice now also
    // calls scrollToBottom('smooth') before showTypingBubble.
    const h = mountHarness()
    renderAgentButtonPrompt(h.client)
    const internal = h.client as unknown as {
      stickToBottom: boolean
      scrollToBottom: (b: ScrollBehavior) => void
    }
    let scrollCalls = 0
    internal.scrollToBottom = (_b: ScrollBehavior) => {
      scrollCalls += 1
      internal.stickToBottom = true
    }
    // Simulate scrolled-up state.
    internal.stickToBottom = false

    const grid = h.log.querySelector('.buttons')! as HTMLElement
    const [, btn2] = Array.from(grid.querySelectorAll('button')) as HTMLButtonElement[]
    btn2!.click()

    // The viewport snap MUST happen so the dots are visible.
    expect(scrollCalls).toBeGreaterThanOrEqual(1)
    // The dots are present.
    expect(getTypingBubble(h)).not.toBeNull()
  })

  test('the next agent_message removes the typing bubble even when the prior turn was a button choice', () => {
    const h = mountHarness()
    renderAgentButtonPrompt(h.client)
    const grid = h.log.querySelector('.buttons')! as HTMLElement
    const [, btn2] = Array.from(grid.querySelectorAll('button')) as HTMLButtonElement[]
    btn2!.click()
    expect(getTypingBubble(h)).not.toBeNull()

    renderAgent(h.client, 'Banana it is.')
    expect(getTypingBubble(h)).toBeNull()
    const internal = h.client as unknown as { typingBubble: HTMLElement | null }
    expect(internal.typingBubble).toBeNull()
    // The follow-up reply lands in its own run; the consumed prompt run
    // is untouched.
    const runs = h.log.querySelectorAll('.run')
    expect(runs.length).toBe(2)
    expect(runs[0]!.querySelector('.buttons.consumed')).not.toBeNull()
    expect(runs[1]!.querySelector('.bubble')!.textContent).toBe('Banana it is.')
  })
})

/**
 * Codex r6 (2026-05-13) — typing bubble must NOT interfere with the
 * existing same-sender run-collapse system. Earlier cuts went through
 * `openOrJoinRun('agent')` for the typing dots, which flipped
 * `currentRunSender` to `'agent'` and broke user-run collapsing for
 * the very next `sendInput`. Pin both:
 *
 *   P2: a second send while the dots are showing repositions the
 *       transient typing run to the bottom (the dots aren't stranded
 *       above the newer outbound turn).
 *
 *   P3: two rapid sends collapse into a SINGLE user run with a SINGLE
 *       timestamp (the typing run in the middle is transient and
 *       doesn't break the collapse rule).
 */
describe('typing indicator — Codex r6 transient-run invariants', () => {
  test('P2 — double-send repositions the typing run to the bottom of the log', () => {
    const h = mountHarness()
    typeAndSend(h, 'first')
    const typingAfterFirst = getTypingBubble(h)!
    const transientRun = typingAfterFirst.parentElement!

    typeAndSend(h, 'second')
    // Same DOM node — moved, not re-created.
    expect(getTypingBubble(h) === typingAfterFirst).toBe(true)
    // The transient run is now the LAST child of #log.
    expect(h.log.lastElementChild === transientRun).toBe(true)
  })

  test('P3 — two rapid sends collapse into a single user run with a single timestamp', () => {
    const h = mountHarness()
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')

    // Both user bubbles live in the SAME user run.
    const userRuns = h.log.querySelectorAll('.run.run-user')
    expect(userRuns.length).toBe(1)
    const userBubbles = userRuns[0]!.querySelectorAll('.bubble')
    expect(userBubbles.length).toBe(2)
    expect(userBubbles[0]!.textContent).toBe('first')
    expect(userBubbles[1]!.textContent).toBe('second')
    // Only the last bubble carries the tail.
    expect(userBubbles[0]!.classList.contains('tail')).toBe(false)
    expect(userBubbles[1]!.classList.contains('tail')).toBe(true)
    // Single timestamp.
    expect(userRuns[0]!.querySelectorAll(':scope > .ts').length).toBe(1)
  })

  test('P3 — transient typing run is marked `data-transient="typing"` and lives at the log root', () => {
    const h = mountHarness()
    typeAndSend(h, 'hello')
    const transient = h.log.querySelector('.run[data-transient="typing"]')
    expect(transient).not.toBeNull()
    expect(transient!.parentElement === h.log).toBe(true)
    expect(transient!.querySelector('.bubble.typing')).not.toBeNull()
  })
})

/**
 * Codex r4 (2026-05-13) — two more multi-send edge cases:
 *
 *   P2: re-emitting queued dots after a real reply must NOT yank the
 *       viewport to bottom if the user has scrolled up to read history.
 *
 *   P3: clearing a typing bubble that sits NEXT TO an earlier real
 *       agent bubble in the same run must restore the tail to that
 *       real bubble (the typing bubble took the tail when it was
 *       inserted; without restoration the preceding bubble visibly
 *       loses its asymmetric corner after disconnect / reconnect).
 */
describe('typing indicator — Codex r4 viewport + tail handoff', () => {
  test('Codex r4 P2 — post-reply re-emit does NOT scroll-to-bottom when user is scrolled up', () => {
    const h = mountHarness()
    // Two sends so the second reply is still queued after the first.
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')

    // Simulate the user scrolling up to read history. stickToBottom is
    // a private state machine; flip it directly + verify the post-
    // reply re-emit respects it. (handleScroll() would also flip it
    // but we don't have a real scroll event here.)
    const internal = h.client as unknown as {
      stickToBottom: boolean
      scrollToBottom: (b: ScrollBehavior) => void
    }
    let scrollCalls = 0
    internal.scrollToBottom = (_b: ScrollBehavior) => {
      scrollCalls += 1
    }
    internal.stickToBottom = false

    // First reply lands. renderAgent's commitNewBubble respects
    // stickToBottom; the re-emit MUST also respect it.
    renderAgent(h.client, 'reply to first')

    expect(scrollCalls).toBe(0)
    // The dots are still rendered (counter > 0), just not snap-scrolled
    // into view — the unread pill flow takes over.
    expect(getTypingBubble(h)).not.toBeNull()
  })

  test('Codex r4 P2 — post-send show DOES scroll-to-bottom (sendInput is an explicit "snap" gesture)', () => {
    const h = mountHarness()
    const internal = h.client as unknown as {
      stickToBottom: boolean
      scrollToBottom: (b: ScrollBehavior) => void
    }
    let scrollCalls = 0
    internal.scrollToBottom = (_b: ScrollBehavior) => {
      scrollCalls += 1
    }
    // User was scrolled up, but they hit Send — commitLocalSend forces
    // stickToBottom=true via scrollToBottom() BEFORE showTypingBubble fires.
    internal.stickToBottom = false
    typeAndSend(h, 'hello')

    // commitLocalSend's scrollToBottom + showTypingBubble's
    // renderTypingBubbleNow scrollToBottom = 2 calls minimum.
    expect(scrollCalls).toBeGreaterThanOrEqual(1)
    expect(getTypingBubble(h)).not.toBeNull()
  })

  test('Codex r4 P3 / r6 P3 — clearing typing dots does NOT touch any real bubble tail', () => {
    // Under the r6 refactor the typing bubble lives in its own
    // transient run, so it never strips `.tail` from any real
    // bubble in the first place. The r4 concern (preceding bubble
    // loses its asymmetric corner after the dots are cleared) is
    // moot — but we still pin the invariant so a future regression
    // back into a shared-run model would surface here.
    const h = mountHarness()
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')
    renderAgent(h.client, 'reply to first')

    const realBubble = Array.from(
      h.log.querySelectorAll<HTMLElement>('.run.run-agent .bubble:not(.typing)'),
    ).find((b) => b.textContent === 'reply to first')!
    expect(realBubble.classList.contains('tail')).toBe(true)

    delete (window as unknown as { __neutron_start_token?: string }).__neutron_start_token
    return (h.client as unknown as { handleClose: () => Promise<void> })
      .handleClose()
      .then(() => {
        expect(getTypingBubble(h)).toBeNull()
        // The real bubble's tail is untouched.
        expect(realBubble.classList.contains('tail')).toBe(true)
      })
  })
})

/**
 * ISSUES #69 Argus r1 BLOCKER 1 (2026-05-30) — the gateway's silent-
 * skip path in `handleProjectTopicInbound` emits a no-render
 * `agent_ack` envelope so the optimistic typing dots from `sendChoice`
 * clear (without an ack, project-topic skips left the dots stuck
 * forever — project topics have no per-project agent loop yet).
 *
 * These tests pin: (a) `agent_ack` decrements `pendingAgentReplies`,
 * (b) it removes the visible typing bubble, and (c) it renders no
 * agent bubble of its own.
 */
describe('typing indicator — agent_ack envelope clears dots without rendering a bubble (ISSUES #69 BLOCKER)', () => {
  function dispatchAck(client: import('../chat.ts').ChatClient): void {
    const c = client as unknown as { handleAgentAck: () => void }
    c.handleAgentAck()
  }

  test('one button-choice send + agent_ack → typing bubble cleared, pendingAgentReplies === 0, no agent bubble rendered', () => {
    const h = mountHarness()
    // Mirror sendChoice's bookkeeping: bump the counter + render the
    // dots the same way the production path does. We don't go through
    // the WS because the harness's WS is a no-op stub; the relevant
    // contract is "after sendChoice, dots show + counter=1; after
    // ack, dots gone + counter=0; no agent bubble created".
    const c = h.client as unknown as {
      sendChoice: (p: string, v: string) => void
      pendingAgentReplies: number
    }
    // Pre-render a button prompt so sendChoice has a live grid to
    // consume (matches the production flow where a user taps a
    // rendered button).
    ;(h.client as unknown as { renderAgent: (m: unknown) => void }).renderAgent({
      type: 'agent_message',
      body: 'Pick one:',
      prompt_id: 'p-skip',
      options: [
        { label: 'A', body: 'Tell me what you know', value: 'tell-me-what-you-know' },
        { label: 'B', body: 'Skip for now', value: 'skip-for-now' },
      ],
    })
    const grid = h.log.querySelector('.buttons')! as HTMLElement
    const [, skipBtn] = Array.from(grid.querySelectorAll('button')) as HTMLButtonElement[]
    skipBtn!.click()
    expect(c.pendingAgentReplies).toBe(1)
    expect(getTypingBubble(h)).not.toBeNull()

    // Count agent bubbles BEFORE the ack so the post-ack count check
    // is comparing apples to apples (the original prompt bubble +
    // consumed button row are already there from the renderAgent
    // above; the ack must not add ANY new bubble).
    const agentBubblesBefore = h.log.querySelectorAll('.run.run-agent .bubble:not(.typing)').length

    dispatchAck(h.client)

    expect(c.pendingAgentReplies).toBe(0)
    expect(getTypingBubble(h)).toBeNull()
    const internal = h.client as unknown as { typingBubble: HTMLElement | null }
    expect(internal.typingBubble).toBeNull()
    // No new agent bubble was created by the ack.
    const agentBubblesAfter = h.log.querySelectorAll('.run.run-agent .bubble:not(.typing)').length
    expect(agentBubblesAfter).toBe(agentBubblesBefore)
  })

  test('two sends + one agent_ack: dots stay (second turn still outstanding), counter dropped to 1', () => {
    // Mirrors the multi-send Codex r2 P2 contract for agent_message —
    // agent_ack decrements by exactly one, just like agent_message,
    // and leaves the dots if more turns are queued.
    const h = mountHarness()
    typeAndSend(h, 'first')
    typeAndSend(h, 'second')
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(2)

    dispatchAck(h.client)

    expect(internal.pendingAgentReplies).toBe(1)
    expect(getTypingBubble(h)).not.toBeNull()
  })

  test('stray agent_ack with no outstanding turn is a no-op (pendingAgentReplies clamps at 0, no error)', () => {
    const h = mountHarness()
    const internal = h.client as unknown as { pendingAgentReplies: number }
    expect(internal.pendingAgentReplies).toBe(0)

    dispatchAck(h.client)

    expect(internal.pendingAgentReplies).toBe(0)
    expect(getTypingBubble(h)).toBeNull()
  })
})

describe('typing indicator — server error envelope clears it', () => {
  test('renderServerError removes the typing bubble (the error IS the response)', () => {
    const h = mountHarness()
    typeAndSend(h, 'hello')
    expect(getTypingBubble(h)).not.toBeNull()

    const c = h.client as unknown as { renderServerError: (m: unknown) => void }
    c.renderServerError({ type: 'error', message: 'engine broke' })

    expect(getTypingBubble(h)).toBeNull()
    const internal = h.client as unknown as { typingBubble: HTMLElement | null }
    expect(internal.typingBubble).toBeNull()
    // The error bubble landed in its own run.
    const errorBubble = h.log.querySelector('.run.run-agent .bubble')
    expect(errorBubble).not.toBeNull()
    expect(errorBubble!.textContent).toBe('engine broke')
  })
})

/**
 * Visual regression — happy-dom proxy for a Playwright/agent-browser
 * screenshot. The spec's "screenshot after Send + assert dots visible"
 * boils down to "the rendered DOM has the exact .bubble.typing element
 * with 3 .dot children whose CSS classes match the inline stylesheet's
 * selectors". If a future tidy-up drops the classes (or the animation
 * keyframe selector), the integration with chat.html's <style> block
 * breaks and the dots stop pulsing silently. This test pins the
 * structure so that regression cannot ship.
 */
describe('typing indicator — DOM-structure visual regression', () => {
  test('after Send, the rendered HTML matches the spec shape', () => {
    const h = mountHarness()
    typeAndSend(h, 'send-me')
    const bubble = getTypingBubble(h)!
    // Three .dot children, each a <span>.
    const dots = Array.from(bubble.children) as HTMLElement[]
    expect(dots.length).toBe(3)
    dots.forEach((d) => {
      expect(d.tagName).toBe('SPAN')
      expect(d.classList.contains('dot')).toBe(true)
    })
    // The bubble itself wears the CSS classes the chat.html rules key
    // on. `.bubble`, `.bubble-agent`, `.typing` are load-bearing for
    // colors / spacing / pulse animation. `.tail` is inherited from
    // appendBubble's "last-in-run gets the asymmetric corner" rule —
    // the typing bubble is the last (and only) bubble in its run, so
    // the tail handoff lands on it.
    const classes = bubble.className.split(/\s+/).sort()
    expect(classes).toContain('bubble')
    expect(classes).toContain('bubble-agent')
    expect(classes).toContain('typing')
  })

  test('chat.html ships the .bubble.typing CSS contract (selector + keyframes)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(import.meta.dir, '..', 'chat.html'), 'utf8')
    // The four selectors the implementation depends on:
    expect(css).toContain('.bubble.typing')
    expect(css).toContain('.bubble.typing .dot')
    expect(css).toContain('.bubble.typing .dot:nth-child(2)')
    expect(css).toContain('.bubble.typing .dot:nth-child(3)')
    // The keyframes the dots animate on.
    expect(css).toContain('@keyframes typing-pulse')
    expect(css).toContain('animation: typing-pulse')
  })
})
