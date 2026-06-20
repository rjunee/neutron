/**
 * ISSUES #48 — landing upload-bar Cancel + Retry button wiring.
 *
 * Phase 1 (PR #309) shipped the Cancel + Retry buttons against an XHR
 * helper. Phase 2 (PR #310) replaced the helper with `uploadChunked`
 * from `landing/upload-client.ts` and the rebase dropped the wiring —
 * both buttons rendered in `chat.html` but had no JS listener.
 *
 * This test file pins the restored wiring so a future rebase can't
 * silently regress it again. Six scenarios from the sprint brief:
 *
 *   1. Cancel mid-upload aborts cleanly (no error bubble, label resets).
 *   2. Retry on 413 re-fires the SAME File and completes happy.
 *   3. Retry on network error re-fires and completes.
 *   4. Cancel does NOT surface the Retry button (cancel ≠ failure).
 *   5. AbortController is per-attempt — aborting #1 doesn't poison #2.
 *   6. lastUploadAttempt clears on successful completion.
 *   7. Cancel click → synchronous label flip + button disabled.
 *   8. (r1) Cancel rewrites the optimistic user bubble from "Uploaded X"
 *      to "Cancelled upload of X" so the transcript doesn't read
 *      contradictorily next to the upload-bar's "cancelled" label.
 *   9. (r1) Change-handler re-entry guard — a stray `change` dispatch
 *      while an upload is in flight doesn't mint a fresh
 *      AbortController and doesn't re-invoke handleUploadFile.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
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

interface UploadBarEls {
  bar: HTMLElement
  label: HTMLElement
  button: HTMLButtonElement
  input: HTMLInputElement
  cancel: HTMLButtonElement
  retry: HTMLButtonElement
  progress: HTMLProgressElement
  overlay: HTMLElement
}

interface Harness {
  client: import('../chat.ts').ChatClient
  els: UploadBarEls
  setFetch(impl: typeof fetch): void
}

/**
 * Mount the chat client with the upload-bar markup mirroring chat.html.
 * `setFetch` lets each test install its own scripted fetchImpl after
 * the client is constructed (the chunked client reads `uploadFetch`
 * once per attempt, so swapping between attempts is safe).
 */
function mountHarness(): Harness {
  document.body.innerHTML = `
    <header><div id="status"></div></header>
    <div id="log-wrap">
      <div id="log"></div>
      <button id="new-pill" hidden></button>
    </div>
    <footer>
      <div class="upload-bar" id="upload-bar" hidden>
        <span class="upload-label" id="upload-label">Upload your export ZIP</span>
        <button class="upload-button" id="upload-button" type="button" data-source="chatgpt">Choose file</button>
        <input type="file" id="upload-input" />
        <button class="upload-cancel" id="upload-cancel" type="button" hidden>Cancel</button>
        <button class="upload-retry" id="upload-retry" type="button" hidden>Retry</button>
        <progress class="upload-progress" id="upload-progress" max="100" value="0" hidden></progress>
      </div>
      <div class="upload-overlay" id="upload-overlay" hidden></div>
      <textarea id="input"></textarea>
      <button id="send"></button>
    </footer>
  `
  const els: UploadBarEls = {
    bar: document.getElementById('upload-bar') as HTMLElement,
    label: document.getElementById('upload-label') as HTMLElement,
    button: document.getElementById('upload-button') as HTMLButtonElement,
    input: document.getElementById('upload-input') as HTMLInputElement,
    cancel: document.getElementById('upload-cancel') as HTMLButtonElement,
    retry: document.getElementById('upload-retry') as HTMLButtonElement,
    progress: document.getElementById('upload-progress') as HTMLProgressElement,
    overlay: document.getElementById('upload-overlay') as HTMLElement,
  }
  const status = document.getElementById('status') as HTMLElement
  const log = document.getElementById('log') as HTMLElement
  const input = document.getElementById('input') as HTMLTextAreaElement
  const sendBtn = document.getElementById('send') as HTMLButtonElement
  // Held-fetch slot — tests rebind on every attempt via `setFetch`.
  let currentFetch: typeof fetch = (async () => {
    throw new Error('test forgot to install a fetch impl')
  }) as unknown as typeof fetch
  const client = new mod.ChatClient({
    url: 'wss://t-test.neutron.test/ws/chat',
    start_token: 't',
    log,
    status,
    input,
    sendBtn,
    uploadBar: els.bar,
    uploadButton: els.button,
    uploadInput: els.input,
    uploadLabel: els.label,
    uploadOverlay: els.overlay,
    uploadProgress: els.progress,
    uploadCancel: els.cancel,
    uploadRetry: els.retry,
    uploadFetch: ((url, init) => currentFetch(url, init)) as typeof fetch,
    now: () => Date.parse('2026-05-28T12:00:00Z'),
  })
  return {
    client,
    els,
    setFetch(impl: typeof fetch): void {
      currentFetch = impl
    },
  }
}

