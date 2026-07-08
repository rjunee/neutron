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

import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import type { ProjectDb } from '@neutronai/persistence/index.ts'
import { ApiKeyStore, ApiKeyStoreError, type ApiKeyProvider } from '@neutronai/auth/api-key-store.ts'
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
  /**
   * System slots backed by the per-owner `ApiKeyStore` (provider keys that
   * carry an `api_keys` metadata row alongside the secret). Core slots leave
   * this undefined and store the secret directly under their own id. When set,
   * set/delete route through `ApiKeyStore.add`/`delete` so the metadata row AND
   * the secret stay consistent (exactly as onboarding writes it) — this matters
   * because the BYO credential read path (`resolveLlmCredentials` →
   * `ApiKeyStore.list`) keys off the metadata row, and so an admin-pasted key
   * must create it too. The secret persists under `${provider}:${label}`, the
   * SAME label the onboarding optional-key offer uses, so both surfaces manage
   * one shared key.
   */
  api_key_store?: { provider: ApiKeyProvider; label: string }
}

/**
 * The public id for the system OpenAI key slot — colon-free so it survives
 * `encodeURIComponent` in the `/api/cores/api-keys/<id>` path — and the
 * onboarding ApiKeyStore (provider, label) it persists under. A key set in
 * onboarding OR here is the one `resolveSecret({provider:'openai',
 * label:'onboarding'})` reads to flip GBrain into semantic-embeddings mode
 * (ND1), and the one `ApiKeyStore.list` advertises for cross-model GPT-5 reviews.
 */
export const SYSTEM_OPENAI_SLOT_ID = 'openai_api_key'
const SYSTEM_OPENAI_PROVIDER: ApiKeyProvider = 'openai'
const SYSTEM_OPENAI_LABEL = 'onboarding'
/** Derived secrets label (`${provider}:${label}`) for presence checks. */
export const SYSTEM_OPENAI_STORAGE_LABEL = `${SYSTEM_OPENAI_PROVIDER}:${SYSTEM_OPENAI_LABEL}`

/** The `byo_api_key` secrets label a slot reads/writes under. */
function slotSecretsLabel(id: string, slot: ApiKeySlot): string {
  return slot.api_key_store !== undefined
    ? `${slot.api_key_store.provider}:${slot.api_key_store.label}`
    : id
}

/**
 * System-declared API-key slots — manageable in the same Integrations panel but
 * NOT owned by any bundled Core. Today: the OpenAI key that upgrades memory
 * recall from keyword+graph to semantic-search embeddings.
 */
export function systemApiKeySlots(): Map<string, ApiKeySlot> {
  return new Map<string, ApiKeySlot>([
    [
      SYSTEM_OPENAI_SLOT_ID,
      {
        name: 'OpenAI (semantic memory + GPT-5 reviews)',
        core_slugs: [],
        required: false,
        install_prompt:
          'Paste an OpenAI API key to switch memory recall from keyword + graph ' +
          'to semantic-search embeddings (sharper recall); also powers cross-model ' +
          'GPT-5 reviews. Get one at platform.openai.com/api-keys. ' +
          "(OpenAI sign-in/OAuth doesn't authorize embeddings — a real key is required.)",
        api_key_store: { provider: SYSTEM_OPENAI_PROVIDER, label: SYSTEM_OPENAI_LABEL },
      },
    ],
  ])
}

/**
 * All api-key slots the Integrations panel manages: bundled-Core `byo_api_key`
 * declarations plus the system slots. A Core that declares the same id wins
 * (system slots only fill gaps), so this never masks a Core's own slot.
 */
