/**
 * @neutronai/auth — multi-secret encrypted-at-rest store.
 *
 * Generalizes `EncryptedBotTokenStore` (the per-instance bot token store,
 * P1 S4) into a multi-secret store keyed by `(internal_handle, kind, label)`.
 * The AES-256-GCM envelope shape `{ v: 1, iv_b64, ct_b64, tag_b64 }` is
 * unchanged — a token written by the legacy per-instance bot store decrypts
 * unchanged via this module.
 *
 * **2026-05-12 rename-canonicalisation fix:** the lookup key was previously
 * the mutable `project_slug` (== `url_slug`). After an instance rename, the
 * gateway boot canonicalised `project_slug` to the row's NEW `url_slug`,
 * but secret rows persisted at the ORIGINAL `url_slug` (== initial
 * `internal_handle`) became invisible — Max OAuth + BYO API key reads
 * silently returned null, dropping the chat surface to the gate page.
 *
 * The fix: callers MUST pass the FROZEN `internal_handle` (the registry
 * row's PK, locked at provisioning time) as this store's identity
 * parameter, NOT the mutable `url_slug`. The on-disk SQL column is still
 * literally named `project_slug` (no migration; the value is just a
 * string) but every TypeScript API surface in this module uses
 * `internal_handle` so the contract is explicit.
 *
 * Code that does cross-instance API calls / DNS / Caddy routing legitimately
 * uses the mutable `url_slug`. Anything that hits THIS store must use
 * `internal_handle`.
 *
 * Keyfile path is `<owner_home>/.neutron-aes-key`. The legacy bot-token
 * store ships its keyfile at the same path (verified in the legacy
 * per-instance bot token store), so `ensureKey` REUSES
 * the existing material instead of overwriting it. See
 * `tests/integration/p15-secrets-store-roundtrip.test.ts` for the locked
 * forward-compat assertion.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createCipheriv, createDecipheriv, randomUUID } from 'node:crypto'
import type { ProjectDb } from '@neutronai/persistence/index.ts'

const KEY_LENGTH_BYTES = 32 // 256-bit AES
const IV_LENGTH_BYTES = 12 // GCM standard
const AUTH_TAG_LENGTH_BYTES = 16
const KEYFILE_NAME = '.neutron-aes-key'

export type SecretKind =
  | 'max_oauth_refresh'
  | 'max_oauth_access'
  | 'chatgpt_oauth'
  | 'byo_api_key'
  | 'bot_token'
  | 'webhook_secret'
  | 'channel_metadata'
  // Generic third-party OAuth kinds — Cores declare these in their
  // manifest's `secrets:` block per § D.10.4. The platform's SDK
  // wrapper at `cores/sdk/secrets.ts:SecretsAccessor` capability-
  // gates against the manifest before any value is decrypted.
  | 'oauth_token'
  | 'oauth_client'

export interface SecretRecord {
  id: string
  /**
   * Frozen `internal_handle` for the owning project. SQL column is named
   * `project_slug` for historical reasons; the value is the FROZEN
   * registry PK, not the mutable url_slug.
   */
  internal_handle: string
  kind: SecretKind
  label: string
  ciphertext: string
  created_at: number
  rotated_at: number | null
  expires_at: number | null
}

export interface SecretsStoreOptions {
  /** Per-project data dir; the keyfile lives at `<data_dir>/.neutron-aes-key`. */
  data_dir: string
  db: ProjectDb
  now?: () => number
}

interface EncryptedEnvelope {
  v: 1
  iv_b64: string
  ct_b64: string
  tag_b64: string
}

interface SecretRow {
  id: string
  /** SQL column name remains `project_slug`; value is the frozen internal_handle. */
  project_slug: string
  kind: string
  label: string
  ciphertext: string
  created_at: number
  rotated_at: number | null
  expires_at: number | null
}

export type SecretsStoreErrorCode =
  | 'not_found'
  | 'decrypt_failed'
  | 'duplicate_label'
  | 'project_mismatch'