/** Drive the upload affordance bar visible by rendering a synthetic
 *  agent_message with the affordance envelope. Mirrors the real
 *  `import_upload_pending` engine event the gateway emits. */
function showUploadAffordance(
  client: import('../chat.ts').ChatClient,
  source: 'chatgpt' | 'claude' = 'chatgpt',
): void {
  const c = client as unknown as { renderAgent: (m: unknown) => void }
  c.renderAgent({
    type: 'agent_message',
    body: 'Upload your export ZIP',
    upload_affordance: { source },
  })
}

/** Build a `File` from a Uint8Array, side-stepping the SharedArrayBuffer
 *  variance noise in TS lib.dom typings (matches the pattern in
 *  `landing/__tests__/upload-chunked-client.test.ts`). */
function fileOf(bytes: Uint8Array, name = 'export.zip', type = 'application/zip'): File {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  return new File([ab], name, { type })
}

/** Invoke the (private) handleUploadFile entry-point directly. Tests
 *  drive this rather than the file-picker click handler so they
 *  control the `File` instance precisely (e.g. identity-equality
 *  assertions for the Retry-replays-same-File test). */
function uploadViaInstance(
  client: import('../chat.ts').ChatClient,
  file: File,
  source: 'chatgpt' | 'claude' = 'chatgpt',
): Promise<void> {
  const c = client as unknown as {
    handleUploadFile: (f: File, s?: 'chatgpt' | 'claude') => Promise<void>
  }
  return c.handleUploadFile(file, source)
}

/** Yield to the microtask queue so a Promise chained off a resolved
 *  Promise has a chance to advance state. We use this between
 *  arranging a fetch response and inspecting DOM state. */
function tick(times = 1): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i += 1) {
    p = p.then(() => Promise.resolve())
  }
  return p
}

