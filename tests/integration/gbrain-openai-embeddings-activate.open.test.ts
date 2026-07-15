/**
 * GBrain semantic-embeddings activation — the onboarding/admin OpenAI key
 * reaches the embedder resolver and flips GBrain from the local Ollama
 * fallback to OpenAI `text-embedding-3-large`.
 *
 * This proves the END-TO-END property the unit tests stub out, and closes the
 * gap behind "Openai embeddings key is supposed to be wired to Gbrain":
 *
 *   1. A key stored through the canonical onboarding seam (`storeOptionalKey`)
 *      lands in the REAL per-instance `ApiKeyStore` (provider=openai,
 *      label=onboarding) — the SAME row the admin Integrations surface writes.
 *   2. `resolveOnboardingOpenAiKey` reads it back from that store (the LAZY
 *      thunk the composer threads into `buildGBrainMemory`, resolved at the
 *      first `gbrain serve` spawn — NOT at boot, so a key captured after the
 *      server is already running still activates).
 *   3. `resolveEffectiveEmbedder` then selects the OpenAI embedder →
 *      `openai:text-embedding-3-large` @ 768d (RA3: the SHARED width with the
 *      local Ollama fallback a fresh install already created its column
 *      at — see `gbrain-memory/embedder-config.ts`'s "Shared 768-dim column
 *      width" doc — so this upgrades an existing brain IN PLACE, no rebuild),
 *      and its `childEnv` carries the `GBRAIN_EMBEDDING_*` selectors +
 *      `OPENAI_API_KEY` the `gbrain serve` child reads to compute embeddings.
 *   4. SKIPPED key (never stored) → resolver returns undefined → effective
 *      embedder falls to RA3's DEFAULT: the local Ollama fallback (hybrid
 *      recall out of the box, no regression — just no longer `null`).
 *
 * The live `gbrain serve` / OpenAI embed call needs a real binary + key, so
 * those are verified-via-wiring here: we assert the resolved embedder + childEnv
 * the serve child WOULD receive, which is exactly the seam under test.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ApiKeyStore } from '@neutronai/auth/api-key-store.ts'
import { storeOptionalKey } from '@neutronai/onboarding/optional-keys.ts'
import { resolveOnboardingOpenAiKey } from '@neutronai/gateway/wiring/resolve-onboarding-openai-key.ts'
import { resolveEffectiveEmbedder } from '@neutronai/gateway/wiring/build-gbrain-memory.ts'

const OWNER = 'alice'
const OPENAI_KEY = 'sk-proj-onboarding-abc123DEF456'

let root: string
let dataDir: string
let db: ProjectDb

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-embed-'))
  dataDir = join(root, 'owner')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(root, 'owner.db')
  const raw = new Database(dbPath, { create: true })
  applyMigrations(raw)
  raw.close()
  db = ProjectDb.open(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('onboarding-captured OpenAI key → resolver reads it → effective embedder is OpenAI semantic', async () => {
  // 1. Store the key exactly as onboarding / admin Integrations do.
  const secrets = new SecretsStore({ data_dir: dataDir, db })
  const apiKeys = new ApiKeyStore({ db, secrets })
  const res = await storeOptionalKey(apiKeys, {
    internal_handle: OWNER,
    id: 'openai_api_key',
    plaintext: OPENAI_KEY,
  })
  expect(res.outcome).toBe('stored')

  // 2. The composer's LAZY thunk reads it back from the store.
  const resolved = await resolveOnboardingOpenAiKey({
    db,
    owner_home: dataDir,
    internal_handle: OWNER,
    project_slug: OWNER,
  })
  expect(resolved).toBe(OPENAI_KEY)

  // 3. The embedder resolver flips to OpenAI semantic embeddings, at the
  //    SHARED 768-dim width (RA3) — matching the column a fresh install's
  //    local Ollama fallback already created, so this upgrades in place.
  const embedder = resolveEffectiveEmbedder({ env: {}, openaiApiKey: resolved })
  expect(embedder).not.toBeNull()
  expect(embedder!.model).toBe('text-embedding-3-large')
  expect(embedder!.dimensions).toBe(768)
  // The exact childEnv the `gbrain serve` child receives → semantic active.
  expect(embedder!.childEnv).toEqual({
    GBRAIN_EMBEDDING_MODEL: 'openai:text-embedding-3-large',
    GBRAIN_EMBEDDING_DIMENSIONS: '768',
    OPENAI_API_KEY: OPENAI_KEY,
  })
})

test('no key stored → resolver returns undefined → effective embedder is the RA3 default (local Ollama fallback)', async () => {
  // Nothing was ever stored (the owner skipped the offer).
  const resolved = await resolveOnboardingOpenAiKey({
    db,
    owner_home: dataDir,
    internal_handle: OWNER,
    project_slug: OWNER,
  })
  expect(resolved).toBeUndefined()

  // With no key and no env opt-in, the effective embedder is RA3's DEFAULT:
  // the local Ollama fallback — hybrid recall out of the box, no OpenAI
  // involvement at all.
  const embedder = resolveEffectiveEmbedder({ env: {}, openaiApiKey: resolved })
  expect(embedder).not.toBeNull()
  expect(embedder!.provider).toBe('ollama')
  expect(embedder!.childEnv['OPENAI_API_KEY']).toBeUndefined()
})

test('a bare env OPENAI_API_KEY (LLM BYO key) does NOT silently activate CLOUD embeddings', async () => {
  // The onboarding store is empty; only a bare env key exists (the GPT BYO
  // adapter key). It must NOT flip on CLOUD embeddings without the explicit
  // NEUTRON_EMBEDDINGS=openai|auto opt-in — the RA3 default still resolves
  // to the FREE local Ollama fallback, never to OpenAI off a bare LLM key.
  const resolved = await resolveOnboardingOpenAiKey({
    db,
    owner_home: dataDir,
    internal_handle: OWNER,
  })
  expect(resolved).toBeUndefined()
  const embedder = resolveEffectiveEmbedder({
    env: { OPENAI_API_KEY: 'sk-llm-only' },
    openaiApiKey: resolved,
  })
  expect(embedder).not.toBeNull()
  expect(embedder!.provider).toBe('ollama')
  expect(embedder!.childEnv['OPENAI_API_KEY']).toBeUndefined()
})
