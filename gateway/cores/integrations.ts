/**
 * @neutronai/gateway/cores — Integrations aggregation + mutation.
 *
 * One visibility+management layer over EVERYTHING a project has connected:
 *
 *   - Per-Core Google **OAuth accounts** — the `oauth_token` slots every
 *     bundled Core declares in `manifest.secrets[]` (Calendar, Email,
 *     Google Workspace). Status is read through the existing
 *     `OAuthTokenManager` (NOT a new token store).
 *   - Standalone **API keys** — the `byo_api_key` slots Cores declare
 *     (e.g. Research Core's `tavily`). Stored/read through the existing
 *     `SecretsStore` under the manifest-declared label, exactly where the
 *     owning Core reads them via its `SecretsAccessor`.
 *
 * This module is the SHARED brain behind both the HTTP admin surface
 * (`/api/cores/integrations`, `/api/cores/api-keys/*`) and the
 * agent-native chat tools (`integrations_list` / `integrations_connect` /
 * `integrations_disconnect`) — agent-native parity means the agent reaches
 * the same `setApiKey` / `deleteApiKey` / `disconnect` paths a user reaches
 * in the UI.
 *
 * Scope guard (WAVE 2 Track A): we do NOT build a global connection
 * registry. The set of integrations is DERIVED from the bundled Cores'
 * own manifest secret declarations — per-Core ownership stays intact.
 *
 * Cross-ref: gateway/http/cores-oauth-surface.ts (HTTP surface),
 * gateway/composition/wire-cores-surfaces.ts (tool registration),
 * gateway/cores/oauth-token-manager.ts, auth/secrets-store.ts.
 */

import type { SecretsStore } from '../../auth/secrets-store.ts'
import { metaLabel, refreshLabel } from './oauth-token-manager.ts'
import type {
  OAuthTokenManager,
  OAuthTokenStatus,
} from './oauth-token-manager.ts'

/**
 * Minimal structural view of a manifest secret declaration — only the
 * fields this module reads. Defined locally (rather than importing
 * `core-sdk`'s `ManifestSecret`) so the bundled registry's slightly looser
 * `scope?: string | undefined` shape stays assignable under
 * `exactOptionalPropertyTypes`.
 */
export interface IntegrationsManifestSecret {
  kind: string
  label: string
  scope?: string | undefined
  name: string
  required: boolean
  install_prompt: string
}

/** Structural view of the bundled-Cores registry this module reads from. */
export interface IntegrationsRegistryView {
  list(): ReadonlyArray<{
    slug: string
    manifest: { secrets: ReadonlyArray<IntegrationsManifestSecret> }
  }>
}

/** A per-Core Google OAuth account slot + its live connection status. */
export interface OAuthAccountIntegration extends OAuthTokenStatus {
  kind: 'oauth'
  /** Manifest-declared scope string for the label. */
  scope: string
  /** Every bundled Core slug that declares this label. */
  core_slugs: string[]
}

/** A standalone API-key slot + whether a key is currently stored. */
export interface ApiKeyIntegration {
  kind: 'api_key'
  /** Manifest-declared secret label (the key the Core reads under). */
  label: string
  /** Manifest-declared stable `name` (lookup id). */
  name: string
  /** Every bundled Core slug that declares this slot. */
  core_slugs: string[]
  /** `true` if the owning Core requires the key to install. */
  required: boolean
  /** UX copy the Core declares for the paste flow. */
  install_prompt: string
  /** `true` when a secret is currently stored for this label. */
  connected: boolean
}

export interface IntegrationsStatus {
  oauth: OAuthAccountIntegration[]
  api_keys: ApiKeyIntegration[]
}

/** Stable error for known-label / value validation failures. */
export class IntegrationsError extends Error {
  override readonly name = 'IntegrationsError'
  constructor(
    readonly code:
      | 'unknown_label'
      | 'empty_value'
      | 'not_api_key'
      | 'not_oauth'
      | 'oauth_start_failed',
    message: string,
  ) {
    super(message)
  }
}

interface OAuthSlot {
  scope: string
  core_slugs: string[]
}

interface ApiKeySlot {
  name: string
  core_slugs: string[]
  required: boolean
  install_prompt: string
}

/**
 * Collect every `oauth_token` slot declared across the bundled Cores,
 * keyed by label. Mirrors `collectKnownLabels` in cores-oauth-surface.ts
 * but exposed here for the unified status path.
 */
export function collectOAuthSlots(
  registry: IntegrationsRegistryView,
): Map<string, OAuthSlot> {
  const map = new Map<string, OAuthSlot>()
  for (const core of registry.list()) {
    for (const secret of core.manifest.secrets) {
      if (secret.kind !== 'oauth_token') continue
      const existing = map.get(secret.label)
      if (existing === undefined) {
        map.set(secret.label, {
          scope: secret.scope ?? '',
          core_slugs: [core.slug],
        })
      } else if (!existing.core_slugs.includes(core.slug)) {
        existing.core_slugs.push(core.slug)
      }
    }
  }
  return map
}

