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
 * A MISS IS DISTINGUISHABLE (card 2026-08-14). Credential rows carry the FROZEN
 * owner handle, so rows written under a PREVIOUS handle (`dev` on a box that
 * later boots as `juno`) are invisible to every read here. Presence-only status
 * printed that as `connected: false` — the same sentence as "you never
 * connected this", which is what turned a night of failed publishes into a
 * hunt for a blinking token. When `db` is supplied this surface now also reports
 * an `orphaned_credentials` summary and per-slot `orphaned: true`, naming the
 * migrate action. Read-only: nothing here writes or decrypts a credential.
 *
 * Cross-ref: gateway/http/cores-oauth-surface.ts (HTTP surface),
 * gateway/composition/wire-cores-surfaces.ts (tool registration),
 * gateway/cores/oauth-token-manager.ts, auth/secrets-store.ts.
 */

import type { SecretsStore } from '@neutronai/auth/secrets-store.ts'
import { asOwnerHandle, type ProjectDb } from '@neutronai/persistence/index.ts'
import { ApiKeyStore, ApiKeyStoreError, type ApiKeyProvider } from '@neutronai/auth/api-key-store.ts'
import {
  censusCredentialScope,
  listOrphanedSecretSlots,
  type CredentialScopeOrphanCount,
} from '@neutronai/auth/credential-scope-reconcile.ts'
import { metaLabel, parseGrantLabel, refreshLabel } from './oauth-token-manager.ts'
import type {
  OAuthTokenManager,
  OAuthTokenStatus,
} from './oauth-token-manager.ts'

/**
 * Minimal structural view of a manifest secret declaration — only the
 * fields this module reads. Defined locally (rather than importing
 * `@neutronai/cores-sdk`'s `ManifestSecret`) so the bundled registry's slightly looser
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

/**
 * The agent tool + HTTP action that moves credential rows scoped to a previous
 * owner handle onto the boot handle. Named HERE (rather than in the tool module)
 * so the status surface can point at it: a summary that says "orphaned" without
 * naming the way out has fixed the cheap half of the card.
 */
export const MIGRATE_ORPHANED_ACTION = 'integrations_migrate_orphaned'

/**
 * Credential rows that exist but are scoped to a PREVIOUS owner handle — the
 * difference between "not connected" and "connected, but this process cannot
 * see it". Counts and handles only; never a secret value.
 */
export interface OrphanedCredentialsSummary {
  /** Rows under a non-boot handle, summed across every swept credential table. */
  total_rows: number
  /** The distinct non-boot handles those rows sit under, sorted. */
  stale_handles: string[]
  /** Per-(table, handle) breakdown — `project_credentials` orphans show here too. */
  tables: CredentialScopeOrphanCount[]
  /** The action that repairs it (see {@link MIGRATE_ORPHANED_ACTION}). */
  migrate_action: string
  /** One human/agent-readable sentence, safe to print verbatim. */
  message: string
}

/** A per-Core Google OAuth account slot + its live connection status. */
export interface OAuthAccountIntegration extends OAuthTokenStatus {
  kind: 'oauth'
  /** Manifest-declared scope string for the label. */
  scope: string
  /** Every bundled Core slug that declares this label. */
  core_slugs: string[]
  /**
   * `true` when this slot reads disconnected but a credential row for it exists
   * under a previous owner handle — "scoped to a previous handle", not
   * "not connected". A CONNECTED slot is never `orphaned` (a fresh boot-handle
   * credential wins the slot; its stale twin is still counted in the summary).
   */
  orphaned: boolean
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
  /** See {@link OAuthAccountIntegration.orphaned}. */
  orphaned: boolean
}

export interface IntegrationsStatus {
  oauth: OAuthAccountIntegration[]
  api_keys: ApiKeyIntegration[]
  /**
   * Non-null when credential rows are scoped to a previous owner handle. `null`
   * means every credential row this instance can see is on the boot handle — so
   * a `connected: false` slot really is "never connected".
   */
  orphaned_credentials: OrphanedCredentialsSummary | null
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
  /**
   * Project DB — enables the `orphaned_credentials` summary + per-slot
   * `orphaned` annotation (read-only census of the credential tables' scope
   * columns). Optional so older callers keep compiling; both real call sites
   * (the HTTP surface + the agent-native tools) supply it. Without it the
   * status degrades to presence-only: `orphaned_credentials: null` and every
   * slot `orphaned: false`.
   */
  db?: ProjectDb
}

