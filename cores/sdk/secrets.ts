/**
 * @neutronai/cores-sdk — capability-gated SecretsAccessor.
 *
 * The platform's `SecretsStore` (`auth/secrets-store.ts`, AES-256-GCM
 * keyfile per project) is the source of truth. Cores never touch it
 * directly — they call `SecretsAccessor.get(kind, label)` and the
 * accessor verifies the calling Core's manifest declared this secret
 * in its `secrets:` block (engineering-plan § D.10.4).
 *
 * v1 ships:
 * - `SecretsAccessor` interface — the surface a Core uses.
 * - `buildSecretsAccessor({manifest, store})` — production binding
 *   to the platform `SecretsStore`. The store is duck-typed via
 *   `PlatformSecretsStore` so the SDK doesn't take a hard dependency
 *   on `@neutronai/auth` (avoids a cyclic workspace edge).
 * - `buildDevSecretsAccessor({manifest, file_path})` — dev-only
 *   passthrough that reads/writes a JSON file. NEVER prod.
 * - `CapabilityDeniedError` — thrown when a Core tries to read a
 *   secret it didn't declare.
 *
 * Cross-refs:
 * - auth/secrets-store.ts (production SecretsStore — `kind` enum +
 *   AES envelope)
 * - docs/engineering-plan.md § D.10.4 (capability-gated `secrets:`
 *   block, locked 2026-05-06)
 * - docs/engineering-plan.md § D.10.5 (audit log — Cores hand audit
 *   write through to the platform; SDK does NOT own retention)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { CapabilityDeniedError } from './errors.ts'
import type { ManifestSecret, NeutronManifest } from './manifest.ts'

/**
 * Stable identifier the Core uses when looking up a secret. Maps
 * 1:1 onto `auth/secrets-store.ts:SecretKind` for the production
 * accessor; the dev accessor is permissive about extras (a Core
 * declaring `webhook_secret` works without the platform store
 * adding the union member).
 */
export type SecretKind =
  | 'byo_api_key'
  | 'oauth_token'
  | 'oauth_client'
  | 'webhook_secret'
  | 'max_oauth_refresh'
  | 'max_oauth_access'
  | 'chatgpt_oauth'
  | 'bot_token'
  | 'channel_metadata'

/** The secret-access subset of {@link CapabilityDeniedCode}. Public type;
 *  kept for callers that branch on the accessor's denial codes. */
export type SecretsAccessorErrorCode =
  | 'capability_denied'
  | 'not_found'
  | 'misconfigured'

// Refactor X4: `CapabilityDeniedError` is now the SINGLE unified definition
// in `./errors.ts` (shared with the tool-dispatch surface in
// `cores/runtime`). Re-exported here so `@neutronai/cores-sdk` callers keep
// importing it from the barrel unchanged.
export { CapabilityDeniedError } from './errors.ts'
export type { CapabilityDeniedCode, CapabilityDeniedErrorInit } from './errors.ts'

/**
 * The surface a Core uses. Implementations enforce capability gating
 * BEFORE returning plaintext; on mismatch they throw
 * `CapabilityDeniedError`.
 */
export interface SecretsAccessorPutOptions {
  /** Optional epoch-ms expiry. Critical for OAuth `oauth_token`
   *  rows — the platform store returns null on read past this
   *  timestamp so the caller's refresh path runs. */
  expires_at?: number
}

export interface SecretsAccessor {
  /** Return the plaintext secret or `null` if not present.
   *  Throws `CapabilityDeniedError` when the calling Core's manifest
   *  did NOT declare `(kind, label)`. */
  get(kind: SecretKind, label: string): Promise<string | null>

  /** Write/rotate a secret. Same capability gate as `get`. The
   *  optional `expires_at` is propagated through to the platform
   *  store on both insert and rotate paths so OAuth access-token
   *  refresh works correctly. */
  put(
    kind: SecretKind,
    label: string,
    plaintext: string,
    options?: SecretsAccessorPutOptions,
  ): Promise<void>

