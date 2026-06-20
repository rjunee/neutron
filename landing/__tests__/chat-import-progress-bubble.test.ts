/**
 * Bug 1 client-side test (2026-05-21, v0.1.75; rewritten 2026-06-17,
 * Argus r2) — import-progress bubble renders a determinate VISUAL
 * progress bar + an estimated-time-remaining line, updates them in
 * place as `import_progress` envelopes arrive, and auto-clears on the
 * next `agent_message`.
 *
 * Ryan's HARD requirement (Argus r2): the user sees a progress BAR +
 * ETA — NEVER a raw "N/M batches" chunk count. The server envelope
 * still carries a `body` like "Pass 1: 47/57 batches" for forward-
 * compat, but the client MUST NOT surface those chunk numbers. These
 * tests assert the DOM (bar element + advancing value + ETA text), not
 * just the WS transport, and assert NO chunk-count string is shown.
 *
 * See `docs/plans/2026-05-22-001-fix-import-progress-ux-plan.md` for the
 * original envelope shape and `landing/server.ts` (`ImportProgressOutbound`)
 * for the wire contract.
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

interface StubWebSocket {
  url: string
  readyState: number
  onListeners: Array<(ev: Event) => void>
  messageListeners: Array<(ev: { data: string }) => void>
  closeListeners: Array<(ev: Event) => void>
  errorListeners: Array<(ev: Event) => void>
  addEventListener(kind: string, fn: unknown): void
  removeEventListener(): void
  send(): void
  close(): void
  fireOpen(): void
  fireMessage(payload: unknown): void
  fireClose(): void
}

function buildStubWebSocket(): { instances: StubWebSocket[] } {
  const instances: StubWebSocket[] = []
  class FakeWebSocket {
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    url: string
    readyState = 0
    onListeners: Array<(ev: Event) => void> = []
    messageListeners: Array<(ev: { data: string }) => void> = []
    closeListeners: Array<(ev: Event) => void> = []
    errorListeners: Array<(ev: Event) => void> = []
    constructor(url: string) {
      this.url = url
      instances.push(this as unknown as StubWebSocket)
    }
    addEventListener(kind: string, fn: unknown): void {
      if (kind === 'open') this.onListeners.push(fn as (ev: Event) => void)
      else if (kind === 'message')
        this.messageListeners.push(fn as (ev: { data: string }) => void)
      else if (kind === 'close') this.closeListeners.push(fn as (ev: Event) => void)
      else if (kind === 'error') this.errorListeners.push(fn as (ev: Event) => void)
    }
    removeEventListener(): void {}
    send(): void {}
    close(): void {}
    fireOpen(): void {
      this.readyState = 1
      for (const fn of this.onListeners) fn(new Event('open'))
    }
    fireMessage(payload: unknown): void {
      const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
      for (const fn of this.messageListeners) fn({ data })
    }
    fireClose(): void {
      this.readyState = 3
      for (const fn of this.closeListeners) fn(new Event('close'))
    }
  }
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
  return { instances }
}

interface Harness {
  client: import('../chat.ts').ChatClient
  log: HTMLElement
  ws: StubWebSocket
}

beforeAll(async () => {
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
  mod = await import('../chat.ts')
})

/**
 * Mount with a controllable clock so the ETA math is deterministic. The
 * harness starts at t0 and `advance(ms)` moves it forward; the client
 * reads `now()` on every envelope, so advancing between `fireMessage`
 * calls simulates the 5s cron cadence.
 */