/** The orphan census + the slot lookups derived from it, for one status build. */
interface OrphanAnnotation {
  summary: OrphanedCredentialsSummary | null
  /** Services with an orphaned `oauth_token` grant row (meta/refresh rows excluded). */
  services: Set<string>
  /** Raw `byo_api_key` labels with an orphaned `secrets` row. */
  apiKeyLabels: Set<string>
}

const NO_ORPHANS: OrphanAnnotation = {
  summary: null,
  services: new Set<string>(),
  apiKeyLabels: new Set<string>(),
}

/**
 * Census the credential tables against the boot handle and derive the per-slot
 * lookups. Read-only: no writes, no decrypt, and the only `secrets` columns read
 * are `kind`/`label` (slot identifiers this surface already renders).
 */
function buildOrphanAnnotation(db: ProjectDb, boot_handle: string): OrphanAnnotation {
  const { stale_handles, orphan_counts } = censusCredentialScope(db, boot_handle)
  if (stale_handles.length === 0) return NO_ORPHANS

  const total_rows = orphan_counts.reduce((sum, c) => sum + c.rows, 0)
  const summary: OrphanedCredentialsSummary = {
    total_rows,
    stale_handles,
    tables: orphan_counts,
    migrate_action: MIGRATE_ORPHANED_ACTION,
    message:
      `${total_rows} credential row(s) are scoped to a previous owner handle ` +
      `(${stale_handles.join(', ')}), not missing — run the ${MIGRATE_ORPHANED_ACTION} ` +
      `action to move them to '${boot_handle}'.`,
  }

  const services = new Set<string>()
  const apiKeyLabels = new Set<string>()
  for (const { kind, label } of listOrphanedSecretSlots(db, boot_handle)) {
    if (kind === 'oauth_token') {
      // The refresh/meta companions share the grant's label with a suffix; only
      // the ACCESS row names the slot the panel renders.
      if (label.endsWith(refreshLabel('')) || label.endsWith(metaLabel(''))) continue
      services.add(parseGrantLabel(label).service)
    } else if (kind === 'byo_api_key') {
      apiKeyLabels.add(label)
    }
  }
  return { summary, services, apiKeyLabels }
}

/**
 * Build the unified status. OAuth status comes from `OAuthTokenManager`
 * (live access/refresh/meta read); API-key `connected` is a presence check
 * against the `byo_api_key` rows — NO plaintext ever leaves this function.
 *
 * With `input.db` supplied, a slot that reads disconnected but has a credential
 * row under a PREVIOUS owner handle is annotated `orphaned: true` and the status
 * carries an `orphaned_credentials` summary naming the migrate action, so the
 * surface never calls a wrong-scope miss "not connected" (acceptance (b)).
 */