  /** List secrets the Core can see (filtered by manifest declaration).
   *  Returns plaintext-free metadata. */
  list(): Promise<Array<{ kind: SecretKind; label: string }>>
}

/**
 * Platform `SecretsStore` shape — duck-typed so we don't pull in the
 * `@neutronai/auth` dependency. Mirrors the on-disk surface in
 * `auth/secrets-store.ts`.
 *
 * **2026-05-12 rename-canonicalisation fix:** identity field renamed
 * from `project_slug` → `internal_handle`. Per `auth/secrets-store.ts`
 * file header, the value MUST be the FROZEN registry handle, not the
 * mutable url_slug — otherwise renamed instances silently lose all
 * stored credentials.
 *
 * Rotation note: the platform `put()` is INSERT-only — it raises a
 * `duplicate_label` error if `(internal_handle, kind, label)` already
 * exists. Rotation goes through `rotate(id, plaintext)`, with `id`
 * resolved via `list()`. The SDK's `SecretsAccessor.put()` hides this
 * fork — see `buildSecretsAccessor` below.
 *
 * `id` on list rows is REQUIRED. The SDK's `put()` falls back to
 * `rotate(id, ...)` when a duplicate label exists, so a store that
 * omits `id` cannot honour write/rotate semantics — see the
 * accessor's misconfigured-error fast-fail.
 */
export interface PlatformSecretsStoreListItem {
  id: string
  kind: string
  label: string
}

export interface PlatformSecretsStore {
  get(input: {
    internal_handle: string
    kind: string
    label: string
  }): Promise<string | null>
  put(input: {
    internal_handle: string
    kind: string
    label: string
    plaintext: string
    /** Optional epoch-ms expiry. The platform store honours expiry on
     *  `get()` so an expired access token returns null and the
     *  caller's refresh-token path runs. */
    expires_at?: number
  }): Promise<{ id: string } | void>
  /** Rotate the ciphertext on an existing secret. Required for the
   *  SDK's write/rotate `put()` semantics.
   *  `expires_at` ALSO needs to be rotated for OAuth access tokens —
   *  if a store implementation doesn't propagate the new expiry,
   *  refreshed tokens stay forever-valid (or forever-expired). The
   *  platform `auth/secrets-store.ts:SecretsStore.rotate` accepts
   *  the expiry as part of its update; older implementations that
   *  ignore it surface as a documented limitation in their AGENTS.md. */
  rotate?(
    id: string,
    new_plaintext: string,
    options?: { expires_at?: number },
  ): Promise<void>
  list(input: {
    internal_handle: string
    kind?: string
  }): Promise<Array<PlatformSecretsStoreListItem>>
}

/**
 * Manifest input shape. Either pass the full Zod-validated manifest
 * (typical), or just the `secrets[]` array (saves a parse when the
 * caller already extracted it).
 */
export type ManifestSecretsInput =
  | { manifest: NeutronManifest }
  | { secrets: ReadonlyArray<ManifestSecret> }

function extractSecrets(
  input: ManifestSecretsInput,
): ReadonlyArray<ManifestSecret> {
  return 'manifest' in input ? input.manifest.secrets : input.secrets
}

function isDeclared(
  declared: ReadonlyArray<ManifestSecret>,
  kind: string,
  label: string,
): boolean {
  return declared.some((s) => s.kind === kind && s.label === label)
}

/**
 * The platform `SecretsStore` raises a `SecretsStoreError(code:
 * 'duplicate_label', ...)` on insert collision. Duck-type the error
 * shape since the SDK doesn't depend on `@neutronai/auth` — match on
 * either the code field OR the message substring.
 */
function isDuplicateLabelError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  const obj = err as Record<string, unknown>
  if (obj.code === 'duplicate_label') return true
  if (typeof obj.message === 'string' && obj.message.includes('duplicate_label')) {
    return true
  }
  return false
}