/** Build a JSON Response (status + body) for the scripted fetch.
 *  Centralised so a future Response-shape change touches one place. */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('upload bar — Cancel button', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('cancel click → SYNCHRONOUS label flip + button disabled (immediate feedback)', async () => {
    // ISSUES #48 review follow-up. Without this, the chunked client's
    // 1s retry-on-transport-failure window leaves the user staring at
    // "Uploading 47%…" for a full second after they click Cancel.
    const h = mountHarness()
    showUploadAffordance(h.client)
    h.setFetch((async (url, init) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        return jsonResponse(200, {
          upload_id: 'u-cancel-sync',
          chunk_size_bytes: 4,
          total_bytes: 16,
        })
      }
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | null | undefined
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch)
    const file = fileOf(new Uint8Array(16))
    const uploadPromise = uploadViaInstance(h.client, file)
    await tick(5)
    expect(h.els.label.textContent).toContain('Uploading')
    expect(h.els.cancel.disabled).toBe(false)
    // Click — synchronously the label MUST flip + the button MUST disable
    // (no awaits between the click and these assertions).
    h.els.cancel.click()
    expect(h.els.label.textContent).toBe('Cancelling…')
    expect(h.els.cancel.disabled).toBe(true)
    // After the promise resolves, finally re-enables the button and the
    // catch branch overwrites the label with the final cancelled text.
    await uploadPromise
    expect(h.els.cancel.disabled).toBe(false)
    expect(h.els.label.textContent ?? '').toContain('cancelled')
  })

  test('cancel mid-upload → label resets, error class not set, retry stays hidden', async () => {
    const h = mountHarness()
    showUploadAffordance(h.client)
    // Resolve POST /start synchronously; for PATCH, return a promise
    // that resolves only when the abort signal fires — mirrors how a
    // real fetch rejects when the AbortController fires.
    let patchAbortHandler: (() => void) | null = null
    h.setFetch((async (url, init) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        return jsonResponse(200, {
          upload_id: 'u-cancel-1',
          chunk_size_bytes: 4,
          total_bytes: 16,
        })
      }
      // PATCH — wait for the abort signal to fire, then reject like
      // a real fetch does when the underlying request is cancelled.
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | null | undefined
        if (signal === null || signal === undefined) {
          throw new Error('signal not propagated into PATCH fetch')
        }
        patchAbortHandler = (): void => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        }
        signal.addEventListener('abort', patchAbortHandler)
      })
    }) as typeof fetch)
    const file = fileOf(new Uint8Array(16))
    const uploadPromise = uploadViaInstance(h.client, file)
    // Allow /start to resolve + PATCH to be in flight.
    await tick(5)
    expect(h.els.cancel.hidden).toBe(false)
    expect(h.els.retry.hidden).toBe(true)
    expect(h.els.label.textContent).toContain('Uploading')
    // User clicks Cancel.
    h.els.cancel.click()
    expect(patchAbortHandler).not.toBeNull()
    // Upload should reject + handler should reset state.
    await uploadPromise
    expect(h.els.cancel.hidden).toBe(true)
    expect(h.els.retry.hidden).toBe(true) // No retry offered for explicit cancel.
    expect(h.els.bar.classList.contains('error')).toBe(false)
    expect(h.els.label.textContent ?? '').toContain('cancelled')
    expect(h.els.progress.hidden).toBe(true)
  })

  test('cancel mid-upload → rewrites optimistic user bubble ("Uploaded X" → "Cancelled upload of X")', async () => {
    // ISSUES #48 r1 review. Before this fix the abort branch
    // suppressed the agent error bubble and reset the upload-bar
    // label, but left the optimistic user bubble appended at
    // `chat.ts:2444` saying "Uploaded export.zip" — directly
    // contradicting the upload-bar label "Upload cancelled. Pick
    // another file…". We rewrite the same DOM node (chosen over
    // detach + re-append) so the transcript preserves the fact that
    // the user DID initiate an upload, just one that didn't complete.
    const h = mountHarness()
    showUploadAffordance(h.client)
    h.setFetch((async (url, init) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        return jsonResponse(200, {
          upload_id: 'u-cancel-bubble',
          chunk_size_bytes: 4,
          total_bytes: 16,
        })
      }
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | null | undefined
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch)
    const file = fileOf(new Uint8Array(16), 'export.zip')
    const uploadPromise = uploadViaInstance(h.client, file)
    await tick(5)
    const log = document.getElementById('log') as HTMLElement
    const userBubbleBefore = log.querySelector('.bubble-user') as HTMLElement | null
    expect(userBubbleBefore).not.toBeNull()
    expect(userBubbleBefore?.textContent).toBe('Uploaded export.zip')
    // User clicks Cancel mid-flight.
    h.els.cancel.click()
    await uploadPromise
    const userBubbleAfter = log.querySelector('.bubble-user') as HTMLElement | null
    expect(userBubbleAfter).not.toBeNull()
    // Same DOM node — we rewrote the text rather than detach + re-append.
    expect(userBubbleAfter).toBe(userBubbleBefore)
    expect(userBubbleAfter?.textContent).toBe('Cancelled upload of export.zip')
    // And the transcript only contains the one (rewritten) user bubble —
    // no orphan "Uploaded" bubble lingering from a detach-and-replace path.
    const allUserBubbles = log.querySelectorAll('.bubble-user')
    expect(allUserBubbles.length).toBe(1)
  })
})

describe('upload bar — change-handler re-entry guard', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('input change while uploadInFlight is a no-op (does not mint a new controller)', async () => {
    // ISSUES #48 r1 review. The button click handler at chat.ts:2207
    // bails on `uploadInFlight`, but a stray programmatic
    // `input.dispatchEvent(new Event('change'))` with input.files set
    // (or any path that re-enters the input's change listener) would,
    // without the chat.ts:2220 guard, call handleUploadFile a second
    // time. handleUploadFile mints a fresh AbortController on every
    // entry and writes it to `this.uploadAbortController`, orphaning
    // the in-flight fetch — Cancel would then only abort the second
    // attempt, leaking the first.
    const h = mountHarness()
    showUploadAffordance(h.client)
    h.setFetch((async (url, init) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        return jsonResponse(200, {
          upload_id: 'u-reentry-guard',
          chunk_size_bytes: 4,
          total_bytes: 16,
        })
      }
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | null | undefined
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch)

    // Spy on handleUploadFile to count invocations.
    const c = h.client as unknown as {
      handleUploadFile: (f: File, s?: 'chatgpt' | 'claude') => Promise<void>
    }
    let calls = 0
    const orig = c.handleUploadFile.bind(h.client)
    c.handleUploadFile = async (f, s) => {
      calls += 1
      return orig(f, s)
    }

    const file1 = fileOf(new Uint8Array(16), 'first.zip')
    const uploadPromise = uploadViaInstance(h.client, file1)
    await tick(5)
    expect(calls).toBe(1)
    const controllerBefore = (
      h.client as unknown as { uploadAbortController: AbortController | null }
    ).uploadAbortController
    expect(controllerBefore).not.toBeNull()
    const labelBefore = h.els.label.textContent

    // Synthesize a fresh `change` event with a NEW file in input.files.
    // Without the guard, the change listener would call handleUploadFile
    // again, mint a new AbortController, and overwrite the per-instance
    // controller — orphaning the first attempt.
    const file2 = fileOf(new Uint8Array(8), 'second.zip')
    Object.defineProperty(h.els.input, 'files', {
      configurable: true,
      value: [file2],
    })
    h.els.input.dispatchEvent(new Event('change'))
    await tick(2)

    // Guard held: handleUploadFile was NOT re-entered, the controller
    // identity is unchanged, and the upload-bar label still reflects
    // the in-flight first attempt.
    expect(calls).toBe(1)
    const controllerAfter = (
      h.client as unknown as { uploadAbortController: AbortController | null }
    ).uploadAbortController
    expect(controllerAfter).toBe(controllerBefore)
    expect(h.els.label.textContent).toBe(labelBefore)

    // Tidy: cancel + drain so the test doesn't leak an open Promise.
    h.els.cancel.click()
    await uploadPromise
  })
})

