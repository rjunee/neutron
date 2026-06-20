/**
 * Chat-history hydration (2026-05-28 sprint) — frontend tests.
 *
 * Exercises the WS-open hydration + "Load earlier" lazy-load against a
 * happy-dom DOM bootstrap. fetch + WebSocket are both stubbed so the
 * tests stay hermetic; scrollHeight/scrollTop are stubbed per the
 * chat-scroll-up.test.ts pattern (happy-dom doesn't compute flex
 * layouts so layout-dependent reads default to 0 without explicit
 * stubs).
 *
 * Per `docs/plans/2026-05-28-001-feat-chat-history-hydration-plan.md` § Phase 3.2.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'https://t-test.neutron.test/chat' })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

interface FakeWebSocket {
  addEventListener(type: string, fn: (ev?: unknown) => void): void
  send(): void
  close(): void
  fireOpen(): void
  fireMessage(data: unknown): void
  fireClose(): void
}

let activeSockets: FakeWebSocket[] = []

let mod: typeof import('../chat.ts')

beforeAll(async () => {
  // Pretend the document is still loading so chat.ts's bottom-of-file
  // auto-boot guard doesn't fire a real connect() at import time.
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  // Stub WebSocket — captures listener registrations and exposes
  // `fireOpen`/`fireMessage`/`fireClose` so the tests can drive the
  // lifecycle deterministically.
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static OPEN = 1
    static CONNECTING = 0
    static CLOSING = 2
    static CLOSED = 3
    readyState = 0
    private readonly listeners: Record<string, ((ev?: unknown) => void)[]> = {
      open: [],
      message: [],
      close: [],
      error: [],
    }
    constructor() {
      const fake: FakeWebSocket = {
        addEventListener: (type, fn): void => {
          this.listeners[type]?.push(fn)
        },
        send: (): void => {},
        close: (): void => {},
        fireOpen: (): void => {
          this.readyState = 1
          for (const fn of this.listeners['open'] ?? []) fn({})
        },
        fireMessage: (data): void => {
          for (const fn of this.listeners['message'] ?? []) {
            fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })
          }
        },
        fireClose: (): void => {
          this.readyState = 3
          for (const fn of this.listeners['close'] ?? []) fn({ code: 1006, reason: '' })
        },
      }
      activeSockets.push(fake)
      // Mirror the addEventListener / send / close API onto `this` so
      // chat.ts can attach listeners directly.
      ;(this as unknown as Record<string, unknown>).addEventListener = fake.addEventListener
      ;(this as unknown as Record<string, unknown>).send = fake.send
      ;(this as unknown as Record<string, unknown>).close = fake.close
    }
  }
  // Suppress the navigation that chat.ts triggers on WS close (it
  // calls `window.location.replace('/chat')` which throws under
  // happy-dom). Replace it with a no-op so tests can fire `close`
  // events without polluting the test runner with navigation errors.
  Object.defineProperty(window.location, 'replace', {
    value: () => {},
    writable: true,
    configurable: true,
  })
  mod = await import('../chat.ts')
})

interface QueuedResponse {
  status: number
  body?: Record<string, unknown>
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

interface FetchSpy {
  calls: FetchCall[]
  /** Push the next response off the queue. Empty queue → 200 with
   *  `{ ok: true, turns: [], has_more: false }` (safe default). */
  enqueue(res: QueuedResponse): void
  /** Cause every subsequent fetch to reject with the given Error. */
  failNextWith(err: Error): void
}

function installFetchSpy(): FetchSpy {
  const calls: FetchCall[] = []
  const queue: QueuedResponse[] = []
  let nextErr: Error | null = null
  const spy: FetchSpy = {
    calls,
    enqueue: (res): void => {
      queue.push(res)
    },
    failNextWith: (err): void => {
      nextErr = err
    },
  }
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init })
    if (nextErr !== null) {
      const err = nextErr
      nextErr = null
      throw err
    }
    const next = queue.shift() ?? {
      status: 200,
      body: { ok: true, turns: [], has_more: false, oldest_returned_at: null, oldest_returned_prompt_id: null },
    }
    return new Response(JSON.stringify(next.body ?? { ok: false }), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return spy
}

