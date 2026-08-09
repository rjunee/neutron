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

describe('resolveKimiApiKey — the STORE is the only source', () => {
  test('the stored key is used', () => {
    expect(resolveKimiApiKey(() => 'sk-store')).toBe('sk-store')
  })

  test('INVERTED 2026-08-09: an env value no longer wins — it is not even read', () => {
    // This test used to assert the OPPOSITE ("the env value wins whenever it is
    // set"), as a compatibility guarantee for installs already exporting the key.
    // The owner removed that: an env var beating the store is a second resolution
    // path, so the same settings screen behaves differently on two boxes depending
    // on how one was provisioned — and it fails in the direction nobody checks,
    // with the screen reporting a saved key that every review then ignores.
    //
    // Inverted rather than deleted so the reversal stays legible in history. The
    // resolver no longer takes an env argument at all, which is the strongest form
    // of "it is not read": there is nothing to pass.
    const stored = resolveKimiApiKey(() => 'sk-store')
    expect(stored).toBe('sk-store')
    expect(resolveKimiApiKey.length).toBe(1)
  })

  test('a blank STORED value is absent', () => {
    expect(resolveKimiApiKey(() => '')).toBeNull()
    expect(resolveKimiApiKey(() => '  ')).toBeNull()
  })

  test('no lookup at all is simply "not configured"', () => {
    expect(resolveKimiApiKey(null)).toBeNull()
  })

  test('a THROWING store read degrades to not-configured, never to a crash', () => {
    // A locked or corrupt credential row must not take down a review launch. Not
    // configured is the graceful path the panel already handles.
    expect(
      resolveKimiApiKey(() => {
        throw new Error('db locked')
      }),
    ).toBeNull()
  })

  test('the value is trimmed, so a pasted key with a trailing newline still works', () => {
    expect(resolveKimiApiKey(() => 'sk-store\n')).toBe('sk-store')
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

  test('INVERTED: a pre-set env value is OVERWRITTEN by the stored key', () => {
    // This used to assert the opposite — that an operator-set value was left
    // exactly as they set it. That was the env-as-a-source behaviour, and it is
    // precisely the silent failure the owner removed: paste a new key in settings,
    // see it saved, and every review keeps using the one from the shell.
    const env: Record<string, string | undefined> = { [KIMI_API_KEY_ENV]: 'sk-stale-env' }
    expect(ensureKimiKeyExported(env, () => 'sk-store')).toBe(true)
    expect(env[KIMI_API_KEY_ENV]).toBe('sk-store')
  })

  test('CLEARING the key in settings clears the exported value too', () => {
    // The mirror image, and the half that is easy to forget: without the delete, a
    // previously-exported key would survive in the process environment and the
    // reviewer would keep running on a credential the owner believes they removed.
    const env: Record<string, string | undefined> = { [KIMI_API_KEY_ENV]: 'sk-previously-exported' }
    expect(ensureKimiKeyExported(env, () => null)).toBe(false)
    expect(KIMI_API_KEY_ENV in env).toBe(false)
  })

  test('no key anywhere → false, and nothing is written', () => {
    const env: Record<string, string | undefined> = {}
    expect(ensureKimiKeyExported(env, () => null)).toBe(false)
    expect(KIMI_API_KEY_ENV in env).toBe(false)
  })

  test('an empty env var is REPLACED by the stored key, not left in place', () => {
    // Resolving correctly is not enough if the child still inherits the empty
    // string.
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
