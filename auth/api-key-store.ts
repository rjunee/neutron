/**
 * @neutronai/auth — BYO API key metadata sidecar.
 *
 * Sits over `SecretsStore`. The plaintext API key is encrypted in
 * `secrets`; this module owns the `api_keys` row that names the provider
 * + label + tracks `last_used_at` so callers can list / pick keys without
 * decrypting every secret on every list call.
 *
 * **2026-05-12 rename-canonicalisation fix:** identity column is the
 * owner's FROZEN `internal_handle` (not the mutable `url_slug`). See
 * `auth/secrets-store.ts` file header for the full rationale. The SQL
 * column is still named `project_slug` for compat; the TypeScript surface
 * uses `internal_handle` to make the contract explicit.
 *
 * Migration 0009 adds the `api_keys` table.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { SecretsStore, SecretsStoreError } from './secrets-store.ts'

export type ApiKeyProvider = 'anthropic' | 'openai' | 'gemini'

export interface ApiKeyRow {
  id: string
  /**
   * Frozen `internal_handle` for the owning project. SQL column is named
   * `project_slug` for historical reasons; the value is the FROZEN
   * registry PK, not the mutable url_slug.
   */
  internal_handle: string
  provider: ApiKeyProvider
  label: string
  secret_id: string
  added_at: number
  last_used_at: number | null
}

interface ApiKeyDbRow {
  id: string
  /** SQL column name remains `project_slug`; value is the frozen internal_handle. */
  project_slug: string
  provider: string
  label: string
  secret_id: string
  added_at: number
  last_used_at: number | null
}

export type ApiKeyStoreErrorCode = 'duplicate_label' | 'not_found'

export class ApiKeyStoreError extends Error {
  override readonly name = 'ApiKeyStoreError'
  constructor(
    readonly code: ApiKeyStoreErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface AddApiKeyInput {
  /** Frozen `internal_handle` — see file header. */
  internal_handle: string
  provider: ApiKeyProvider
  label: string
  plaintext: string
}

export interface ListApiKeysInput {
  /** Frozen `internal_handle` — see file header. */
  internal_handle: string
  provider?: ApiKeyProvider
}

export interface ApiKeyStoreOptions {
  db: ProjectDb
  secrets: SecretsStore
  now?: () => number
}

export class ApiKeyStore {
  private readonly db: ProjectDb
  private readonly secrets: SecretsStore
  private readonly now: () => number

  constructor(options: ApiKeyStoreOptions) {
    this.db = options.db
    this.secrets = options.secrets
    this.now = options.now ?? ((): number => Date.now())
  }

  async add(input: AddApiKeyInput): Promise<{ id: string; secret_id: string }> {
    const now = this.now()
    const id = randomUUID()
    let putResult: { id: string }
    try {
      putResult = await this.secrets.put({
        internal_handle: input.internal_handle,
        kind: 'byo_api_key',
        label: `${input.provider}:${input.label}`,
        plaintext: input.plaintext,
      })
    } catch (err) {
      if (err instanceof SecretsStoreError && err.code === 'duplicate_label') {
        throw new ApiKeyStoreError(
          'duplicate_label',
          `api key already exists for instance=${input.internal_handle} provider=${input.provider} label=${input.label}`,
          err,
        )
      }
      throw err
    }
    try {
      await this.db.run(
        `INSERT INTO api_keys
           (id, project_slug, provider, label, secret_id, added_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [id, input.internal_handle, input.provider, input.label, putResult.id, now],
      )
    } catch (err) {
      // Rollback the secret row to avoid orphaning a ciphertext.
      try {
        await this.secrets.delete(putResult.id)
      } catch {
        // Best-effort — surface original error.
      }
      if (isUniqueViolation(err)) {
        throw new ApiKeyStoreError(
          'duplicate_label',
          `api_keys row exists for instance=${input.internal_handle} provider=${input.provider} label=${input.label}`,
          err,
        )
      }
      throw err
    }
    return { id, secret_id: putResult.id }
  }

  async list(input: ListApiKeysInput): Promise<ApiKeyRow[]> {
    const rows: ApiKeyDbRow[] =
      input.provider === undefined
        ? this.db
            .raw()
            .query<ApiKeyDbRow, [string]>(
              `SELECT id, project_slug, provider, label, secret_id, added_at, last_used_at
                 FROM api_keys WHERE project_slug = ? ORDER BY added_at DESC`,
            )
            .all(input.internal_handle)
        : this.db
            .raw()
            .query<ApiKeyDbRow, [string, string]>(
              `SELECT id, project_slug, provider, label, secret_id, added_at, last_used_at
                 FROM api_keys WHERE project_slug = ? AND provider = ? ORDER BY added_at DESC`,
            )
            .all(input.internal_handle, input.provider)
    return rows.map(toRow)
  }

  async resolveSecret(input: {
    internal_handle: string
    provider: ApiKeyProvider
    label: string
  }): Promise<string | null> {
    const plaintext = await this.secrets.get({
      internal_handle: input.internal_handle,
      kind: 'byo_api_key',
      label: `${input.provider}:${input.label}`,
    })
    return plaintext
  }

  async markUsed(id: string): Promise<void> {
    const now = this.now()
    await this.db.transaction(async (tx) => {
      const existing = tx
        .prepare<{ id: string }, [string]>(`SELECT id FROM api_keys WHERE id = ?`)
        .get(id)
      if (existing === null) {
        throw new ApiKeyStoreError('not_found', `api_keys id=${id} not found`)
      }
      await tx.run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [now, id])
    })
  }

  async delete(input: {
    internal_handle: string
    provider: ApiKeyProvider
    label: string
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = tx
        .prepare<ApiKeyDbRow, [string, string, string]>(
          `SELECT id, project_slug, provider, label, secret_id, added_at, last_used_at
             FROM api_keys WHERE project_slug = ? AND provider = ? AND label = ?`,
        )
        .get(input.internal_handle, input.provider, input.label)
      if (row === null) {
        throw new ApiKeyStoreError(
          'not_found',
          `api key not found for instance=${input.internal_handle} provider=${input.provider} label=${input.label}`,
        )
      }
      await tx.run(`DELETE FROM api_keys WHERE id = ?`, [row.id])
    })
    // Drop the secret row outside the transaction; the secrets store has its
    // own connection-level locking and lives in the same DB.
    try {
      const all = await this.secrets.list({ internal_handle: input.internal_handle, kind: 'byo_api_key' })
      const matching = all.find(
        (r) => r.label === `${input.provider}:${input.label}`,
      )
      if (matching !== undefined) {
        await this.secrets.delete(matching.id)
      }
    } catch (err) {
      if (err instanceof SecretsStoreError && err.code === 'not_found') {
        // Already gone — fine.
        return
      }
      throw err
    }
  }
}

function toRow(row: ApiKeyDbRow): ApiKeyRow {
  if (!isProvider(row.provider)) {
    throw new ApiKeyStoreError(
      'not_found',
      `unknown api_keys.provider value: ${row.provider}`,
    )
  }
  return {
    id: row.id,
    internal_handle: row.project_slug,
    provider: row.provider,
    label: row.label,
    secret_id: row.secret_id,
    added_at: row.added_at,
    last_used_at: row.last_used_at,
  }
}

function isProvider(value: string): value is ApiKeyProvider {
  return value === 'anthropic' || value === 'openai' || value === 'gemini'
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { message?: unknown }
  return typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message)
}