describe('upload bar — Retry button', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('retry on 413 → re-fires same File and completes', async () => {
    const h = mountHarness()
    showUploadAffordance(h.client)
    let attemptFiles: File[] = []
    let attempt = 0
    // First attempt: /start → 413 on first PATCH.
    // Second attempt (after retry): /start → happy 16-byte single chunk.
    h.setFetch((async (url, init) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        // Capture the File via the request body length / Content-Type
        // shape — we already captured the File above via the outer
        // scope so this just bumps attempt count.
        attempt += 1
        return jsonResponse(200, {
          upload_id: `u-retry-413-${attempt}`,
          chunk_size_bytes: 16,
          total_bytes: 16,
        })
      }
      if (attempt === 1) {
        return new Response('Request Entity Too Large', { status: 413 })
      }
      // Final happy chunk.
      void init
      return jsonResponse(200, {
        ok: true,
        status: 'complete',
        bytes_received: 16,
        source: 'chatgpt',
      })
    }) as typeof fetch)
    const file = fileOf(new Uint8Array(16), 'export.zip')
    // Spy on handleUploadFile to capture the File identity on each
    // call. Re-bind via Object.defineProperty so the instance's bound
    // method is replaced for our visibility.
    const c = h.client as unknown as {
      handleUploadFile: (f: File, s?: 'chatgpt' | 'claude') => Promise<void>
    }
    const orig = c.handleUploadFile.bind(h.client)
    c.handleUploadFile = async (f, s) => {
      attemptFiles.push(f)
      return orig(f, s)
    }

    await uploadViaInstance(h.client, file)
    // 413 → error state, retry button visible.
    expect(h.els.bar.classList.contains('error')).toBe(true)
    expect(h.els.retry.hidden).toBe(false)
    expect(h.els.label.textContent ?? '').toMatch(/Upload failed|413/)
    expect(attemptFiles.length).toBe(1)

    // User clicks Retry — handler re-fires with the SAME File.
    h.els.retry.click()
    // The retry click handler kicks off an async handleUploadFile. We
    // need to await its completion before asserting end state. Spin
    // ticks until uploadInFlight returns to false.
    for (let i = 0; i < 50; i += 1) {
      await tick(2)
      const inFlight = (h.client as unknown as { uploadInFlight: boolean }).uploadInFlight
      if (!inFlight) break
    }
    expect(attemptFiles.length).toBe(2)
    expect(attemptFiles[1]).toBe(file) // SAME File identity.
    // Second attempt was happy — error class cleared, retry hidden.
    expect(h.els.bar.classList.contains('error')).toBe(false)
    expect(h.els.retry.hidden).toBe(true)
  })

  test('retry on network error → re-fires and completes', async () => {
    const h = mountHarness()
    showUploadAffordance(h.client)
    let attempt = 0
    h.setFetch((async (url) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        attempt += 1
        if (attempt === 1) {
          throw new TypeError('NetworkError when attempting to fetch resource.')
        }
        return jsonResponse(200, {
          upload_id: 'u-retry-net',
          chunk_size_bytes: 16,
          total_bytes: 16,
        })
      }
      return jsonResponse(200, {
        ok: true,
        status: 'complete',
        bytes_received: 16,
        source: 'chatgpt',
      })
    }) as typeof fetch)
    const file = fileOf(new Uint8Array(16))

    await uploadViaInstance(h.client, file)
    expect(h.els.bar.classList.contains('error')).toBe(true)
    expect(h.els.retry.hidden).toBe(false)

    h.els.retry.click()
    for (let i = 0; i < 50; i += 1) {
      await tick(2)
      const inFlight = (h.client as unknown as { uploadInFlight: boolean }).uploadInFlight
      if (!inFlight) break
    }
    expect(h.els.bar.classList.contains('error')).toBe(false)
    expect(h.els.retry.hidden).toBe(true)
  })

  test('retry stays hidden after explicit cancel (no retry-on-abort)', async () => {
    const h = mountHarness()
    showUploadAffordance(h.client)
    h.setFetch((async (url, init) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        return jsonResponse(200, {
          upload_id: 'u-cancel-no-retry',
          chunk_size_bytes: 4,
          total_bytes: 16,
        })
      }
      return new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | null | undefined
        signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    }) as typeof fetch)
    const file = fileOf(new Uint8Array(16))
    const p = uploadViaInstance(h.client, file)
    await tick(5)
    h.els.cancel.click()
    await p
    expect(h.els.retry.hidden).toBe(true)
    // Cached attempt is also gone — clicking Retry programmatically
    // is a no-op (the listener bails on null lastUploadAttempt).
    expect(
      (h.client as unknown as { lastUploadAttempt: unknown }).lastUploadAttempt,
    ).toBeNull()
  })
})

