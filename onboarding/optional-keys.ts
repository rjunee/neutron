/**
 * @neutronai/onboarding — up-front OPTIONAL credential offers.
 *
 * WAVE 1 credential-management: onboarding offers the common optional keys
 * UP FRONT as optional questions. Each offer is strictly OPTIONAL — the
 * system runs fully on Claude Max OAuth (or a BYO Anthropic key) alone with
 * none of these set. Skipping any offer leaves the system fully working;
 * providing one ADDITIVELY activates a capability.
 *
 * This module is the single source of truth for:
 *   1. WHICH optional keys onboarding asks about (`OPTIONAL_KEY_OFFERS`).
 *   2. HOW a provided key is validated + persisted — via the EXISTING
 *      `auth/api-key-store.ts:ApiKeyStore` (the same store the admin
 *      add/rotate UI and the runtime credential resolver use; we reuse it
 *      rather than duplicating a second key path).
 *   3. WHAT capability each key activates, and what (if anything) the
 *      operator must additionally opt into for the capability to come live.
 *
 * Activation map (see docs/SYSTEM-OVERVIEW.md):
 *   - `openai_api_key` → stored via ApiKeyStore(provider='openai'). Becomes
 *     resolvable by `gateway/wiring/resolve-llm-credentials.ts`
 *     (→ `auth/byo-api-key-fallback.ts:buildBYOApiKeyPool`), which ACTIVATES
 *     the OpenAI / GPT-5 API adapter used for cross-model trident reviews.
 *     The SAME key also backs cloud embeddings
 *     (`gbrain-memory/embedder-config.ts`), which additionally require the
 *     explicit `NEUTRON_EMBEDDINGS=openai|auto` opt-in — a deliberate cost
 *     guard, so a bare key never silently bills embeddings.
 *   - `codex_auth` → the Codex CLI subscription OAuth (`codex login`), which
 *     is a HOST-level credential under `CODEX_HOME`, not a per-instance paste
 *     secret. The offer surfaces it as guidance; there is no ApiKeyStore row
 *     to write (the `ApiKeyProvider` enum has no `codex`). Operators who
 *     prefer a platform key instead can use the `openai_api_key` offer, which
 *     the GPT-5 API adapter consumes for the same cross-model reviews.
 */

/**
 * Provider union, mirroring `auth/api-key-store.ts:ApiKeyProvider`. Declared
 * locally so `@neutronai/onboarding` stays decoupled from `@neutronai/auth`
 * — the engine uses the same narrow-interface pattern for its SecretsStore
 * surface (`MaxOauthSecretsStore`) so tests can inject a mock without
 * dragging in the SQLite-backed store. Production adapts the real
 * `ApiKeyStore` to `OptionalKeyApiKeyStore` below.
 */
export type OptionalKeyProvider = 'anthropic' | 'openai' | 'gemini'

/**
 * Narrow slice of `auth/api-key-store.ts:ApiKeyStore` this module needs —
 * just the `add` call. The full `ApiKeyStore` satisfies this structurally,
 * so the production composer passes it directly; tests inject an in-memory
 * fake. Keeping the surface narrow preserves the onboarding↔auth boundary.
 */
export interface OptionalKeyApiKeyStore {
  add(input: {
    internal_handle: string
    provider: OptionalKeyProvider
    label: string
    plaintext: string
  }): Promise<{ id: string; secret_id: string }>
}

/** Stable id for each optional-key onboarding question. */
export type OptionalKeyId = 'openai_api_key' | 'codex_auth'

/**
 * How a provided value for an offer is stored:
 *   - `api_key_store` — a per-instance secret persisted via `ApiKeyStore`
 *     (provider on `provider`). Validated + storable during onboarding.
 *   - `host_oauth`    — a host-level OAuth managed OUTSIDE the per-instance
 *     secret store (e.g. the Codex CLI under `CODEX_HOME`). Onboarding
 *     surfaces guidance only; there is no secret to persist here.
 */
export type OptionalKeyStorage = 'api_key_store' | 'host_oauth'

export interface OptionalKeyValidation {
  ok: boolean
  /** Present (and human-facing) only when `ok === false`. */
  reason?: string
}