export interface BuildSecretsAccessorOptions extends Record<string, unknown> {
  /**
   * 2026-05-12 — frozen `internal_handle` for the instance (see
   * `auth/secrets-store.ts` file header). The SDK no longer accepts
   * the mutable `url_slug` here because the platform store keys all
   * rows on the frozen handle.
   */
  internal_handle: string
  store: PlatformSecretsStore
  /** Core package name — surfaced in error messages + (P3) audit log. */
  core_id: string
}

/**
 * Production binding. The platform's `SecretsStore` resolves the
 * actual ciphertext + decrypts it; this wrapper enforces capability
 * gating against the Core's declared `secrets[]`.
 */
export function buildSecretsAccessor(
  manifest_input: ManifestSecretsInput,
  options: BuildSecretsAccessorOptions,
): SecretsAccessor {
  const declared = extractSecrets(manifest_input)
  return {
    async get(kind: SecretKind, label: string): Promise<string | null> {
      if (!isDeclared(declared, kind, label)) {
        throw new CapabilityDeniedError({
          code: 'capability_denied',
          message: `core=${options.core_id} did not declare secret kind=${kind} label=${label} in its manifest`,
        })
      }
      return options.store.get({
        internal_handle: options.internal_handle,
        kind,
        label,
      })
    },
    async put(
      kind: SecretKind,
      label: string,
      plaintext: string,
      putOptions?: SecretsAccessorPutOptions,
    ): Promise<void> {
      if (!isDeclared(declared, kind, label)) {
        throw new CapabilityDeniedError({
          code: 'capability_denied',
          message: `core=${options.core_id} did not declare secret kind=${kind} label=${label} in its manifest`,
        })
      }
      // Write/rotate. The platform `SecretsStore.put()` is INSERT-only
      // and rejects duplicates with `duplicate_label`; rotation runs
      // through `rotate(id, plaintext)`. Resolve existing rows first;
      // if absent, insert. Critical for OAuth re-auth + BYOK update
      // flows that overwrite the same label.
      const existing = await options.store.list({
        internal_handle: options.internal_handle,
        kind,
      })
      const match = existing.find((r) => r.label === label)
      if (match !== undefined) {
        // PlatformSecretsStoreListItem.id is required; fail fast and
        // loud if a store implementation omits it rather than fall
        // through to a duplicate_label re-insert that would surface
        // as a confusing platform-store error.
        if (typeof match.id !== 'string' || match.id.length === 0) {
          throw new CapabilityDeniedError({
            code: 'misconfigured',
            message: `platform store list() did not return id for kind=${kind} label=${label}; cannot rotate`,
          })
        }
        if (typeof options.store.rotate !== 'function') {
          throw new CapabilityDeniedError({
            code: 'misconfigured',
            message: `platform store does not support rotate(); cannot overwrite kind=${kind} label=${label}`,
          })
        }
        const rotateOptions: { expires_at?: number } = {}
        if (putOptions?.expires_at !== undefined) {
          rotateOptions.expires_at = putOptions.expires_at
        }
        await options.store.rotate(match.id, plaintext, rotateOptions)
        return
      }
      const putInput: {
        internal_handle: string
        kind: string
        label: string
        plaintext: string
        expires_at?: number
      } = {
        internal_handle: options.internal_handle,
        kind,
        label,
        plaintext,
      }
      if (putOptions?.expires_at !== undefined) {
        putInput.expires_at = putOptions.expires_at
      }
      try {
        await options.store.put(putInput)
      } catch (err) {
        // Race: a concurrent writer landed an INSERT between our
        // list() and put(). Retry as a list+rotate so the SDK's
        // documented overwrite semantics still hold for parallel
        // OAuth callbacks / boot flows refreshing the same token.
        if (!isDuplicateLabelError(err)) throw err
        const post = await options.store.list({
          internal_handle: options.internal_handle,
          kind,
        })
        const winner = post.find((r) => r.label === label)
        if (winner === undefined || typeof winner.id !== 'string') {
          throw err
        }
        if (typeof options.store.rotate !== 'function') {
          throw err
        }
        const rotateOptions: { expires_at?: number } = {}
        if (putOptions?.expires_at !== undefined) {
          rotateOptions.expires_at = putOptions.expires_at
        }
        await options.store.rotate(winner.id, plaintext, rotateOptions)
      }
    },
    async list(): Promise<Array<{ kind: SecretKind; label: string }>> {
      const all = await options.store.list({ internal_handle: options.internal_handle })
      return all
        .filter((s) => isDeclared(declared, s.kind, s.label))
        .map((s) => ({ kind: s.kind as SecretKind, label: s.label }))
    },
  }
}

