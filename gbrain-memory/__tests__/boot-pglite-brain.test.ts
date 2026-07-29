/**
 * Unit tests for the shared real-PGLite boot helper's transient-failure
 * handling (ISSUES #327 + #79).
 *
 * These DON'T boot a real brain (the real round-trip is exercised by
 * sync-hook / scribe / connect suites). They pin the retry CONTRACT that makes
 * the CI flake self-heal without masking real errors:
 *   - the WASM-init failure shape (#327) is classified transient + retried;
 *   - the bootstrap-probe shape (#79) is still classified transient + retried;
 *   - a deterministic error (schema/SQL/config) is NOT retried;
 *   - the retry is BOUNDED and surfaces the ORIGINAL error when exhausted.
 */

import { describe, test, expect } from 'bun:test'
import {
  isTransientBoot,
  withTransientBootRetry,
} from './boot-pglite-brain.ts'

const noSleep = async (): Promise<void> => {}

// The exact gbrain wrapper header (pglite-engine.ts buildPgliteInitErrorMessage)
// that #327 reported on CI — the WASM-init step failing to extract pglite.data.
const WASM_INIT_ERROR =
  'PGLite failed to initialize its WASM runtime.\n' +
  '  This looks like a Bun vfs issue: `/$$bunfs/root` is read-only on\n' +
  '  your system, so PGLite cannot extract its pglite.data WASM payload.\n' +
  '  Original error: RuntimeError: abort(OOM)'

// The #79 bootstrap-probe race shape PR #13 already handled.
const PROBE_ERROR =
  "TypeError: undefined is not an object (evaluating 'probe.pages_exists')"

describe('isTransientBoot — classifier', () => {
  test('classifies the #327 WASM-init failure as transient', () => {
    expect(isTransientBoot(new Error(WASM_INIT_ERROR))).toBe(true)
  })

  test('classifies the #79 bootstrap-probe race as transient', () => {
    expect(isTransientBoot(new Error(PROBE_ERROR))).toBe(true)
  })

  test('classifies the raw PGLite fs-bundle byteLength guard as transient', () => {
    expect(isTransientBoot(new Error('Invalid FS bundle size: 0 !== 12345678'))).toBe(true)
  })

  test('does NOT classify a real schema/SQL error as transient', () => {
    // A migration/SQL failure happens AFTER PGlite.create() and lacks the
    // WASM-init header — it must surface, never be retried away.
    expect(isTransientBoot(new Error('relation "pages" already exists'))).toBe(false)
    expect(isTransientBoot(new Error('syntax error at or near "SELCT"'))).toBe(false)
    expect(isTransientBoot(new Error('column "links_extracted_at" does not exist'))).toBe(false)
  })

  test('handles non-Error throwables without crashing', () => {
    expect(isTransientBoot('PGLite failed to initialize its WASM runtime')).toBe(true)
    expect(isTransientBoot(undefined)).toBe(false)
  })
})

describe('withTransientBootRetry — bounded, transient-only', () => {
  test('self-heals a transient WASM-init failure (fails twice, then succeeds)', async () => {
    let calls = 0
    const retries: number[] = []
    const result = await withTransientBootRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error(WASM_INIT_ERROR)
        return 'booted'
      },
      { sleep: noSleep, onRetry: (attempt) => retries.push(attempt) },
    )
    expect(result).toBe('booted')
    expect(calls).toBe(3)
    expect(retries).toEqual([1, 2]) // retried after attempts 1 and 2
  })

  test('does NOT retry a deterministic (non-transient) error — surfaces on first throw', async () => {
    let calls = 0
    await expect(
      withTransientBootRetry(
        async () => {
          calls++
          throw new Error('relation "pages" already exists')
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('relation "pages" already exists')
    expect(calls).toBe(1) // real error is NOT masked by a retry
  })

  test('is bounded: a persistent transient failure exhausts attempts then rethrows the ORIGINAL error', async () => {
    let calls = 0
    await expect(
      withTransientBootRetry(
        async () => {
          calls++
          throw new Error(WASM_INIT_ERROR)
        },
        { maxAttempts: 4, sleep: noSleep },
      ),
    ).rejects.toThrow('PGLite failed to initialize its WASM runtime')
    expect(calls).toBe(4) // tried exactly maxAttempts, then gave up loudly
  })

  test('succeeds on the first try without retrying when the boot is healthy', async () => {
    let calls = 0
    const retries: number[] = []
    const result = await withTransientBootRetry(
      async () => {
        calls++
        return 42
      },
      { sleep: noSleep, onRetry: (a) => retries.push(a) },
    )
    expect(result).toBe(42)
    expect(calls).toBe(1)
    expect(retries).toEqual([])
  })
})