export function collectAllApiKeySlots(
  registry: IntegrationsRegistryView,
): Map<string, ApiKeySlot> {
  const map = collectApiKeySlots(registry)
  for (const [id, slot] of systemApiKeySlots()) {
    if (!map.has(id)) map.set(id, slot)
  }
  return map
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
  const apiKeySlots = collectAllApiKeySlots(input.registry)

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
  for (const [id, slot] of apiKeySlots) {
    api_keys.push({
      kind: 'api_key',
      label: id,
      name: slot.name,
      core_slugs: slot.core_slugs,
      required: slot.required,
      install_prompt: slot.install_prompt,
      // Presence is checked against the SECRETS label (which may differ from
      // the public id for system slots), so an onboarding-set OpenAI key shows
      // as connected here too.
      connected: present.has(slotSecretsLabel(id, slot)),
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
  /**
   * Project DB — REQUIRED for `api_key_store`-backed system slots so set/delete
   * route through `ApiKeyStore` (secret + metadata row together). Optional for
   * Core slots (secret-only). Both real call sites (the HTTP surface + the
   * agent-native chat tools) supply it.
   */
  db?: ProjectDb
}

/**
 * Store (or rotate) an API key for a managed slot.
 *
 * Core slots store the secret directly (`replaceAtomic` — set-or-rotate in one
 * transaction). `api_key_store`-backed system slots (the OpenAI key) route
 * through `ApiKeyStore` so the `api_keys` metadata row is created alongside the
 * secret — otherwise `ApiKeyStore.list`-based credential resolution
 * (`resolveLlmCredentials`) wouldn't see an admin-pasted key. Rejects unknown
 * labels + empty values.
 */
export async function setApiKey(
  input: SetApiKeyInput,
): Promise<{ stored: true }> {
  const slots = collectAllApiKeySlots(input.registry)
  const slot = slots.get(input.label)
  if (slot === undefined) {
    throw new IntegrationsError(
      'unknown_label',
      `label='${input.label}' is not a managed api-key slot (no bundled Core or system slot declares it)`,
    )
  }
  const value = input.value.trim()
  if (value.length === 0) {
    throw new IntegrationsError('empty_value', 'api key value must be non-empty')
  }
  if (slot.api_key_store !== undefined && input.db !== undefined) {
    // Route through ApiKeyStore (secret + api_keys metadata row). Rotate =
    // delete-if-exists then add, so a re-paste over an existing key succeeds
    // instead of tripping the duplicate-label guard.
    const apiKeys = new ApiKeyStore({ db: input.db, secrets: input.secretsStore })
    const { provider, label } = slot.api_key_store
    try {
      await apiKeys.delete({ internal_handle: input.project_slug, provider, label })
    } catch (err) {
      if (!(err instanceof ApiKeyStoreError && err.code === 'not_found')) throw err
    }
    await apiKeys.add({ internal_handle: input.project_slug, provider, label, plaintext: value })
    return { stored: true }
  }
  await input.secretsStore.replaceAtomic([
    {
      internal_handle: input.project_slug,
      kind: 'byo_api_key',
      label: slotSecretsLabel(input.label, slot),
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
  /** Project DB — REQUIRED for `api_key_store`-backed slots (see SetApiKeyInput.db). */
  db?: ProjectDb
}

/**
 * Clear a stored API key. Returns `{deleted:false}` when the slot is known but
 * no key was stored (idempotent). `api_key_store`-backed system slots route
 * through `ApiKeyStore.delete` so the secret AND the `api_keys` metadata row are
 * removed together — leaving an orphan metadata row would make a later
 * onboarding re-paste trip the duplicate-label guard. Rejects unknown labels.
 */
export async function deleteApiKey(
  input: DeleteApiKeyInput,
): Promise<{ deleted: boolean }> {
  const slots = collectAllApiKeySlots(input.registry)
  const slot = slots.get(input.label)
  if (slot === undefined) {
    throw new IntegrationsError(
      'unknown_label',
      `label='${input.label}' is not a managed api-key slot (no bundled Core or system slot declares it)`,
    )
  }
  if (slot.api_key_store !== undefined && input.db !== undefined) {
    const apiKeys = new ApiKeyStore({ db: input.db, secrets: input.secretsStore })
    const { provider, label } = slot.api_key_store
    try {
      await apiKeys.delete({ internal_handle: input.project_slug, provider, label })
      return { deleted: true }
    } catch (err) {
      if (err instanceof ApiKeyStoreError && err.code === 'not_found') return { deleted: false }
      throw err
    }
  }
  const storageLabel = slotSecretsLabel(input.label, slot)
  const rows = await input.secretsStore.list({
    internal_handle: input.project_slug,
    kind: 'byo_api_key',
  })
  const match = rows.find((r) => r.label === storageLabel)
  if (match === undefined) return { deleted: false }
  await input.secretsStore.delete(match.id)
  return { deleted: true }
}

export interface DisconnectOAuthInput {
  /** Token manager for the per-project SecretsStore (revoke + delete). */
  tokens: OAuthTokenManager
  /** Bundled-Cores registry view — used to find every Core sharing the label. */
  registry: IntegrationsRegistryView
  /** Project DB — for the per-Core `install_state` write. */
  projectDb: ProjectDb
  project_slug: string
  label: string
}

export interface DisconnectOAuthResult {
  /** `true` when at least one stored token row was deleted. */
  deleted: boolean
  /** Slugs of every bundled Core that declared the disconnected label. */
  affected_cores: string[]
}

/**
 * SHARED OAuth-disconnect brain — the single mutation both the HTTP admin
 * surface (`POST /api/cores/oauth/google/disconnect/<label>`) and the
 * agent-native `integrations_disconnect` chat tool route through, so the two
 * paths can't diverge (mirrors how `runOAuthStart`/`startOAuth` already
 * unify connect). Two effects, in order:
 *
 *   1. Revoke + delete the stored tokens via the manager.
 *   2. Flag EVERY bundled Core that declares the label as
 *      `install_failed_dependency_missing`, so `/api/cores` surfaces a
 *      reconnect cue instead of still reporting the Core `installed` with a
 *      silently-broken dependency.
 *
 * Before this brain existed the chat tool did (1) only — leaving the Core
 * reporting `installed` after a chat disconnect (Argus PR #13 IMPORTANT #3).
 */
export async function disconnectOAuth(
  input: DisconnectOAuthInput,
): Promise<DisconnectOAuthResult> {
  const { deleted } = await input.tokens.disconnect(input.label)
  // Lazy import to avoid a static cycle with the install lifecycle (mirrors
  // the OAuth surface's onInvalidGrant callback).
  const { updateInstallState } = await import('./install-bundled.ts')
  const affected_cores: string[] = []
  for (const core of input.registry.list()) {
    if (core.manifest.secrets.some((s) => s.label === input.label)) {
      affected_cores.push(core.slug)
      try {
        await updateInstallState(
          input.projectDb,
          input.project_slug,
          core.slug,
          'install_failed_dependency_missing',
        )
      } catch {
        // best-effort — a single Core's state write must not fail the whole
        // disconnect.
      }
    }
  }
  return { deleted, affected_cores }
}

// Re-export the suffix helpers so callers constructing oauth row shapes
// (tests, surfaces) don't have to import from oauth-token-manager too.
export { metaLabel, refreshLabel }