export class SecretsStoreError extends Error {
  override readonly name = 'SecretsStoreError'
  constructor(
    readonly code: SecretsStoreErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export interface PutInput {
  /**
   * Frozen `internal_handle` for the owning project — see file header.
   * Callers MUST pass the FROZEN registry PK, not the mutable url_slug.
   */
  internal_handle: string
  kind: SecretKind
  label: string
  plaintext: string
  expires_at?: number
}

export interface GetInput {
  /** Frozen `internal_handle` — see file header. */
  internal_handle: string
  kind: SecretKind
  label: string
}

export interface ListInput {
  /** Frozen `internal_handle` — see file header. */
  internal_handle: string
  kind?: SecretKind
}

export class SecretsStore {
  private readonly key: Buffer
  private readonly db: ProjectDb
  private readonly now: () => number

  constructor(options: SecretsStoreOptions) {
    this.key = ensureKey(options.data_dir)
    this.db = options.db
    this.now = options.now ?? ((): number => Date.now())
  }

  async put(input: PutInput): Promise<{ id: string }> {
    const now = this.now()
    const id = randomUUID()
    const ciphertext = encrypt(this.key, input.plaintext)
    try {
      await this.db.run(
        `INSERT INTO secrets
           (id, project_slug, kind, label, ciphertext, created_at, rotated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          id,
          input.internal_handle,
          input.kind,
          input.label,
          ciphertext,
          now,
          input.expires_at ?? null,
        ],
      )
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new SecretsStoreError(
          'duplicate_label',
          `secret already exists for instance=${input.internal_handle} kind=${input.kind} label=${input.label}`,
          err,
        )
      }
      throw err
    }
    return { id }
  }

  async get(input: GetInput): Promise<string | null> {
    const row = this.db
      .raw()
      .query<SecretRow, [string, string, string]>(
        `SELECT id, project_slug, kind, label, ciphertext, created_at, rotated_at, expires_at
           FROM secrets
          WHERE project_slug = ? AND kind = ? AND label = ?`,
      )
      .get(input.internal_handle, input.kind, input.label)
    if (row === null) return null
    // Codex review fix: honor expires_at — an expired row behaves like a
    // missing secret. Critical for OAuth access tokens (Max +
    // ChatGPT) where the caller relies on stale cached tokens being
    // rejected so the refresh-token path runs.
    if (row.expires_at !== null && row.expires_at <= this.now()) {
      return null
    }
    try {
      return decrypt(this.key, row.ciphertext)
    } catch (err) {
      throw new SecretsStoreError(
        'decrypt_failed',
        `decrypt failed for id=${row.id}`,
        err,
      )
    }
  }

  async list(input: ListInput): Promise<SecretRecord[]> {
    const rows: SecretRow[] =
      input.kind === undefined
        ? this.db
            .raw()
            .query<SecretRow, [string]>(
              `SELECT id, project_slug, kind, label, ciphertext, created_at, rotated_at, expires_at
                 FROM secrets WHERE project_slug = ? ORDER BY created_at DESC`,
            )
            .all(input.internal_handle)
        : this.db
            .raw()
            .query<SecretRow, [string, string]>(
              `SELECT id, project_slug, kind, label, ciphertext, created_at, rotated_at, expires_at
                 FROM secrets WHERE project_slug = ? AND kind = ? ORDER BY created_at DESC`,
            )
            .all(input.internal_handle, input.kind)
    return rows.map(rowToRecord)
  }

  /**
   * Sprint 23 r6 P2 — atomically replace a set of `(kind, label)`
   * rows in a single transaction. Used by `MaxOAuthClient.persistPasteToken`
   * so a partial failure between the delete + the second insert
   * cannot leave the owner with a half-written set of paste-token
   * rows.
   *
   * The transaction does, for each input entry:
   *   1. DELETE any existing rows for `(internal_handle, kind, label)`.
   *   2. INSERT the new ciphertext.
   * Wrapped in BEGIN/COMMIT — if any step throws, the whole
   * transaction rolls back and the previous values stay intact.
   *
   * Returns the inserted ids in input order.
   */
  async replaceAtomic(
    input: ReadonlyArray<PutInput>,
  ): Promise<Array<{ id: string }>> {
    const now = this.now()
    const prepared = input.map((entry) => ({
      entry,
      id: randomUUID(),
      ciphertext: encrypt(this.key, entry.plaintext),
    }))
    return await this.db.transaction(async (tx) => {
      for (const { entry } of prepared) {
        await tx.run(
          `DELETE FROM secrets WHERE project_slug = ? AND kind = ? AND label = ?`,
          [entry.internal_handle, entry.kind, entry.label],
        )
      }
      for (const { entry, id, ciphertext } of prepared) {
        try {
          await tx.run(
            `INSERT INTO secrets
               (id, project_slug, kind, label, ciphertext, created_at, rotated_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
            [
              id,
              entry.internal_handle,
              entry.kind,
              entry.label,
              ciphertext,
              now,
              entry.expires_at ?? null,
            ],
          )
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new SecretsStoreError(
              'duplicate_label',
              `secret already exists for instance=${entry.internal_handle} kind=${entry.kind} label=${entry.label}`,
              err,
            )
          }
          throw err
        }
      }
      return prepared.map(({ id }) => ({ id }))
    })
  }

  async rotate(
    id: string,
    new_plaintext: string,
    options?: { expires_at?: number },
  ): Promise<void> {
    const now = this.now()
    const ciphertext = encrypt(this.key, new_plaintext)
    await this.db.transaction(async (tx) => {
      const existing = tx
        .prepare<{ id: string }, [string]>(`SELECT id FROM secrets WHERE id = ?`)
        .get(id)
      if (existing === null) {
        throw new SecretsStoreError('not_found', `secret id=${id} not found`)
      }
      // Update expires_at when supplied so OAuth refresh-token flows
      // reset the access-token validity window each time. Sentinel
      // value `null` clears the expiry; absent keeps prior value.
      if (options !== undefined && 'expires_at' in options) {
        const exp = options.expires_at ?? null
        await tx.run(
          `UPDATE secrets SET ciphertext = ?, rotated_at = ?, expires_at = ? WHERE id = ?`,
          [ciphertext, now, exp, id],
        )
      } else {
        await tx.run(
          `UPDATE secrets SET ciphertext = ?, rotated_at = ? WHERE id = ?`,
          [ciphertext, now, id],
        )
      }
    })
  }

  async delete(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = tx
        .prepare<{ id: string }, [string]>(`SELECT id FROM secrets WHERE id = ?`)
        .get(id)
      if (existing === null) {
        throw new SecretsStoreError('not_found', `secret id=${id} not found`)
      }
      await tx.run(`DELETE FROM secrets WHERE id = ?`, [id])
    })
  }

  /**
   * Forward-compat helper: decrypt a ciphertext envelope written by the
   * legacy `EncryptedBotTokenStore`. Used by the per-instance bot store's
   * P1.5 wrapper; not part of the public storage surface.
   */
  decryptEnvelope(envelope: string): string {
    return decrypt(this.key, envelope)
  }

  encryptPlaintext(plaintext: string): string {
    return encrypt(this.key, plaintext)
  }
}