interface Harness {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
  socket: FakeWebSocket
  fetchSpy: FetchSpy
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
  // happy-dom returns 0 for every geometry read; the scroll-anchor
  // math relies on the BEFORE/AFTER delta. Stub scrollHeight as a
  // getter that returns the current child count × 50 (a synthetic
  // height progression) so the prepend test sees a non-zero delta.
  Object.defineProperty(log, 'scrollHeight', {
    get: () => log.children.length * 50,
    configurable: true,
  })
  Object.defineProperty(log, 'clientHeight', { value: 200, configurable: true })
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  const fetchSpy = installFetchSpy()
  activeSockets = []
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-05-28T12:00:00Z'),
  })
  client.connect()
  expect(activeSockets.length).toBe(1)
  return { client, log, socket: activeSockets[0]!, fetchSpy }
}

function makeTurn(idx: number, opts?: { resolved?: boolean }): unknown {
  const resolved = opts?.resolved ?? true
  return resolved
    ? {
        prompt_id: `prompt-${idx}`,
        body: `Agent turn ${idx}`,
        created_at: Date.parse('2026-05-28T00:00:00Z') + idx * 60_000,
        resolved: true,
        resolution_text: `User reply ${idx}`,
      }
    : {
        prompt_id: `prompt-${idx}`,
        body: `Agent turn ${idx}`,
        created_at: Date.parse('2026-05-28T00:00:00Z') + idx * 60_000,
        resolved: false,
        resolution_text: null,
      }
}