/**
 * Dev-mode passthrough. Stores secrets PLAINTEXT in a JSON file.
 *
 * NEVER PROD. The factory throws unless `NEUTRON_DEV_AUTH=1` is set,
 * to keep a confused deployment from quietly losing encryption.
 *
 * File shape:
 * ```json
 * { "byo_api_key:stripe": "sk_test_...", "oauth_token:google": "ya29..." }
 * ```
 *
 * Concurrent writers are not supported. Single-process dev-server only.
 */
export interface BuildDevSecretsAccessorOptions extends Record<string, unknown> {
  /** `<core_data_dir>/.secrets-dev.json` is the convention. */
  file_path: string
  /** Core package name — surfaced in error messages. */
  core_id: string
  /** Allow construction without `NEUTRON_DEV_AUTH=1`. Tests pass true;
   *  prod callers MUST NEVER pass true. */
  bypass_env_guard?: boolean
}

export function buildDevSecretsAccessor(
  manifest_input: ManifestSecretsInput,
  options: BuildDevSecretsAccessorOptions,
): SecretsAccessor {
  if (
    options.bypass_env_guard !== true &&
    (typeof process === 'undefined' || process.env['NEUTRON_DEV_AUTH'] !== '1')
  ) {
    throw new CapabilityDeniedError({
      code: 'misconfigured',
      message:
        'buildDevSecretsAccessor requires NEUTRON_DEV_AUTH=1 — never enable in production',
    })
  }
  const declared = extractSecrets(manifest_input)
  const path = options.file_path
  const key = (kind: string, label: string): string => `${kind}:${label}`
  function load(): Record<string, string> {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf8')
    if (raw.trim().length === 0) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  }
  function persist(state: Record<string, string>): void {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 })
  }
  return {
    async get(kind: SecretKind, label: string): Promise<string | null> {
      if (!isDeclared(declared, kind, label)) {
        throw new CapabilityDeniedError({
          code: 'capability_denied',
          message: `core=${options.core_id} did not declare secret kind=${kind} label=${label} in its manifest`,
        })
      }
      const state = load()
      return state[key(kind, label)] ?? null
    },
    async put(
      kind: SecretKind,
      label: string,
      plaintext: string,
      _putOptions?: SecretsAccessorPutOptions,
    ): Promise<void> {
      // Dev accessor ignores expires_at — the dev JSON file has no
      // expiry index. Documented in SDK-CONTRACT § "Dev-mode stubs".
      if (!isDeclared(declared, kind, label)) {
        throw new CapabilityDeniedError({
          code: 'capability_denied',
          message: `core=${options.core_id} did not declare secret kind=${kind} label=${label} in its manifest`,
        })
      }
      const state = load()
      state[key(kind, label)] = plaintext
      persist(state)
    },
    async list(): Promise<Array<{ kind: SecretKind; label: string }>> {
      const state = load()
      const out: Array<{ kind: SecretKind; label: string }> = []
      for (const k of Object.keys(state)) {
        const idx = k.indexOf(':')
        if (idx <= 0) continue
        const kind = k.slice(0, idx) as SecretKind
        const label = k.slice(idx + 1)
        if (isDeclared(declared, kind, label)) out.push({ kind, label })
      }
      return out
    },
  }
}