function rowToRecord(row: SecretRow): SecretRecord {
  if (!isSecretKind(row.kind)) {
    throw new SecretsStoreError(
      'decrypt_failed',
      `unknown secret kind in DB: ${row.kind}`,
    )
  }
  return {
    id: row.id,
    internal_handle: row.project_slug,
    kind: row.kind,
    label: row.label,
    ciphertext: row.ciphertext,
    created_at: row.created_at,
    rotated_at: row.rotated_at,
    expires_at: row.expires_at,
  }
}

function isSecretKind(value: string): value is SecretKind {
  return (
    value === 'max_oauth_refresh' ||
    value === 'max_oauth_access' ||
    value === 'chatgpt_oauth' ||
    value === 'byo_api_key' ||
    value === 'bot_token' ||
    value === 'webhook_secret' ||
    value === 'channel_metadata' ||
    value === 'oauth_token' ||
    value === 'oauth_client'
  )
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const e = err as { message?: unknown }
  return typeof e.message === 'string' && /UNIQUE constraint failed/i.test(e.message)
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES))
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(iv))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  if (tag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error(`unexpected auth tag length ${tag.length}`)
  }
  const env: EncryptedEnvelope = {
    v: 1,
    iv_b64: Buffer.from(iv).toString('base64'),
    ct_b64: ct.toString('base64'),
    tag_b64: tag.toString('base64'),
  }
  return JSON.stringify(env)
}

function decrypt(key: Buffer, envelope: string): string {
  let env: EncryptedEnvelope
  try {
    env = JSON.parse(envelope) as EncryptedEnvelope
  } catch (err) {
    throw new Error(`malformed envelope: ${err instanceof Error ? err.message : 'unknown'}`)
  }
  if (env.v !== 1) throw new Error(`unsupported envelope version v=${env.v}`)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv_b64, 'base64'))
  decipher.setAuthTag(Buffer.from(env.tag_b64, 'base64'))
  const pt = Buffer.concat([
    decipher.update(Buffer.from(env.ct_b64, 'base64')),
    decipher.final(),
  ])
  return pt.toString('utf8')
}

/**
 * Resolve the AES-256 keyfile for an instance. Locked behavior:
 *   - If `<data_dir>/.neutron-aes-key` exists, REUSE its bytes verbatim.
 *     This is the forward-compat hook for instances whose bot-token store
 *     already created the keyfile in P1 — overwriting would brick every
 *     existing bot token. See `EncryptedBotTokenStore.ensureKey` in the
 *     legacy per-instance bot token store for the original writer.
 *   - Otherwise generate a fresh 32-byte key, write it with mode 0600,
 *     and return the bytes.
 *
 * Exported so `__tests__/secrets-store.test.ts` can assert the legacy
 * keyfile is reused.
 */
export function ensureKey(data_dir: string): Buffer {
  const path = join(data_dir, KEYFILE_NAME)
  if (existsSync(path)) {
    const buf = readFileSync(path)
    if (buf.length !== KEY_LENGTH_BYTES) {
      throw new SecretsStoreError(
        'decrypt_failed',
        `aes keyfile at ${path} has wrong length ${buf.length} (expected ${KEY_LENGTH_BYTES})`,
      )
    }
    // Codex follow-up — defense-in-depth: tighten an existing keyfile to
    // 0600 even on the legacy-reuse path. `writeFileSync({mode:0o600})`
    // only applies on CREATE, so a copied / manually-placed keyfile at
    // 0644 would leave every secret in `secrets` decryptable by other
    // local users. Mirrors the Argus r1 finding 3 chmodSync fix for
    // `~/.codex/auth.json`.
    chmodSync(path, 0o600)
    return buf
  }
  mkdirSync(dirname(path), { recursive: true })
  const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES)))
  writeFileSync(path, fresh, { mode: 0o600 })
  return fresh
}
