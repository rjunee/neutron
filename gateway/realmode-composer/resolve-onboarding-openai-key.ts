/**
 * @neutronai/gateway/realmode-composer — resolve the owner's onboarding-captured
 * OpenAI key from the per-instance `ApiKeyStore`.
 *
 * This is the read side of the GBrain semantic-embeddings activation: onboarding
 * (and the admin "Integrations" surface) persist the key via
 * `ApiKeyStore(provider='openai', label='onboarding')` (the
 * `ONBOARDING_OPENAI_LABEL` slot); this resolver reads it back under the SAME
 * coordinates and hands it to `resolveEffectiveEmbedder` so GBrain flips from
 * keyword + graph to OpenAI `text-embedding-3-large`.
 *
 * **Why a standalone resolver (not an inline composer read).** The boot path
 * composes the GBrain wiring ONCE, at process boot — but the key is captured
 * LATER, over the already-running server (during onboarding / via admin). An
 * eager read at composition therefore misses every freshly-pasted key until a
 * restart. The composer instead threads THIS resolver as a lazy thunk into
 * `buildGBrainMemory`, which calls it at the first `gbrain serve` spawn (first
 * memory op, after onboarding) — so the key activates at the next turn, as the
 * onboarding offer promises. Extracted + exported so the store round-trip is
 * unit-testable without booting the whole composer.
 *
 * Best-effort by contract: a missing key or a store error resolves to
 * `undefined` (keyword + graph default), never throwing into the caller.
 */

import { ApiKeyStore } from '@neutronai/auth/api-key-store.ts'
import { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { ONBOARDING_OPENAI_LABEL } from '@neutronai/onboarding/optional-keys.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

export async function resolveOnboardingOpenAiKey(input: {
  db: ProjectDb
  owner_home: string
  internal_handle: string
  /** Optional, for clearer warn logs only. */
  project_slug?: string
}): Promise<string | undefined> {
  try {
    const apiKeys = new ApiKeyStore({
      db: input.db,
      secrets: new SecretsStore({ data_dir: input.owner_home, db: input.db }),
    })
    return (
      (await apiKeys.resolveSecret({
        internal_handle: input.internal_handle,
        provider: 'openai',
        label: ONBOARDING_OPENAI_LABEL,
      })) ?? undefined
    )
  } catch (err) {
    console.warn(
      `[gbrain-memory] project=${input.project_slug ?? input.internal_handle} could not resolve ` +
        `onboarding OpenAI key (continuing keyword+graph): ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
}
