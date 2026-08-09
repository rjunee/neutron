/**
 * Where the Kimi key comes from, and the one side effect that makes it usable.
 *
 * The integration test (`tests/integration/kimi-panelist-wired.open.test.ts`)
 * proves the PRODUCTION COMPOSER reaches this; these pin the decisions inside it,
 * which a composition test can only observe through several layers.
 */
import { describe, expect, test } from 'bun:test'

import {
  ensureKimiKeyExported,
  resolveKimiApiKey,
  KIMI_API_KEY_ENV,
} from './kimi-key.ts'

describe('resolveKimiApiKey — env first, store second', () => {
  test('the env value wins whenever it is set', () => {
    // The compatibility guarantee: an install already exporting the key must keep
    // using exactly that one, whatever sits in the store.
    expect(resolveKimiApiKey('sk-env', () => 'sk-store')).toBe('sk-env')
  })

  test('the store is used when env is absent', () => {
    expect(resolveKimiApiKey(undefined, () => 'sk-store')).toBe('sk-store')
    expect(resolveKimiApiKey(null, () => 'sk-store')).toBe('sk-store')
  })

  test('an EMPTY or whitespace env value does not mask a good stored key', () => {
    // `export KIMI_API_KEY=` is the most common way a key is "set" and useless.
    // Letting it win would make the stored key unreachable, and the failure would
    // look like a bug in the store rather than in the shell.
    expect(resolveKimiApiKey('', () => 'sk-store')).toBe('sk-store')
    expect(resolveKimiApiKey('   ', () => 'sk-store')).toBe('sk-store')
  })

  test('a blank STORED value is absent too', () => {
    expect(resolveKimiApiKey(undefined, () => '')).toBeNull()
    expect(resolveKimiApiKey(undefined, () => '  ')).toBeNull()
  })

  test('no lookup at all is simply "not configured"', () => {
    expect(resolveKimiApiKey(undefined, null)).toBeNull()
  })

  test('a THROWING store read degrades to not-configured, never to a crash', () => {
    // A locked or corrupt credential row must not take down a review launch. Not
    // configured is the graceful path the panel already handles.
    expect(
      resolveKimiApiKey(undefined, () => {
        throw new Error('db locked')
      }),
    ).toBeNull()
  })

  test('the value is trimmed, so a pasted key with a trailing newline still works', () => {
    expect(resolveKimiApiKey(undefined, () => 'sk-store\n')).toBe('sk-store')
  })
})

describe('ensureKimiKeyExported — the subprocess has to be able to see it', () => {
  test('a stored key is written into the environment', () => {
    // THE LOAD-BEARING ONE. `kimi-review-cli.ts` reads this variable from its own
    // process env — the indirection that keeps the key out of prompt text. Report
    // configured without exporting and the child defers, and a deferred
    // cross-model reviewer BLOCKS the verdict: every review returns
    // REQUEST_CHANGES for a reason the owner cannot see.
    const env: Record<string, string | undefined> = {}
    expect(ensureKimiKeyExported(env, () => 'sk-store')).toBe(true)
    expect(env[KIMI_API_KEY_ENV]).toBe('sk-store')
  })

  test('an operator-set env value is left EXACTLY as they set it', () => {
    const env: Record<string, string | undefined> = { [KIMI_API_KEY_ENV]: 'sk-env' }
    expect(ensureKimiKeyExported(env, () => 'sk-store')).toBe(true)
    expect(env[KIMI_API_KEY_ENV]).toBe('sk-env')
  })

  test('no key anywhere → false, and nothing is written', () => {
    const env: Record<string, string | undefined> = {}
    expect(ensureKimiKeyExported(env, () => null)).toBe(false)
    expect(KIMI_API_KEY_ENV in env).toBe(false)
  })

  test('an empty env var is REPLACED by the stored key, not left in place', () => {
    // The pair of the masking case above: resolving correctly is not enough if the
    // child still inherits the empty string.
    const env: Record<string, string | undefined> = { [KIMI_API_KEY_ENV]: '' }
    expect(ensureKimiKeyExported(env, () => 'sk-store')).toBe(true)
    expect(env[KIMI_API_KEY_ENV]).toBe('sk-store')
  })

  test('it is idempotent — a second call changes nothing', () => {
    const env: Record<string, string | undefined> = {}
    ensureKimiKeyExported(env, () => 'sk-store')
    ensureKimiKeyExported(env, () => 'sk-store')
    expect(env[KIMI_API_KEY_ENV]).toBe('sk-store')
  })
})