export interface OptionalKeyOffer {
  id: OptionalKeyId
  /** Short title for the offer (button / heading copy). */
  title: string
  /** The optional question onboarding asks up front. */
  question: string
  /** Capability the key unlocks, one line. */
  capability: string
  /**
   * What must additionally be true for the capability to come live after
   * the key is stored (e.g. an env opt-in). Empty string ⇒ stored = live.
   */
  activation: string
  /** What skipping this offer means — always "system still works". */
  skip_note: string
  storage: OptionalKeyStorage
  /**
   * ApiKeyStore provider for `api_key_store` offers; `undefined` for
   * `host_oauth` offers (nothing is persisted per-instance).
   */
  provider?: OptionalKeyProvider
  /**
   * Default ApiKeyStore label used when onboarding stores the key without
   * an explicit label. `undefined` for `host_oauth` offers.
   */
  default_label?: string
  /**
   * Validate a pasted value. For `host_oauth` offers this always returns
   * `{ ok: false }` with guidance, since there is no value to store.
   */
  validate: (plaintext: string) => OptionalKeyValidation
}

/** Default ApiKeyStore label for the onboarding-provided OpenAI key. */
export const ONBOARDING_OPENAI_LABEL = 'onboarding'

/**
 * Anthropic substrate keys (`sk-ant-…`) are NOT an optional add-on — they
 * are the primary LLM substrate handled by the `max_oauth_offered` BYO
 * paste path. An OpenAI key is any `sk-…` that is NOT `sk-ant-…` (covers
 * both legacy `sk-…` and project-scoped `sk-proj-…` keys).
 */
export function looksLikeOpenAiKey(plaintext: string): boolean {
  const v = plaintext.trim()
  return v.startsWith('sk-') && !v.startsWith('sk-ant-')
}

const OPENAI_OFFER: OptionalKeyOffer = {
  id: 'openai_api_key',
  title: 'Add an OpenAI key (sharper memory)',
  question:
    'Do you have an OpenAI API key? Paste it for semantic-search embeddings — ' +
    'sharper memory recall — plus cross-model GPT-5 reviews. Optional; memory ' +
    'works without it (keyword + graph). Key: platform.openai.com/api-keys ' +
    "(OpenAI sign-in/OAuth doesn't cover embeddings).",
  capability: 'Semantic-search embeddings (sharper memory recall) + cross-model GPT-5 reviews',
  activation:
    'Stored now; memory flips to semantic embeddings on your next turn — the ' +
    'key alone enables it (no extra flag) and existing pages embed in the ' +
    'background. OpenAI bills per embedding (explicit opt-in). GPT-5 reviews ' +
    'activate next boot.',
  skip_note: 'No key → recall stays keyword + graph (works, just not semantic).',
  storage: 'api_key_store',
  provider: 'openai',
  default_label: ONBOARDING_OPENAI_LABEL,
  validate: (plaintext: string): OptionalKeyValidation => {
    const v = plaintext.trim()
    if (v.length === 0) return { ok: false, reason: 'Empty — paste your OpenAI API key or skip.' }
    if (v.startsWith('sk-ant-')) {
      return {
        ok: false,
        reason:
          "That's an Anthropic key (sk-ant-…), which is your Claude substrate, " +
          'not an optional OpenAI key. Use the Connect-Max / paste step for that.',
      }
    }
    if (!looksLikeOpenAiKey(v)) {
      return { ok: false, reason: "That doesn't look like an OpenAI API key (they start with sk-)." }
    }
    return { ok: true }
  },
}

const CODEX_OFFER: OptionalKeyOffer = {
  id: 'codex_auth',
  title: 'Connect Codex (cross-model reviews)',
  question:
    'Optional: sign in to the Codex CLI (`codex login`) to use your ChatGPT ' +
    'subscription for cross-model trident reviews. Skip to keep single-model reviews.',
  capability: 'Cross-model trident reviews via your ChatGPT subscription',
  activation:
    'Run `codex login` on the host (stored under CODEX_HOME, managed by the ' +
    'Codex CLI). Prefer a platform key instead? Use the OpenAI-key offer — the ' +
    'GPT-5 API adapter consumes it for the same cross-model reviews.',
  skip_note: 'No Codex auth → trident reviews run single-model (Claude). Fully working.',
  storage: 'host_oauth',
  validate: (): OptionalKeyValidation => ({
    ok: false,
    reason:
      'Codex auth is a host-level login (`codex login`), not a paste secret. ' +
      'Run it on the host, or paste an OpenAI key instead for cross-model reviews.',
  }),
}

/**
 * The optional-key offers, in the order onboarding surfaces them. Ordered
 * OpenAI-first because it is the one a user can satisfy inline (a paste),
 * and it unlocks the broadest set of capabilities.
 */
export const OPTIONAL_KEY_OFFERS: ReadonlyArray<OptionalKeyOffer> = [
  OPENAI_OFFER,
  CODEX_OFFER,
]

/** All offers (defensive copy of the canonical list). */
export function listOptionalKeyOffers(): ReadonlyArray<OptionalKeyOffer> {
  return OPTIONAL_KEY_OFFERS
}

