/**
 * `gateway/transcription/openai-key-store.ts` — the OpenAI key RESOLUTION ORDER.
 *
 * The property under test is the order itself, not the shape of the code that
 * implements it:
 *
 *   1. the DEDICATED `openai_transcription` credential, when explicitly saved;
 *   2. else the SHARED general OpenAI credential (the semantic-memory key from
 *      Settings → Integrations);
 *   3. else `OPENAI_API_KEY` from the server environment;
 *   4. else nothing — and the caller's missing-key behaviour is unchanged.
 *
 * Step 2 is the reversal (SPEC § Decisions Log 2026-08-04 — "ONE OpenAI key
 * serves EVERY OpenAI-backed feature"): the key the owner pasted once now
 * transcribes his voice notes too, without a second paste. Step 1 outranking it
 * is what still lets anyone bill transcription to a separate key.
 *
 * ── Why the fake store is service-AWARE ─────────────────────────────────────
 * The sibling surface test's fake ignores the `service` argument entirely and
 * answers every lookup with the same row. That is fine for what it tests, and
 * useless here: the whole failure this file guards against is reading the WRONG
 * name, and a store that answers to any name cannot tell a correct lookup from
 * an incorrect one. So this fake keys on `service` and returns `null` for
 * anything it was not seeded with — a resolver that asked for `openai` or
 * `openai_api_key` would fail these tests rather than pass them by accident.
 *
 * The two stores really are separate (`project_credentials` here vs `api_keys`
 * + `secrets` behind `resolveSharedKey`), which is why the shared key arrives
 * through an injected thunk rather than another row in this fake.
 *
 * No real key material appears here: every value is an obvious fixture string.
 */

import { describe, expect, test } from 'bun:test'

import {
  OPENAI_TRANSCRIPTION_SERVICE,
  OpenAiKeyStore,
  type OpenAiKeyStoreDeps,
} from '../openai-key-store.ts'

const DEDICATED = 'fixture-dedicated-transcription-key'
const SHARED = 'fixture-shared-integrations-key'
const ENV = 'fixture-environment-key'

/**
 * A `ProjectCredentialStore` stand-in that answers ONLY for the service name it
 * was seeded under. `saved_at` is fixed so the assertions never touch the clock.
 */
function credentialStore(seed?: { service: string; plaintext: string }) {
  const rows = new Map<string, string>()
  if (seed !== undefined) rows.set(seed.service, seed.plaintext)
  return {
    getMeta: (_owner: unknown, _project: string, service: string) =>
      rows.has(service) ? { updated_at: '2026-08-04T00:00:00.000Z' } : null,
    resolve: (_owner: unknown, _project: string | undefined, service: string) => {
      const plaintext = rows.get(service)
      return plaintext === undefined ? null : { plaintext, scope: 'global', service }
    },
    set: async (_owner: unknown, input: { service: string; plaintext: string }) => {
      rows.set(input.service, input.plaintext)
    },
    delete: async (_owner: unknown, _project: string, service: string) => rows.delete(service),
  } as unknown as OpenAiKeyStoreDeps['store']
}

function make(opts: {
  dedicated?: string
  shared?: string
  env?: string
  /** Forces the shared lookup to throw, for the degradation case. */
  sharedThrows?: boolean
}): OpenAiKeyStore {
  return new OpenAiKeyStore({
    store: credentialStore(
      opts.dedicated === undefined
        ? undefined
        : { service: OPENAI_TRANSCRIPTION_SERVICE, plaintext: opts.dedicated },
    ),
    owner_slug: 'alice' as never,
    env: opts.env === undefined ? {} : { OPENAI_API_KEY: opts.env },
    resolveSharedKey: async () => {
      if (opts.sharedThrows === true) throw new Error('store unavailable')
      return opts.shared ?? null
    },
  })
}