export async function buildIntegrationsStatus(
  input: BuildIntegrationsStatusInput,
): Promise<IntegrationsStatus> {
  const oauthSlots = collectOAuthSlots(input.registry)
  const apiKeySlots = collectAllApiKeySlots(input.registry)
  const orphans =
    input.db !== undefined
      ? buildOrphanAnnotation(input.db, input.project_slug)
      : NO_ORPHANS

  // One row per CONNECTED ACCOUNT. A service the owner has connected three
  // accounts to shows three rows, each independently disconnectable; a service
  // with none shows its single disconnected row so a Connect action can render.
  const oauth: OAuthAccountIntegration[] = []
  for (const [service, slot] of oauthSlots) {
    const grants = await input.tokens.listGrants(service)
    const labels = grants.length > 0 ? grants.map((g) => g.label) : [service]
    for (const label of labels) {
      const status = await input.tokens.getStatus(label)
      oauth.push({
        kind: 'oauth',
        ...status,
        scope: slot.scope,
        core_slugs: slot.core_slugs,
        // A connected slot is never orphaned: a fresh boot-handle credential
        // wins the slot, and the stale twin stays visible in the summary.
        orphaned: !status.connected && orphans.services.has(status.service),
      })
    }
  }

  // One list() read (no decrypt) → label-presence set for every api-key.
  const rows = await input.secretsStore.list({
    owner_handle: asOwnerHandle(input.project_slug),
    kind: 'byo_api_key',
  })
  const present = new Set(rows.map((r) => r.label))

  const api_keys: ApiKeyIntegration[] = []
  for (const [id, slot] of apiKeySlots) {
    const storageLabel = slotSecretsLabel(id, slot)
    // Presence is checked against the SECRETS label (which may differ from
    // the public id for system slots), so an onboarding-set OpenAI key shows
    // as connected here too.
    const connected = present.has(storageLabel)
    api_keys.push({
      kind: 'api_key',
      label: id,
      name: slot.name,
      core_slugs: slot.core_slugs,
      required: slot.required,
      install_prompt: slot.install_prompt,
      connected,
      orphaned: !connected && orphans.apiKeyLabels.has(storageLabel),
    })
  }

  // Deterministic ordering so UI + tests are stable.
  oauth.sort((a, b) => a.label.localeCompare(b.label))
  api_keys.sort((a, b) => a.label.localeCompare(b.label))
  return { oauth, api_keys, orphaned_credentials: orphans.summary }
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
      await apiKeys.delete({ owner_handle: asOwnerHandle(input.project_slug), provider, label })
    } catch (err) {
      if (!(err instanceof ApiKeyStoreError && err.code === 'not_found')) throw err
    }
    await apiKeys.add({ owner_handle: asOwnerHandle(input.project_slug), provider, label, plaintext: value })
    return { stored: true }
  }
  await input.secretsStore.replaceAtomic([
    {
      owner_handle: asOwnerHandle(input.project_slug),
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
      await apiKeys.delete({ owner_handle: asOwnerHandle(input.project_slug), provider, label })
      return { deleted: true }
    } catch (err) {
      if (err instanceof ApiKeyStoreError && err.code === 'not_found') return { deleted: false }
      throw err
    }
  }
  const storageLabel = slotSecretsLabel(input.label, slot)
  const rows = await input.secretsStore.list({
    owner_handle: asOwnerHandle(input.project_slug),
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
  // A grant label is `<service>#<account_key>`; a manifest declares the
  // SERVICE. Addressing an ACCOUNT disconnects that account; addressing the
  // SERVICE disconnects every account of it — which is what "Disconnect
  // Google Calendar" has always meant and must keep meaning.
  const { service, account_key } = parseGrantLabel(input.label)
  // Addressing the service also clears the BARE `<service>` row. That row is
  // either a legacy grant or the token the Core install lifecycle echoed back
  // under the manifest label; "Disconnect Google Calendar" must leave nothing
  // behind either way, or a revoked service would still look connected to the
  // install path.
  const targets =
    account_key !== null
      ? [input.label]
      : [
          ...new Set([
            ...(await input.tokens.listGrants(service)).map((g) => g.label),
            service,
          ]),
        ]
  let deleted = false
  for (const target of targets) {
    const result = await input.tokens.disconnect(target)
    if (result.deleted) deleted = true
  }
  // Cores are only dependency-missing when the LAST account for the service is
  // gone. Disconnecting one of several accounts must not tear down a Core that
  // still has working accounts to read.
  const remaining = await input.tokens.listGrants(service)
  // Lazy import to avoid a static cycle with the install lifecycle (mirrors
  // the OAuth surface's onInvalidGrant callback).
  const { updateInstallState } = await import('./install-bundled.ts')
  const affected_cores: string[] = []
  for (const core of input.registry.list()) {
    if (core.manifest.secrets.some((s) => s.label === service)) {
      affected_cores.push(core.slug)
      if (remaining.length > 0) continue
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
// Re-exported so consumers of `orphaned_credentials.tables` can type it without
// reaching into the auth package.
export type { CredentialScopeOrphanCount }