function mountAndOpen(): Harness & { advance(ms: number): void } {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap"><div id="log"></div></div>
    <footer>
      <textarea id="input"></textarea>
      <button id="send"></button>
    </footer>
  `
  const log = document.getElementById('log') as HTMLElement
  const status = document.getElementById('status') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  const wsState = buildStubWebSocket()
  let clock = Date.parse('2026-05-21T12:00:00Z')
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => clock,
  })
  ;(client as unknown as { connect: () => void }).connect()
  const ws = wsState.instances[wsState.instances.length - 1]!
  return { client, log, ws, advance: (ms: number) => (clock += ms) }
}

function getImportProgressBubble(log: HTMLElement): HTMLElement | null {
  return log.querySelector('.bubble.import-progress') as HTMLElement | null
}
function getBar(log: HTMLElement): HTMLProgressElement | null {
  return log.querySelector('.import-progress-bar') as HTMLProgressElement | null
}
function getPhaseLabel(log: HTMLElement): string {
  return log.querySelector('.import-progress-body')?.textContent ?? ''
}
function getEta(log: HTMLElement): string {
  return log.querySelector('.import-progress-eta')?.textContent ?? ''
}
/** The full visible text of the bubble — used to assert NO chunk count leaks. */
function getBubbleText(log: HTMLElement): string {
  return getImportProgressBubble(log)?.textContent ?? ''
}

describe('Bug 1 (Argus r2) — import-progress visual bar + ETA', () => {
  test('first envelope renders a VISUAL progress bar (not a chunk-count string)', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({
      type: 'agent_message',
      body: 'Analyzing your 57 conversations from claude — this takes about 30 seconds.',
    })
    expect(getImportProgressBubble(h.log)).toBeNull()

    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 0.05,
      chunks_total_known: true,
      body: 'Pass 1: 3/57 batches',
    })

    const bubble = getImportProgressBubble(h.log)
    expect(bubble).not.toBeNull()

    // A real <progress> bar element exists and reflects the pct.
    const bar = getBar(h.log)
    expect(bar).not.toBeNull()
    expect(bar!.tagName.toLowerCase()).toBe('progress')
    expect(Number(bar!.max)).toBe(100)
    // Pass 1 maps onto 0–50%: pct 0.05 → overall 2.5% → rounds to 3.
    expect(bar!.value).toBeGreaterThan(0)
    expect(bar!.value).toBeLessThan(50)
    expect(bar!.dataset['determinate']).toBe('true')

    // An ETA line is present in the DOM.
    expect(getEta(h.log).length).toBeGreaterThan(0)

    // The forbidden case: NO raw chunk-count readout is shown to the user.
    const text = getBubbleText(h.log)
    expect(text).not.toContain('3/57')
    expect(text).not.toContain('batches')
    expect(text).not.toMatch(/\d+\s*\/\s*\d+/)
    expect(text).not.toContain('$')
    // It DOES show a friendly phase label.
    expect(getPhaseLabel(h.log).toLowerCase()).toContain('scanning')
  })

  test('the bar ADVANCES and an ETA appears as pct envelopes arrive', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })

    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 0.1,
      chunks_total_known: true,
      body: 'Pass 1: 6/57 batches',
    })
    const first = getBar(h.log)!.value
    // First sample has no rate yet → still estimating.
    expect(getEta(h.log)).toContain('estimating')

    // 10s later, progress has advanced.
    h.advance(10_000)
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 0.5,
      chunks_total_known: true,
      body: 'Pass 1: 28/57 batches',
    })

    // Exactly ONE bubble (updated in place, not re-created).
    expect(h.log.querySelectorAll('.bubble.import-progress').length).toBe(1)
    // The bar advanced.
    const second = getBar(h.log)!.value
    expect(second).toBeGreaterThan(first)
    // A concrete time-remaining estimate now renders (tied to the bar).
    const eta = getEta(h.log)
    expect(eta).toMatch(/left|almost done/)
    expect(eta).not.toContain('estimating')

    // Still no chunk numbers anywhere in the bubble.
    expect(getBubbleText(h.log)).not.toMatch(/\d+\s*\/\s*\d+/)
    expect(getBubbleText(h.log)).not.toContain('batches')
  })

  test('pass-2 envelope drives the bar into its second half + keeps an ETA', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 1.0,
      chunks_total_known: true,
      body: 'Pass 1: 57/57 batches',
    })
    // Pass 2 begins.
    h.advance(5_000)
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass2-running',
      pass: 2,
      pct: 0.2,
      chunks_total_known: true,
      body: 'Pass 2: synthesizing from 57 batches',
    })
    h.advance(8_000)
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass2-running',
      pass: 2,
      pct: 0.6,
      chunks_total_known: true,
      body: 'Pass 2: synthesizing from 57 batches',
    })

    const bar = getBar(h.log)!
    // Pass 2 pct 0.6 → overall 80%.
    expect(bar.value).toBeGreaterThan(50)
    expect(bar.dataset['determinate']).toBe('true')
    expect(getPhaseLabel(h.log).toLowerCase()).toContain('synthesizing')
    expect(getEta(h.log)).toMatch(/left|almost done|estimating/)
    expect(getBubbleText(h.log)).not.toMatch(/\d+\s*\/\s*\d+/)
  })

  test('unknown total (streaming fallback, pct=0) renders an INDETERMINATE bar + "estimating…"', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 0,
      chunks_total_known: false,
      body: 'Pass 1: 12 batches processed',
    })

    const bar = getBar(h.log)!
    // Indeterminate: no honest fraction → no `value` attribute set.
    expect(bar.dataset['determinate']).toBe('false')
    expect(bar.hasAttribute('value')).toBe(false)
    expect(getEta(h.log)).toContain('estimating')
    // Still never a chunk count.
    expect(getBubbleText(h.log)).not.toContain('12 batches')
    expect(getBubbleText(h.log)).not.toMatch(/\d/)
  })

  test('updates in place on subsequent envelopes (does NOT create a new bubble each tick)', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })
    for (const [pct, pass] of [
      [0.05, 1],
      [0.5, 1],
      [0.3, 2],
    ] as const) {
      h.advance(5_000)
      h.ws.fireMessage({
        type: 'import_progress',
        job_id: 'job-x',
        status: pass === 2 ? 'pass2-running' : 'pass1-running',
        pass,
        pct,
        chunks_total_known: true,
      })
    }
    expect(h.log.querySelectorAll('.bubble.import-progress').length).toBe(1)
    expect(getPhaseLabel(h.log).toLowerCase()).toContain('synthesizing')
  })

  test('auto-clears on the next agent_message envelope', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 0.5,
      chunks_total_known: true,
    })
    expect(getImportProgressBubble(h.log)).not.toBeNull()

    h.ws.fireMessage({
      type: 'agent_message',
      body: "Done! Here's what I found in your conversations…",
    })
    expect(getImportProgressBubble(h.log)).toBeNull()
  })

  test('terminal status (completed) clears the bubble without rendering one', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 0.5,
      chunks_total_known: true,
    })
    expect(getImportProgressBubble(h.log)).not.toBeNull()

    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'completed',
      pass: 2,
      pct: 1.0,
      chunks_total_known: true,
    })
    expect(getImportProgressBubble(h.log)).toBeNull()
  })

  test('rate-limit status keeps the bar but shows a paused phase label + estimating', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'rate_limit_paused',
      pass: 1,
      pct: 0.3,
      chunks_total_known: true,
      body: 'Pass 1: 17/57 batches',
    })
    expect(getImportProgressBubble(h.log)).not.toBeNull()
    expect(getBar(h.log)).not.toBeNull()
    expect(getPhaseLabel(h.log).toLowerCase()).toContain('paused')
    expect(getEta(h.log)).toContain('estimating')
    expect(getBubbleText(h.log)).not.toMatch(/\d+\s*\/\s*\d+/)
  })

  test('bubble clears on WS close (queued progress no longer arriving)', () => {
    const h = mountAndOpen()
    h.ws.fireOpen()
    h.ws.fireMessage({ type: 'agent_message', body: 'Analyzing…' })
    h.ws.fireMessage({
      type: 'import_progress',
      job_id: 'job-x',
      status: 'pass1-running',
      pass: 1,
      pct: 0.5,
      chunks_total_known: true,
    })
    expect(getImportProgressBubble(h.log)).not.toBeNull()
    h.ws.fireClose()
    expect(getImportProgressBubble(h.log)).toBeNull()
  })
})

describe('importOverallPct / formatEtaRemaining helpers', () => {
  test('importOverallPct maps passes onto halves of a monotonic 0..1 scale', () => {
    expect(mod.importOverallPct(1, 0)).toBe(0)
    expect(mod.importOverallPct(1, 0.5)).toBeCloseTo(0.25, 5)
    expect(mod.importOverallPct(1, 1)).toBeCloseTo(0.5, 5)
    expect(mod.importOverallPct(2, 0)).toBeCloseTo(0.5, 5)
    expect(mod.importOverallPct(2, 1)).toBeCloseTo(1, 5)
    // Clamps out-of-range / non-finite.
    expect(mod.importOverallPct(1, -1)).toBe(0)
    expect(mod.importOverallPct(2, 5)).toBeCloseTo(1, 5)
    expect(mod.importOverallPct(1, NaN)).toBe(0)
  })

  test('formatEtaRemaining rounds to a calm granularity and rejects noise', () => {
    expect(mod.formatEtaRemaining(0)).toBeNull()
    expect(mod.formatEtaRemaining(-5)).toBeNull()
    expect(mod.formatEtaRemaining(Number.POSITIVE_INFINITY)).toBeNull()
    expect(mod.formatEtaRemaining(60 * 60 * 1000)).toBeNull() // absurdly large
    expect(mod.formatEtaRemaining(2_000)).toBe('almost done')
    expect(mod.formatEtaRemaining(23_000)).toBe('about 25s left')
    expect(mod.formatEtaRemaining(90_000)).toMatch(/min left/)
  })
})
