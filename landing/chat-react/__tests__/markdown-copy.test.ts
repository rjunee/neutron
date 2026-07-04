/**
 * FIX #359 (Codex r1 P1) — the code-block copy button must degrade GRACEFULLY.
 * `navigator.clipboard` is `undefined` in an insecure context / older browser,
 * and property access on it throws SYNCHRONOUSLY — a `.catch()` on the
 * `writeText` promise never runs, so the original handler crashed instead of
 * staying inert. `copyTextToClipboard` guards the access and returns a boolean
 * (never throws), so the button no-ops when copy isn't available. Pins: no
 * clipboard → false (no throw), a working clipboard → true + writeText called,
 * a rejecting clipboard (permission denied) → false.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { copyTextToClipboard } from '../Markdown.tsx'

const originalClipboard = (globalThis.navigator as Navigator | undefined)?.clipboard

function setClipboard(value: unknown): void {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value,
    configurable: true,
    writable: true,
  })
}

afterEach(() => {
  if (typeof globalThis.navigator !== 'undefined') setClipboard(originalClipboard)
})

describe('copyTextToClipboard', () => {
  test('returns false (never throws) when the Clipboard API is absent', async () => {
    setClipboard(undefined)
    expect(await copyTextToClipboard('const x = 1;')).toBe(false)
  })

  test('returns false when clipboard exists but lacks writeText', async () => {
    setClipboard({})
    expect(await copyTextToClipboard('const x = 1;')).toBe(false)
  })

  test('writes the text and returns true when the Clipboard API works', async () => {
    let written: string | null = null
    setClipboard({
      writeText: (t: string): Promise<void> => {
        written = t
        return Promise.resolve()
      },
    })
    expect(await copyTextToClipboard('hello code')).toBe(true)
    expect(written).toBe('hello code')
  })

  test('returns false (not a rejection) when writeText is denied', async () => {
    setClipboard({
      writeText: (): Promise<void> => Promise.reject(new Error('permission denied')),
    })
    expect(await copyTextToClipboard('secret')).toBe(false)
  })
})
