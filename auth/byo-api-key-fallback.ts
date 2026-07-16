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
import { asOwnerHandle, type OwnerHandle } from '@neutronai/persistence/index.ts'
import {
  newCredentialPool,
  type CredentialPool,
  type CredentialStrategy,
} from '@neutronai/runtime/credential-pool.ts'

export interface BuildBYOApiKeyPoolInput {
  /** Frozen `owner_handle` (branded `OwnerHandle`) — see auth/secrets-store.ts file header. */
  owner_handle: OwnerHandle
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
    owner_handle: input.owner_handle,
    provider: input.provider,
  })
  if (rows.length === 0) return null

  const credentials: Array<{ id: string; kind: 'api_key'; secret: string }> = []
  for (const row of rows) {
    const plaintext = await input.api_keys.resolveSecret({
      // `row.owner_handle` is the frozen handle read back from the DB row
      // (stored via a branded boundary), so re-branding it is sound.
      owner_handle: asOwnerHandle(row.owner_handle),
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
