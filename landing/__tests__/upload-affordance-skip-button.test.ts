/**
 * import-screen-deadend sprint (2026-06-06) — Fix 2: phantom "Skip the
 * import" button.
 *
 * The `import_upload_pending` prompt body ends with 'If you would rather
 * skip the import, tap "Skip the import" below.' and emits a single
 * escape-ramp option `{ value: 'skip', body: 'Skip the import' }`. But the
 * 2026-05-09 escape-ramp suppression (`suppressForFreeform`) hid EVERY
 * option on a freeform prompt whose options are all escape-ramp values —
 * so the promised Skip button never rendered. The copy lied.
 *
 * Fix: exempt UPLOAD-affordance prompts from the suppression. The
 * suppression rationale ("buttons add noise — the user types the answer in
 * the composer") does not apply when the user's action is upload-a-file /
 * skip, not typing a freeform answer. When `upload_affordance` is present,
 * the escape-ramp button RENDERS.
 *
 * These tests pin BOTH directions so neither regresses:
 *   (a) upload_affordance + skip-only options → Skip button RENDERS.
 *   (b) NO upload_affordance + skip-only options → still SUPPRESSED
 *       (the 2026-05-09 rule for ordinary freeform prompts is intact).
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
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    now: () => Date.parse('2026-06-06T12:00:00Z'),
  })
  return { client, log }
}

function renderAgent(client: import('../chat.ts').ChatClient, m: Record<string, unknown>): void {
  const c = client as unknown as { renderAgent: (m: unknown) => void }
  c.renderAgent({ type: 'agent_message', ...m })
}

/** All rendered option-button labels for the last agent run. */
function buttonLabels(log: HTMLElement): string[] {
  return Array.from(log.querySelectorAll('.buttons button')).map((b) => b.textContent ?? '')
}

const SKIP_OPTION = { label: 'A', body: 'Skip the import', value: 'skip' }

describe('escape-ramp suppression exempts upload-affordance prompts (Fix 2)', () => {
  test('upload_affordance + skip-only option → "Skip the import" button RENDERS', () => {
    const h = mountHarness()
    renderAgent(h.client, {
      body: 'Here are your download steps…\n\nIf you would rather skip the import, tap "Skip the import" below.',
      prompt_id: 'upload-1',
      options: [SKIP_OPTION],
      allow_freeform: true,
      upload_affordance: { source: 'chatgpt' },
    })
    const grid = h.log.querySelector('.buttons')
    expect(grid).not.toBeNull()
    expect(buttonLabels(h.log)).toContain('Skip the import')
  })

  test('upload_affordance (claude) + skip-only option → Skip button RENDERS', () => {
    const h = mountHarness()
    renderAgent(h.client, {
      body: 'Claude export steps…',
      prompt_id: 'upload-2',
      options: [SKIP_OPTION],
      allow_freeform: true,
      upload_affordance: { source: 'claude' },
    })
    expect(buttonLabels(h.log)).toContain('Skip the import')
  })

  test('NO upload_affordance + skip-only option → still SUPPRESSED (2026-05-09 rule intact)', () => {
    const h = mountHarness()
    renderAgent(h.client, {
      body: 'Tell me about your work. (You can also skip.)',
      prompt_id: 'freeform-1',
      options: [{ label: 'A', body: 'Skip', value: 'skip' }],
      allow_freeform: true,
      // no upload_affordance
    })
    // The whole escape-ramp grid is suppressed — the user types instead.
    expect(h.log.querySelector('.buttons')).toBeNull()
  })

  test('NO upload_affordance + named (non-escape-ramp) options → still RENDER (unchanged)', () => {
    const h = mountHarness()
    renderAgent(h.client, {
      body: 'Which fits?',
      prompt_id: 'freeform-2',
      options: [
        { label: 'A', body: 'Use my Telegram name', value: 'use-telegram-name' },
        { label: 'B', body: 'Skip', value: 'skip' },
      ],
      allow_freeform: true,
    })
    // A real named branch is present → not all escape-ramp → buttons render.
    expect(h.log.querySelector('.buttons')).not.toBeNull()
    expect(buttonLabels(h.log)).toContain('Use my Telegram name')
  })
})