/**
 * Microtask flush — Promise.resolve().then(() => …) yields to the
 * event loop so any awaited fetch resolutions complete before the
 * next assertion.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

describe('chat history hydration — initial fetch on WS open', () => {
  let h: Harness
  beforeEach(() => {
    h = mountHarness()
  })
  afterEach(() => {
    h.client.dispose()
  })

  // T1 — WS open + 5 turns → all rendered chronologically above the
  // live tail; the rendered count reflects the turn → bubble mapping
  // (1 agent bubble per turn, plus 1 user bubble per resolved turn).
  test('renders 5 historical turns in chronological order', async () => {
    const turns = [makeTurn(5), makeTurn(4), makeTurn(3), makeTurn(2), makeTurn(1)]
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns,
        has_more: false,
        oldest_returned_at: (turns[turns.length - 1] as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    // 5 resolved turns = 5 agent runs + 5 user runs (ignoring the
    // transient typing bubble that WS-open optimistically renders;
    // its run carries `data-transient="typing"` so we can filter).
    const historyAgentRuns = h.log.querySelectorAll(
      '.run.run-agent:not([data-transient="typing"])',
    )
    expect(historyAgentRuns.length).toBe(5)
    expect(h.log.querySelectorAll('.run.run-user').length).toBe(5)
    // First agent bubble should be the oldest turn (idx=1), last
    // the newest (idx=5). Filter out typing-dots bubbles.
    const agentBubbles = h.log.querySelectorAll(
      '.run.run-agent:not([data-transient="typing"]) .bubble',
    )
    expect(agentBubbles[0]?.textContent).toBe('Agent turn 1')
    expect(agentBubbles[agentBubbles.length - 1]?.textContent).toBe('Agent turn 5')
    // User-side bubbles render `resolution_text`.
    const userBubbles = h.log.querySelectorAll('.run.run-user .bubble')
    expect(userBubbles[0]?.textContent).toBe('User reply 1')
  })

  // T2 — has_more=true → ".load-earlier" button visible as first
  // child of #log.
  test('has_more=true → Load earlier button at top of #log', async () => {
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1)],
        has_more: true,
        oldest_returned_at: (makeTurn(1) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    const first = h.log.firstChild as HTMLElement
    expect(first.classList.contains('load-earlier')).toBe(true)
  })

  // T3 — click "Load earlier" → fetches with the correct `before` and
  // `before_prompt_id` cursor; prepends older turns; new oldest cursor
  // is the response's `oldest_returned_at`.
  test('click "Load earlier" → fetches next page with correct cursor', async () => {
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(10), makeTurn(9)],
        has_more: true,
        oldest_returned_at: (makeTurn(9) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-9',
      },
    })
    h.socket.fireOpen()
    await flush()
    const button = h.log.querySelector('.load-earlier') as HTMLButtonElement
    expect(button).not.toBeNull()
    // Enqueue the second-page response BEFORE clicking.
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(8), makeTurn(7)],
        has_more: false,
        oldest_returned_at: (makeTurn(7) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-7',
      },
    })
    const prevCallCount = h.fetchSpy.calls.length
    button.click()
    await flush()
    expect(h.fetchSpy.calls.length).toBe(prevCallCount + 1)
    const secondCallUrl = h.fetchSpy.calls[prevCallCount]!.url
    expect(secondCallUrl).toContain(`before=${(makeTurn(9) as { created_at: number }).created_at}`)
    expect(secondCallUrl).toContain('before_prompt_id=prompt-9')
    // After the second response (has_more: false), the Load-earlier
    // button must be GONE.
    expect(h.log.querySelector('.load-earlier')).toBeNull()
    // Older turns prepended above the original turn-10.
    const agentBubbles = h.log.querySelectorAll('.run.run-agent .bubble')
    expect(agentBubbles[0]?.textContent).toBe('Agent turn 7')
  })

  // T4 — scroll-position anchor is preserved across a prepend so the
  // user's visible content stays put. We assert this by capping
  // `scrollTop` to the pre-prepend top + post-prepend height delta
  // and checking the post-prepend `scrollTop` equals the expected
  // value computed from our progression stub.
  test('scroll position preserved across prepend (height-delta anchor)', async () => {
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1)],
        has_more: true,
        oldest_returned_at: (makeTurn(1) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    // After the first batch: #log has the Load-earlier button + 2
    // runs (agent + user). Pretend the user scrolled to read the
    // middle: set scrollTop to a known value.
    const topBefore = 30
    h.log.scrollTop = topBefore
    const heightBefore = h.log.scrollHeight // child count × 50
    // Enqueue another batch — it'll add 2 more runs (1 turn × 2 runs).
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(0)],
        has_more: false,
        oldest_returned_at: (makeTurn(0) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-0',
      },
    })
    const button = h.log.querySelector('.load-earlier') as HTMLButtonElement
    button.click()
    await flush()
    const heightAfter = h.log.scrollHeight
    // Recipe: scrollTop_after = scrollTop_before + (heightAfter - heightBefore)
    expect(h.log.scrollTop).toBe(topBefore + (heightAfter - heightBefore))
  })

  // T5a — live WS arrives BEFORE history fetch resolves. History
  // payload includes the same prompt_id. No duplicate render.
  test('dedup: live WS arrives first with shared prompt_id, history skips it', async () => {
    // Don't enqueue yet — we want the WS message to land first.
    // Inject a never-resolving fetch by replacing globalThis.fetch
    // temporarily.
    let resolveHistory: (() => void) | null = null
    const original = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<Response> => {
      return await new Promise<Response>((resolve) => {
        resolveHistory = (): void => {
          resolve(
            new Response(
              JSON.stringify({
                ok: true,
                turns: [makeTurn(1)],
                has_more: false,
                oldest_returned_at: (makeTurn(1) as { created_at: number }).created_at,
                oldest_returned_prompt_id: 'prompt-1',
              }),
              { status: 200 },
            ),
          )
        }
      })
    }
    h.socket.fireOpen()
    await flush()
    // Live WS delivers the prompt FIRST.
    h.socket.fireMessage({ type: 'agent_message', body: 'Live render', prompt_id: 'prompt-1' })
    await flush()
    expect(h.log.querySelectorAll('.run.run-agent').length).toBe(1)
    // Now resolve the history fetch; it should dedup on prompt_id
    // and NOT add a duplicate.
    resolveHistory!()
    await flush()
    expect(h.log.querySelectorAll('.run.run-agent').length).toBe(1)
    // Restore fetch for any subsequent test in this describe block.
    ;(globalThis as unknown as { fetch: unknown }).fetch = original
  })

  // T5b — symmetric for RESOLVED rows: history arrives FIRST with a
  // resolved row; live WS lands with the same prompt_id; the live
  // render dedups.
  test('dedup (resolved): history-first then live with same prompt_id skips', async () => {
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1)], // resolved=true (default)
        has_more: false,
        oldest_returned_at: (makeTurn(1) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    expect(
      h.log.querySelectorAll('.run.run-agent:not([data-transient="typing"])').length,
    ).toBe(1)
    h.socket.fireMessage({ type: 'agent_message', body: 'Live render', prompt_id: 'prompt-1' })
    await flush()
    expect(
      h.log.querySelectorAll('.run.run-agent:not([data-transient="typing"])').length,
    ).toBe(1)
  })

  // T5c (Codex r1 P1, 2026-05-28) — UNRESOLVED historical rows must
  // NOT block the live WS active-prompt re-emit. The history endpoint
  // surfaces unresolved rows so the client knows they exist, but
  // rendering them as inert agent bubbles would dedupe away the
  // live WS re-emit that carries the CLICKABLE button keyboard.
  // Symptom of the regression: user reloads /chat with a pending
  // prompt → sees the prompt body but no buttons → can't reply.
  test('unresolved historical turn does NOT dedupe the live WS button render', async () => {
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1, { resolved: false })],
        has_more: false,
        oldest_returned_at: (makeTurn(1) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    // Unresolved history was SKIPPED → zero non-typing agent runs
    // from history.
    expect(
      h.log.querySelectorAll('.run.run-agent:not([data-transient="typing"])').length,
    ).toBe(0)
    // Live WS lands the active prompt with a button keyboard.
    h.socket.fireMessage({
      type: 'agent_message',
      body: 'Active prompt body',
      prompt_id: 'prompt-1',
      options: [
        { label: 'A', body: 'option a', value: 'opt_a' },
        { label: 'B', body: 'option b', value: 'opt_b' },
      ],
    })
    await flush()
    // Live renders normally — agent bubble + clickable buttons.
    const agentRuns = h.log.querySelectorAll('.run.run-agent:not([data-transient="typing"])')
    expect(agentRuns.length).toBe(1)
    // The buttons grid landed in the live run.
    expect(agentRuns[0]?.querySelector('.buttons')).not.toBeNull()
    expect(agentRuns[0]?.querySelectorAll('.buttons button').length).toBe(2)
  })

  // T5d (BUG #310 fix, 2026-06-19 owner live-dogfood) — OLDER unresolved
  // historical rows now RENDER as inert agent bubbles (no button keyboard,
  // no user reply). Only the topic's SINGLE most-recent unresolved row
  // (the active prompt the server re-emits live with its clickable
  // keyboard) is still left for the live re-emit. Pre-fix every unresolved
  // row was dropped, so a project whose backlog was unresolved stubs
  // showed only the single re-emitted message on a topic switch.
  test('older unresolved turns render inert; the newest unresolved (active) is left for the live re-emit', async () => {
    // DESC wire order: newest (idx 3, unresolved=ACTIVE) first, then an
    // older unresolved (idx 2), then a resolved turn (idx 1).
    const turns = [
      makeTurn(3, { resolved: false }),
      makeTurn(2, { resolved: false }),
      makeTurn(1),
    ]
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns,
        has_more: false,
        oldest_returned_at: (turns[turns.length - 1] as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    // Two non-typing agent runs render from history: the resolved turn 1
    // AND the older unresolved turn 2 (inert). The newest unresolved
    // turn 3 is held back for the live re-emit.
    const afterHydrate = h.log.querySelectorAll(
      '.run.run-agent:not([data-transient="typing"])',
    )
    expect(afterHydrate.length).toBe(2)
    const hydrateBubbleText = Array.from(
      h.log.querySelectorAll('.run.run-agent:not([data-transient="typing"]) .bubble'),
    ).map((b) => b.textContent)
    expect(hydrateBubbleText).toContain('Agent turn 1')
    expect(hydrateBubbleText).toContain('Agent turn 2')
    expect(hydrateBubbleText).not.toContain('Agent turn 3')
    // The inert older-unresolved row carries NO button keyboard and NO
    // paired user bubble (it was never answered).
    expect(h.log.querySelectorAll('.buttons').length).toBe(0)
    expect(h.log.querySelectorAll('.run.run-user').length).toBe(1)
    // Live re-emit lands the active prompt (turn 3) WITH its buttons.
    h.socket.fireMessage({
      type: 'agent_message',
      body: 'Agent turn 3',
      prompt_id: 'prompt-3',
      options: [
        { label: 'A', body: 'option a', value: 'opt_a' },
        { label: 'B', body: 'option b', value: 'opt_b' },
      ],
    })
    await flush()
    const agentRuns = h.log.querySelectorAll('.run.run-agent:not([data-transient="typing"])')
    expect(agentRuns.length).toBe(3)
    // The active prompt rendered with a clickable keyboard (not deduped
    // away by the inert-history path).
    expect(h.log.querySelectorAll('.buttons button').length).toBe(2)
  })

  // T6 — fetch 401 → no UI noise. The log shouldn't accumulate any
  // historical runs; the warning lands on console (we don't assert
  // its presence — over-asserting on warns couples to log format).
  test('fetch 401 → no UI noise; no history runs added', async () => {
    h.fetchSpy.enqueue({ status: 401, body: { ok: false, code: 'unauthorized' } })
    h.socket.fireOpen()
    await flush()
    // The WS-open typing-bubble run is present (data-transient=typing)
    // and is unrelated to hydration. Hydration failure must NOT add
    // any historical runs.
    expect(h.log.querySelectorAll('.run:not([data-transient="typing"])').length).toBe(0)
    expect(h.log.querySelector('.load-earlier')).toBeNull()
  })

  // T7 — historyHydrated gate: even if has_more=true, the
  // Load-earlier button is only rendered AFTER the initial hydration
  // succeeds (we exercise this via the natural sequencing in T2 — no
  // extra assertion needed, but we verify here that BEFORE
  // hydration the button is absent).
  test('Load-earlier button absent before initial hydration resolves', () => {
    // Don't fire WS open yet → hydration never runs.
    expect(h.log.querySelector('.load-earlier')).toBeNull()
  })

  // T8 — double-click "Load earlier" → strict `loadingOlder` flag
  // means only one fetch fires, even if the cosmetic disabled state
  // is bypassed. We simulate the bypass by clicking twice in the
  // same task before the first fetch resolves.
  test('double-click Load-earlier fires exactly one fetch', async () => {
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1)],
        has_more: true,
        oldest_returned_at: (makeTurn(1) as { created_at: number }).created_at,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    const button = h.log.querySelector('.load-earlier') as HTMLButtonElement
    expect(button).not.toBeNull()
    // Block the second-page fetch by NOT enqueuing — the FetchSpy
    // default-200-empty response also works for this test, we just
    // need to count call sites.
    const prevCalls = h.fetchSpy.calls.length
    button.click()
    button.click() // SECOND click in the same synchronous task
    await flush()
    // Exactly ONE second fetch should have fired.
    expect(h.fetchSpy.calls.length).toBe(prevCalls + 1)
  })

  // T9 — advance guard: server returns same oldest_returned_at →
  // button removed, no infinite click loop possible.
  test('cursor non-advance → button removed', async () => {
    const ts = (makeTurn(1) as { created_at: number }).created_at
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1)],
        has_more: true,
        oldest_returned_at: ts,
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    h.socket.fireOpen()
    await flush()
    // Second page returns the SAME oldest_returned_at — server
    // bug or stalled cursor. The advance guard should hide the
    // button and log a warning.
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1)], // same row again
        has_more: true,
        oldest_returned_at: ts, // SAME — does not advance
        oldest_returned_prompt_id: 'prompt-1',
      },
    })
    const button = h.log.querySelector('.load-earlier') as HTMLButtonElement
    button.click()
    await flush()
    expect(h.log.querySelector('.load-earlier')).toBeNull()
  })

  // T9b (Codex r1 P2, 2026-05-28) — composite-cursor advance via
  // prompt_id tiebreak. When the next page shares `created_at`
  // with the previous boundary but carries a strictly lower
  // `prompt_id`, the cursor IS advancing in the
  // `(created_at DESC, prompt_id DESC)` ordering and the guard
  // must NOT stall. Regression cover for the `>=` bug that
  // discarded valid ms-collision pages.
  test('composite-cursor: same ts + lower prompt_id advances (not stalled)', async () => {
    const ts = (makeTurn(1) as { created_at: number }).created_at
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(1)],
        has_more: true,
        oldest_returned_at: ts,
        oldest_returned_prompt_id: 'prompt-mid',
      },
    })
    h.socket.fireOpen()
    await flush()
    // Second page: same ts, lower prompt_id → valid advance.
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [makeTurn(2)],
        has_more: false,
        oldest_returned_at: ts, // same ts
        oldest_returned_prompt_id: 'prompt-aaa', // strictly lower
      },
    })
    const button = h.log.querySelector('.load-earlier') as HTMLButtonElement
    button.click()
    await flush()
    // The page DID land (turn 2 rendered above turn 1's bubble).
    const agentBubbles = h.log.querySelectorAll(
      '.run.run-agent:not([data-transient="typing"]) .bubble',
    )
    // Two resolved turns rendered → 2 agent bubbles.
    expect(agentBubbles.length).toBeGreaterThanOrEqual(2)
    // has_more=false on this page → button hidden.
    expect(h.log.querySelector('.load-earlier')).toBeNull()
  })

  // T10 — WS close mid-fetch aborts cleanly; no DOM writes after the
  // dispose. We simulate by firing close BEFORE the fetch resolves;
  // the chat.ts handler calls abortController.abort() on close.
  test('WS close mid-fetch aborts cleanly; no DOM writes', async () => {
    let resolveHistory: ((res: Response) => void) | null = null
    const original = globalThis.fetch
    ;(globalThis as unknown as { fetch: unknown }).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      return await new Promise<Response>((resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted === true) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          return
        }
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
        resolveHistory = resolve
      })
    }
    h.socket.fireOpen()
    await flush()
    // Fire close BEFORE resolving the fetch.
    h.socket.fireClose()
    await flush()
    // Late-resolving fetch (if it ever did) won't write any DOM.
    const r = resolveHistory as ((res: Response) => void) | null
    if (r !== null) {
      r(
        new Response(
          JSON.stringify({
            ok: true,
            turns: [makeTurn(1)],
            has_more: false,
            oldest_returned_at: 0,
            oldest_returned_prompt_id: null,
          }),
          { status: 200 },
        ),
      )
    }
    await flush()
    // No turns rendered; no thrown errors.
    expect(h.log.querySelectorAll('.run').length).toBe(0)
    ;(globalThis as unknown as { fetch: unknown }).fetch = original
  })

  // T11 — WS reconnect: hydration only fires ONCE. After the first
  // successful hydration, a second open event must NOT re-fetch.
  test('WS reconnect: hydration is idempotent (historyHydrated gate)', async () => {
    h.fetchSpy.enqueue({
      status: 200,
      body: {
        ok: true,
        turns: [],
        has_more: false,
        oldest_returned_at: null,
        oldest_returned_prompt_id: null,
      },
    })
    h.socket.fireOpen()
    await flush()
    const callsAfterFirstOpen = h.fetchSpy.calls.length
    // Simulate reconnect: fire open again on the same socket. (In
    // production this would be a fresh WebSocket after navigation;
    // for the gate-correctness test we only need the chat-ts side
    // to NOT re-hydrate, which is gated on the `historyHydrated`
    // flag, NOT on socket identity.)
    h.socket.fireOpen()
    await flush()
    expect(h.fetchSpy.calls.length).toBe(callsAfterFirstOpen)
  })
})