/** Look up a single offer by id, or `null` when unknown. */
export function getOptionalKeyOffer(id: OptionalKeyId): OptionalKeyOffer | null {
  return OPTIONAL_KEY_OFFERS.find((o) => o.id === id) ?? null
}

/**
 * Classify a pasted value against the offers, so the onboarding paste step
 * can recognise an OpenAI key the user pastes alongside the substrate
 * choice WITHOUT a dedicated button. Returns the offer id when the value
 * validates for exactly one `api_key_store` offer, else `null`.
 */
export function detectOptionalKey(plaintext: string): OptionalKeyId | null {
  for (const offer of OPTIONAL_KEY_OFFERS) {
    if (offer.storage !== 'api_key_store') continue
    if (offer.validate(plaintext).ok) return offer.id
  }
  return null
}

export type StoreOptionalKeyOutcome = 'stored' | 'rejected' | 'guidance_only'

export interface StoreOptionalKeyResult {
  id: OptionalKeyId
  outcome: StoreOptionalKeyOutcome
  /** ApiKeyStore provider used (only for `stored`). */
  provider?: OptionalKeyProvider
  /** ApiKeyStore label used (only for `stored`). */
  label?: string
  /** Capability that the stored key activates. */
  capability: string
  /** Activation requirement copy (what else, if anything, is needed). */
  activation: string
  /** Human-facing rejection reason (only for `rejected`). */
  reason?: string
}

export interface StoreOptionalKeyInput {
  /** Frozen `internal_handle` for the instance (see auth/secrets-store.ts). */
  internal_handle: string
  id: OptionalKeyId
  plaintext: string
  /** Override the default ApiKeyStore label (e.g. to avoid a dup). */
  label?: string
}

/**
 * Validate + persist a provided optional key through the EXISTING
 * `ApiKeyStore`. This is the shared seam onboarding and the admin add/rotate
 * surface both use — there is one key path, not two.
 *
 *   - `api_key_store` offer, valid value → `ApiKeyStore.add(...)`, returns
 *     `outcome: 'stored'`. The stored key is now resolvable by the runtime
 *     credential resolver, which ACTIVATES its capability.
 *   - `api_key_store` offer, invalid value → `outcome: 'rejected'` + reason
 *     (no write).
 *   - `host_oauth` offer (Codex) → `outcome: 'guidance_only'` (nothing to
 *     persist per-instance; the offer's `activation` tells the user what to do).
 *
 * Never throws on a duplicate label: a re-paste of the same offer returns
 * `outcome: 'stored'` idempotently (the existing row is reused), so a user
 * who pastes twice is not stranded.
 */
export async function storeOptionalKey(
  apiKeys: OptionalKeyApiKeyStore,
  input: StoreOptionalKeyInput,
): Promise<StoreOptionalKeyResult> {
  const offer = getOptionalKeyOffer(input.id)
  if (offer === null) {
    return {
      id: input.id,
      outcome: 'rejected',
      capability: '',
      activation: '',
      reason: `unknown optional key offer: ${input.id}`,
    }
  }

  if (offer.storage === 'host_oauth') {
    return {
      id: offer.id,
      outcome: 'guidance_only',
      capability: offer.capability,
      activation: offer.activation,
    }
  }

  const validation = offer.validate(input.plaintext)
  if (!validation.ok) {
    return {
      id: offer.id,
      outcome: 'rejected',
      capability: offer.capability,
      activation: offer.activation,
      // `exactOptionalPropertyTypes` — omit rather than set `undefined`.
      ...(validation.reason !== undefined ? { reason: validation.reason } : {}),
    }
  }

  // `offer.provider` / `default_label` are always set for api_key_store offers.
  const provider = offer.provider as OptionalKeyProvider
  const label = input.label ?? offer.default_label ?? ONBOARDING_OPENAI_LABEL

  try {
    await apiKeys.add({
      internal_handle: input.internal_handle,
      provider,
      label,
      plaintext: input.plaintext.trim(),
    })
  } catch (err) {
    // Idempotent re-paste: a duplicate label means the key is already
    // stored + activating. Surface as `stored`, not an error.
    if (isDuplicateLabel(err)) {
      return { id: offer.id, outcome: 'stored', provider, label, capability: offer.capability, activation: offer.activation }
    }
    throw err
  }

  return { id: offer.id, outcome: 'stored', provider, label, capability: offer.capability, activation: offer.activation }
}

function isDuplicateLabel(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { code?: unknown }
  return e.code === 'duplicate_label'
}