describe('upload bar — AbortController lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('per-attempt controller — abort #1 does not poison #2', async () => {
    const h = mountHarness()
    showUploadAffordance(h.client)
    // Attempt 1: /start ok, PATCH waits for abort.
    // Attempt 2: /start ok, PATCH happy.
    let attempt = 0
    h.setFetch((async (url, init) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        attempt += 1
        return jsonResponse(200, {
          upload_id: `u-multi-${attempt}`,
          chunk_size_bytes: 16,
          total_bytes: 16,
        })
      }
      if (attempt === 1) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | null | undefined
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          })
        })
      }
      return jsonResponse(200, {
        ok: true,
        status: 'complete',
        bytes_received: 16,
        source: 'chatgpt',
      })
    }) as typeof fetch)

    const file1 = fileOf(new Uint8Array(16), 'first.zip')
    const p1 = uploadViaInstance(h.client, file1)
    await tick(5)
    // Cancel attempt 1.
    h.els.cancel.click()
    await p1
    // Controller is cleared after the first attempt.
    expect(
      (h.client as unknown as { uploadAbortController: unknown }).uploadAbortController,
    ).toBeNull()

    // Attempt 2 with a different File — happy path, no abort.
    const file2 = fileOf(new Uint8Array(16), 'second.zip')
    await uploadViaInstance(h.client, file2)
    expect(h.els.bar.classList.contains('error')).toBe(false)
    expect(h.els.retry.hidden).toBe(true)
    // Cache cleared on success.
    expect(
      (h.client as unknown as { lastUploadAttempt: unknown }).lastUploadAttempt,
    ).toBeNull()
  })
})

describe('upload bar — lastUploadAttempt cache invalidation', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  test('cache clears after a happy-path completion', async () => {
    const h = mountHarness()
    showUploadAffordance(h.client)
    h.setFetch((async (url) => {
      const u = typeof url === 'string' ? url : (url as Request).url
      if (u.endsWith('/start')) {
        return jsonResponse(200, {
          upload_id: 'u-happy-clear',
          chunk_size_bytes: 16,
          total_bytes: 16,
        })
      }
      return jsonResponse(200, {
        ok: true,
        status: 'complete',
        bytes_received: 16,
        source: 'chatgpt',
      })
    }) as typeof fetch)
    const file = fileOf(new Uint8Array(16))
    await uploadViaInstance(h.client, file)
    // After success: cache cleared, retry hidden, cancel hidden.
    expect(
      (h.client as unknown as { lastUploadAttempt: unknown }).lastUploadAttempt,
    ).toBeNull()
    expect(h.els.retry.hidden).toBe(true)
    expect(h.els.cancel.hidden).toBe(true)

    // Clicking Retry now is a no-op (the listener bails on null cache).
    // Verify by asserting the chunked client is NOT re-invoked: rebind
    // setFetch to throw if called, then click retry and confirm no
    // state change.
    let unexpectedCall = false
    h.setFetch((async () => {
      unexpectedCall = true
      throw new Error('retry should not have re-fired after happy completion')
    }) as unknown as typeof fetch)
    h.els.retry.click()
    await tick(5)
    expect(unexpectedCall).toBe(false)
  })
})
