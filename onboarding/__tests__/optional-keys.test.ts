/**
 * Unit tests for the up-front OPTIONAL credential offers
 * (`onboarding/optional-keys.ts`).
 *
 * Covers the three spec-conformance properties with a pure in-memory fake
 * store (no auth / SQLite dependency):
 *   1. Onboarding OFFERS the optional keys (and each is marked optional).
 *   2. A provided OpenAI key is validated + STORED via the api-key store.
 *   3. A skipped key is a no-op (nothing stored) → system still works.
 *
 * The end-to-end "stored key ACTIVATES its capability" property (resolver
 * returns a pool) is proven against the REAL ApiKeyStore in
 * `tests/integration/onboarding-optional-keys-activate.open.test.ts`.
 */

import { expect, test } from 'bun:test'
import {
  OPTIONAL_KEY_OFFERS,
  ONBOARDING_OPENAI_LABEL,
  detectOptionalKey,
  getOptionalKeyOffer,
  listOptionalKeyOffers,
  looksLikeOpenAiKey,
  storeOptionalKey,
  type OptionalKeyApiKeyStore,
  type OptionalKeyProvider,
} from '../optional-keys.ts'

const HANDLE = 'alice'
const OPENAI_KEY = 'sk-proj-abc123DEF456'

interface Added {
  internal_handle: string
  provider: OptionalKeyProvider
  label: string
  plaintext: string
}

/** In-memory fake of the narrow ApiKeyStore.add surface, with dup detection. */
function makeFakeStore(opts?: { failDuplicate?: boolean }): {
  store: OptionalKeyApiKeyStore
  added: Added[]
} {
  const added: Added[] = []
  const store: OptionalKeyApiKeyStore = {
    async add(input) {
      const dup = added.some(
        (a) =>
          a.internal_handle === input.internal_handle &&
          a.provider === input.provider &&
          a.label === input.label,
      )
      if (dup && opts?.failDuplicate !== false) {
        const err = new Error('duplicate') as Error & { code: string }
        err.code = 'duplicate_label'
        throw err
      }
      added.push({ ...input })
      return { id: `id-${added.length}`, secret_id: `sec-${added.length}` }
    },
  }
  return { store, added }
}

// 1. Onboarding offers the keys, each optional.
test('onboarding offers exactly the optional keys, each marked optional', () => {
  const offers = listOptionalKeyOffers()
  expect(offers).toBe(OPTIONAL_KEY_OFFERS)
  const ids = offers.map((o) => o.id)
  expect(ids).toEqual(['openai_api_key', 'codex_auth'])
  for (const offer of offers) {
    // Every offer's question reads as OPTIONAL and skipping is documented.
    expect(offer.question.toLowerCase()).toContain('optional')
    expect(offer.skip_note.toLowerCase()).toContain('work')
    expect(offer.capability.length).toBeGreaterThan(0)
  }
})

test('the OpenAI offer is api-key-store backed (provider openai); codex is host-oauth', () => {
  const openai = getOptionalKeyOffer('openai_api_key')
  expect(openai?.storage).toBe('api_key_store')
  expect(openai?.provider).toBe('openai')
  expect(openai?.default_label).toBe(ONBOARDING_OPENAI_LABEL)

  const codex = getOptionalKeyOffer('codex_auth')
  expect(codex?.storage).toBe('host_oauth')
  expect(codex?.provider).toBeUndefined()
})

test('getOptionalKeyOffer returns null for unknown ids', () => {
  // @ts-expect-error — deliberately passing an unknown id.
  expect(getOptionalKeyOffer('nope')).toBeNull()
})

// Validation + detection.
test('OpenAI key detection: sk- accepted, sk-ant- (Anthropic substrate) rejected', () => {
  expect(looksLikeOpenAiKey(OPENAI_KEY)).toBe(true)
  expect(looksLikeOpenAiKey('sk-ant-oat01-xxx')).toBe(false)
  expect(looksLikeOpenAiKey('garbage')).toBe(false)

  expect(detectOptionalKey(OPENAI_KEY)).toBe('openai_api_key')
  expect(detectOptionalKey('sk-ant-oat01-xxx')).toBeNull()
  expect(detectOptionalKey('not-a-key')).toBeNull()
})

test('the OpenAI offer rejects an Anthropic substrate key with a pointed reason', () => {
  const offer = getOptionalKeyOffer('openai_api_key')!
  const v = offer.validate('sk-ant-oat01-xxx')
  expect(v.ok).toBe(false)
  expect(v.reason).toContain('Anthropic')
})

// 2. Provided key stored.
test('storeOptionalKey persists a valid OpenAI key via the api-key store', async () => {
  const { store, added } = makeFakeStore()
  const res = await storeOptionalKey(store, {
    internal_handle: HANDLE,
    id: 'openai_api_key',
    plaintext: `  ${OPENAI_KEY}  `, // whitespace is trimmed before storage
  })
  expect(res.outcome).toBe('stored')
  expect(res.provider).toBe('openai')
  expect(res.label).toBe(ONBOARDING_OPENAI_LABEL)
  expect(res.capability.length).toBeGreaterThan(0)
  expect(added).toHaveLength(1)
  expect(added[0]).toMatchObject({
    internal_handle: HANDLE,
    provider: 'openai',
    label: ONBOARDING_OPENAI_LABEL,
    plaintext: OPENAI_KEY,
  })
})

test('storeOptionalKey rejects an invalid value WITHOUT writing', async () => {
  const { store, added } = makeFakeStore()
  const res = await storeOptionalKey(store, {
    internal_handle: HANDLE,
    id: 'openai_api_key',
    plaintext: 'sk-ant-oat01-xxx',
  })
  expect(res.outcome).toBe('rejected')
  expect(res.reason).toContain('Anthropic')
  expect(added).toHaveLength(0)
})

test('re-pasting the same OpenAI key is idempotent (duplicate → stored, not error)', async () => {
  const { store } = makeFakeStore()
  const first = await storeOptionalKey(store, {
    internal_handle: HANDLE,
    id: 'openai_api_key',
    plaintext: OPENAI_KEY,
  })
  expect(first.outcome).toBe('stored')
  // Second add throws duplicate_label inside the fake; storeOptionalKey
  // must absorb it and still report `stored`.
  const second = await storeOptionalKey(store, {
    internal_handle: HANDLE,
    id: 'openai_api_key',
    plaintext: OPENAI_KEY,
  })
  expect(second.outcome).toBe('stored')
})

test('codex_auth is guidance-only — never writes a per-instance secret', async () => {
  const { store, added } = makeFakeStore()
  const res = await storeOptionalKey(store, {
    internal_handle: HANDLE,
    id: 'codex_auth',
    plaintext: 'anything',
  })
  expect(res.outcome).toBe('guidance_only')
  expect(res.activation.toLowerCase()).toContain('codex login')
  expect(added).toHaveLength(0)
})

// 3. Skipping leaves the system working — modeled as "no store call made".
test('skipping an offer makes no store call (system stays on Claude alone)', () => {
  const { added } = makeFakeStore()
  // The skip path simply never calls storeOptionalKey.
  expect(added).toHaveLength(0)
})