/**
 * Collect every `byo_api_key` slot declared across the bundled Cores,
 * keyed by label. First declaration wins for `name`/`required`/copy; the
 * `core_slugs` list accumulates every Core that shares the slot.
 */
export function collectApiKeySlots(
  registry: IntegrationsRegistryView,
): Map<string, ApiKeySlot> {
  const map = new Map<string, ApiKeySlot>()
  for (const core of registry.list()) {
    for (const secret of core.manifest.secrets) {
      if (secret.kind !== 'byo_api_key') continue
      const existing = map.get(secret.label)
      if (existing === undefined) {
        map.set(secret.label, {
          name: secret.name,
          core_slugs: [core.slug],
          required: secret.required,
          install_prompt: secret.install_prompt,
        })
      } else if (!existing.core_slugs.includes(core.slug)) {
        existing.core_slugs.push(core.slug)
      }
    }
  }
  return map
}

export interface BuildIntegrationsStatusInput {
  registry: IntegrationsRegistryView
  tokens: OAuthTokenManager
  secretsStore: SecretsStore
  project_slug: string
}

/**
 * Build the unified status. OAuth status comes from `OAuthTokenManager`
 * (live access/refresh/meta read); API-key `connected` is a presence check
 * against the `byo_api_key` rows — NO plaintext ever leaves this function.
 */
export async function buildIntegrationsStatus(
  input: BuildIntegrationsStatusInput,
): Promise<IntegrationsStatus> {
  const oauthSlots = collectOAuthSlots(input.registry)
  const apiKeySlots = collectApiKeySlots(input.registry)

  const oauth: OAuthAccountIntegration[] = []
  for (const [label, slot] of oauthSlots) {
    const status = await input.tokens.getStatus(label)
    oauth.push({
      kind: 'oauth',
      ...status,
      scope: slot.scope,
      core_slugs: slot.core_slugs,
    })
  }

  // One list() read (no decrypt) → label-presence set for every api-key.
  const rows = await input.secretsStore.list({
    internal_handle: input.project_slug,
    kind: 'byo_api_key',
  })
  const present = new Set(rows.map((r) => r.label))

  const api_keys: ApiKeyIntegration[] = []
  for (const [label, slot] of apiKeySlots) {
    api_keys.push({
      kind: 'api_key',
      label,
      name: slot.name,
      core_slugs: slot.core_slugs,
      required: slot.required,
      install_prompt: slot.install_prompt,
      connected: present.has(label),
    })
  }

  // Deterministic ordering so UI + tests are stable.
  oauth.sort((a, b) => a.label.localeCompare(b.label))
  api_keys.sort((a, b) => a.label.localeCompare(b.label))
  return { oauth, api_keys }
}

export interface SetApiKeyInput {
  registry: IntegrationsRegistryView
  secretsStore: SecretsStore
  project_slug: string
  label: string
  value: string
}

/**
 * Store (or rotate) an API key for a manifest-declared `byo_api_key` slot.
 * `replaceAtomic` makes set-or-rotate a single transaction — paste a new
 * key over an existing one without a delete/insert race. Rejects labels no
 * bundled Core declares and empty values.
 */
export async function setApiKey(
  input: SetApiKeyInput,
): Promise<{ stored: true }> {
  const slots = collectApiKeySlots(input.registry)
  if (!slots.has(input.label)) {
    throw new IntegrationsError(
      'unknown_label',
      `label='${input.label}' is not a byo_api_key slot declared by any bundled Core`,
    )
  }
  const value = input.value.trim()
  if (value.length === 0) {
    throw new IntegrationsError('empty_value', 'api key value must be non-empty')
  }
  await input.secretsStore.replaceAtomic([
    {
      internal_handle: input.project_slug,
      kind: 'byo_api_key',
      label: input.label,
      plaintext: value,
    },
  ])
  return { stored: true }
}

export interface DeleteApiKeyInput {
  registry: IntegrationsRegistryView
  secretsStore: SecretsStore
  project_slug: string
  label: string
}

/**
 * Clear a stored API key. Returns `{deleted:false}` when the slot is
 * known but no key was stored (idempotent). Rejects unknown labels.
 */
export async function deleteApiKey(
  input: DeleteApiKeyInput,
): Promise<{ deleted: boolean }> {
  const slots = collectApiKeySlots(input.registry)
  if (!slots.has(input.label)) {
    throw new IntegrationsError(
      'unknown_label',
      `label='${input.label}' is not a byo_api_key slot declared by any bundled Core`,
    )
  }
  const rows = await input.secretsStore.list({
    internal_handle: input.project_slug,
    kind: 'byo_api_key',
  })
  const match = rows.find((r) => r.label === input.label)
  if (match === undefined) return { deleted: false }
  await input.secretsStore.delete(match.id)
  return { deleted: true }
}

// Re-export the suffix helpers so callers constructing oauth row shapes
// (tests, surfaces) don't have to import from oauth-token-manager too.
export { metaLabel, refreshLabel }