describe('resolution order', () => {
  test('dedicated key set (and a shared key also present) → the DEDICATED key wins', async () => {
    // The precedence half of the contract: someone who deliberately scopes
    // transcription spend to its own key must keep getting that key even though
    // a general one exists — otherwise the dedicated row is decorative.
    const keys = make({ dedicated: DEDICATED, shared: SHARED, env: ENV })
    expect(await keys.resolve()).toBe(DEDICATED)

    const status = await keys.status()
    expect(status).toEqual({ present: true, source: 'stored', saved_at: '2026-08-04T00:00:00.000Z' })
  })

  test('dedicated ABSENT + shared present → the SHARED key is used', async () => {
    // The reversal itself, and the owner's actual complaint: one key pasted for
    // semantic search must transcribe voice notes too.
    const keys = make({ shared: SHARED })
    expect(await keys.resolve()).toBe(SHARED)

    const status = await keys.status()
    expect(status).toEqual({ present: true, source: 'shared', saved_at: null })
  })

  test('shared key outranks the environment, matching stored-beats-environment', async () => {
    // Both are "general", so the tie is broken the same way the dedicated row
    // already breaks it: the credential the owner saved IN THE APP is the more
    // deliberate act and the one he can change from a phone.
    const keys = make({ shared: SHARED, env: ENV })
    expect(await keys.resolve()).toBe(SHARED)
    expect((await keys.status()).source).toBe('shared')
  })

  test('dedicated and shared both absent → falls through to OPENAI_API_KEY', async () => {
    const keys = make({ env: ENV })
    expect(await keys.resolve()).toBe(ENV)
    expect(await keys.status()).toEqual({ present: true, source: 'environment', saved_at: null })
  })

  test('no key anywhere → null, and status reports absent (the missing-key path is unchanged)', async () => {
    // This is what `resolveTranscriber` turns into `openai_key_missing`. The
    // fallback must not manufacture a key out of an empty store.
    const keys = make({})
    expect(await keys.resolve()).toBeNull()
    expect(await keys.status()).toEqual({ present: false, source: null, saved_at: null })
  })
})

describe('the shared lookup cannot take transcription down', () => {
  test('an empty / whitespace-only shared key is treated as absent, not as a key', async () => {
    // A blank row must not shadow the environment — it would resolve a key of
    // '' and turn a working box into 401s at the OpenAI call.
    const keys = make({ shared: '   ', env: ENV })
    expect(await keys.resolve()).toBe(ENV)
    expect((await keys.status()).source).toBe('environment')
  })

  test('a throwing shared store degrades to the next source instead of propagating', async () => {
    // The status GET renders the whole Settings panel; a credential-store blip
    // must not 500 it, and must not stop a box that has an env key from
    // transcribing.
    const keys = make({ sharedThrows: true, env: ENV })
    expect(await keys.resolve()).toBe(ENV)
    expect((await keys.status()).source).toBe('environment')
  })

  test('a throwing shared store with no other source resolves to null, not a throw', async () => {
    const keys = make({ sharedThrows: true })
    expect(await keys.resolve()).toBeNull()
    expect((await keys.status()).present).toBe(false)
  })
})

describe('status and resolve agree', () => {
  // They are separate walks of the same order, so they can drift apart — and a
  // drift means Settings says "no key" while voice notes transcribe (or the
  // reverse). Pin them together across every combination rather than trusting
  // that the two functions stay in step.
  const cases: Array<{ name: string; opts: Parameters<typeof make>[0] }> = [
    { name: 'dedicated + shared + env', opts: { dedicated: DEDICATED, shared: SHARED, env: ENV } },
    { name: 'shared + env', opts: { shared: SHARED, env: ENV } },
    { name: 'dedicated + env', opts: { dedicated: DEDICATED, env: ENV } },
    { name: 'shared only', opts: { shared: SHARED } },
    { name: 'env only', opts: { env: ENV } },
    { name: 'nothing', opts: {} },
  ]

  for (const c of cases) {
    test(`presence matches a resolved key — ${c.name}`, async () => {
      const keys = make(c.opts)
      const resolved = await keys.resolve()
      const status = await keys.status()
      expect(status.present).toBe(resolved !== null)
    })
  }

  test('each source label names the credential that actually resolved', async () => {
    expect(await make({ dedicated: DEDICATED, shared: SHARED, env: ENV }).status()).toMatchObject({
      source: 'stored',
    })
    expect(await make({ shared: SHARED, env: ENV }).status()).toMatchObject({ source: 'shared' })
    expect(await make({ env: ENV }).status()).toMatchObject({ source: 'environment' })
  })
})

describe('the key never leaks', () => {
  test('status carries no key material for any source', async () => {
    for (const opts of [
      { dedicated: DEDICATED, shared: SHARED, env: ENV },
      { shared: SHARED },
      { env: ENV },
    ]) {
      const serialised = JSON.stringify(await make(opts).status())
      expect(serialised).not.toContain(DEDICATED)
      expect(serialised).not.toContain(SHARED)
      expect(serialised).not.toContain(ENV)
    }
  })
})
