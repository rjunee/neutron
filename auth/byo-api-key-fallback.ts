/**
 * @neutronai/auth — BYO API key fallback wiring.
 *
 * Composes a `CredentialPool` (from `@neutronai/runtime`) backed by the
 * owner's stored BYO API keys (managed by `ApiKeyStore`). When the owner
 * has no Max / Codex OAuth subs but DOES have a BYO key registered, this
 * is the path the adapter walks.
 *
 * P1.5 ships a single-key default for each provider — multi-key rotation
 * across BYO keys is in scope but tested via `least_used` strategy which
 * is exactly the same shape as multi-key Max/OAuth pools.
 */

import type { ApiKeyProvider, ApiKeyStore } from './api-key-store.ts'
import {
  newCredentialPool,
  type CredentialPool,
  type CredentialStrategy,
} from '../runtime/credential-pool.ts'

export interface BuildBYOApiKeyPoolInput {
  /** Frozen `internal_handle` — see auth/secrets-store.ts file header. */
  internal_handle: string
  provider: ApiKeyProvider
  api_keys: ApiKeyStore
  /** Defaults to `'least_used'` so a multi-key pool rotates fairly. */
  strategy?: CredentialStrategy
}

/**
 * Resolve every BYO API key for the given owner + provider, decrypt
 * each via the SecretsStore (through ApiKeyStore.resolveSecret), and
 * return a CredentialPool ready for adapter consumption.
 *
 * Returns `null` if the owner has zero keys for this provider — the
 * caller's adapter should fall through to its next credential source
 * (Max/OAuth refresh, manual key prompt, etc.).
 */
export async function buildBYOApiKeyPool(
  input: BuildBYOApiKeyPoolInput,
): Promise<CredentialPool | null> {
  const rows = await input.api_keys.list({
    internal_handle: input.internal_handle,
    provider: input.provider,
  })
  if (rows.length === 0) return null

  const credentials: Array<{ id: string; kind: 'api_key'; secret: string }> = []
  for (const row of rows) {
    const plaintext = await input.api_keys.resolveSecret({
      internal_handle: row.internal_handle,
      provider: row.provider,
      label: row.label,
    })
    if (plaintext === null) continue
    credentials.push({
      id: `${row.provider}:${row.label}`,
      kind: 'api_key',
      secret: plaintext,
    })
  }
  if (credentials.length === 0) return null

  return newCredentialPool({
    strategy: input.strategy ?? 'least_used',
    credentials,
  })
}
