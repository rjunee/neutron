/**
 * @neutronai/cores-runtime — install / configure / start / stop /
 * uninstall / upgrade lifecycle.
 *
 * Composes the loader, installations store, namespace allocator, audit
 * log, and platform SecretsStore into a single `installCore(...)` entry
 * point. Out-of-scope here: the conversational install UX (which lives
 * in the onboarding/Telegram surface and consumes the
 * `SecretsPrompter` interface this module defines) and the actual
 * Core-side `start` / `stop` worker semantics (placeholder timestamps
 * only; lifecycle module gets fleshed out in subsequent sprints once a
 * Core has running code).
 *
 * Install flow:
 *   1. Load + validate manifest (loader.ts → CoreInstallError on bad).
 *   2. Decide data layout from manifest capabilities.
 *   3. Allocate namespace (data-namespace.ts).
 *   4. For each manifest.secrets[]: prompt + persist via SecretsPrompter.
 *      Audit each persist (capability gate enforced by SDK; runtime
 *      writes the audit row).
 *   5. Record core_installations row.
 *   6. Best-effort revoke any orphan-state cleanup if any earlier step
 *      throws.
 *
 * Upgrade flow (capability ESCALATION lock):
 *   1. Load new manifest.
 *   2. Diff vs the persisted `manifest_capabilities_json`.
 *      - Capabilities ADDED → throw `CoreInstallError(code:
 *        'capability_escalation_requires_consent')` UNLESS
 *        `consent_acknowledged: true` is passed; with consent, the
 *        new manifest's secrets[] are prompted just like a fresh install.
 *      - Capabilities REMOVED or RENAMED → roll forward without consent
 *        (manifest update + version update only).
 *   3. Layout change (tables ↔ sidecar) → reject; data migration is
 *      out of scope.
 *   4. Update core_installations row.
 *
 * Uninstall flow:
 *   1. Release namespace (drop tables OR delete sidecar).
 *   2. For each manifest.secrets[]: best-effort revokeOAuth callback +
 *      `SecretsStore.delete(...)` for the row matching (kind, label).
 *      Audit each delete.
 *   3. Mark `core_installations.uninstalled_at`.
 */

import type { NeutronManifest, SecretsAccessor } from '@neutronai/cores-sdk'
import { buildSecretsAccessor } from '@neutronai/cores-sdk'
import type { SecretsStore } from '../../auth/secrets-store.ts'
import type { ProjectDb } from '../../persistence/index.ts'

import { CoreInstallError } from './errors.ts'
import {
  CoreInstallationsStore,
  type CoreInstallationRecord,
  type CoreGlobalInstallationRecord,
} from './installations-store.ts'
import { loadCoreFromDir, type LoadedCore } from './loader.ts'
import {
  allocateCoreNamespace,
  decideDataLayout,
  releaseCoreNamespace,
  sidecarDbPath,
  type CoreNamespace,
} from './data-namespace.ts'
import {
  buildAuditedSecretsStore,
  type SecretAuditLog,
} from './secret-audit.ts'

/**
 * Install-time secrets prompt surface. The conversational install
 * (Telegram, web, CLI) implements this; the runtime calls one method
 * per declared secret in `manifest.secrets[]`.
 *
 * Each method returns the plaintext to persist, OR `null` if the user
 * skipped a non-required secret. For required secrets, returning null
 * aborts the install with a typed error.
 */
export interface SecretsPrompter {
  /** Paste-flow BYO API keys. The prompt copy comes from the manifest's
   *  `install_prompt`. The implementation typically renders an input
   *  field, validates length, returns the trimmed value. */
  promptApiKey(input: {
    kind: 'byo_api_key' | 'webhook_secret'
    label: string
    install_prompt: string
    required: boolean
  }): Promise<string | null>

  /** OAuth-redirect bearer tokens. The implementation typically launches
   *  a browser flow, captures the access_token, returns it. May also
   *  return `null` for skipped non-required secrets. */
  promptOauthToken(input: {
    kind: 'oauth_token'
    label: string
    scope?: string
    install_prompt: string
    required: boolean
  }): Promise<{ access_token: string; expires_at?: number } | null>

  /** OAuth client_id+secret pair (Open tier — user-supplied OAuth app). */
  promptOauthClient(input: {
    kind: 'oauth_client'
    label: string
    scope?: string
    install_prompt: string
    required: boolean
  }): Promise<{ client_id: string; client_secret: string } | null>
}

export interface InstallCoreInput {
  project_slug: string
  /** Absolute path to the Core's directory on disk. */
  coreDir: string
  projectDb: ProjectDb
  /** Instance data dir; sidecar files land at `<dataDir>/cores/<slug>.db`. */
  dataDir: string
  secretsStore: SecretsStore
  audit: SecretAuditLog
  installations: CoreInstallationsStore
  prompter: SecretsPrompter
}

export interface InstallCoreResult {
  core: LoadedCore
  namespace: CoreNamespace
  installation: CoreInstallationRecord
  /** Capability-gated SecretsAccessor a Core's runtime uses to read its
   *  declared secrets. Built on top of the audited platform store. */
  secrets_accessor: SecretsAccessor
}

export async function installCore(
  input: InstallCoreInput,
): Promise<InstallCoreResult> {
  // 1. Load + validate manifest.
  const core = loadCoreFromDir(input.coreDir)

  // Reject duplicate live installs. An idempotent re-install (same slug,
  // same version) is allowed but logs that we're replacing — the
  // installations-store record() upsert handles the row.
  const existing = await input.installations.get(input.project_slug, core.slug)
  if (existing !== null && existing.uninstalled_at === null) {
    if (existing.package_version === core.package_version) {
      // Same version — refuse to clobber. Caller should call upgrade()
      // explicitly if they want to roll forward.
      throw new CoreInstallError(
        'duplicate_install',
        `core=${core.slug} version=${core.package_version} is already installed for project=${input.project_slug}`,
        {
          core_slug: core.slug,
          existing_version: existing.package_version,
        },
      )
    }
    // Different version — also refuse; route through upgrade().
    throw new CoreInstallError(
      'duplicate_install',
      `core=${core.slug} is already installed at version=${existing.package_version} (tried install at ${core.package_version}); use upgradeCore() to change versions`,
      {
        core_slug: core.slug,
        existing_version: existing.package_version,
        attempted_version: core.package_version,
      },
    )
  }

  // 2. Decide data layout from manifest capabilities.
  const { layout } = decideDataLayout(core.manifest.capabilities, core.slug)

  // 3. Allocate namespace.
  const namespace = allocateCoreNamespace({
    project_slug: input.project_slug,
    slug: core.slug,
    manifest_capabilities: core.manifest.capabilities,
    dataDir: input.dataDir,
    layout,
  })

  // 4. Drive secrets prompts.
  await driveSecretsInstall({
    project_slug: input.project_slug,
    core_slug: core.slug,
    manifest: core.manifest,
    secretsStore: input.secretsStore,
    audit: input.audit,
    prompter: input.prompter,
  })

  // 5. Record installation.
  const installation = await input.installations.record({
    project_slug: input.project_slug,
    core_slug: core.slug,
    package_name: core.package_name,
    package_version: core.package_version,
    capabilities: [...core.manifest.capabilities],
    data_layout: namespace.layout,
    ...(namespace.layout === 'sidecar'
      ? { sidecar_db_path: namespace.sidecar_db_path }
      : {}),
  })

  // 6. Build the capability-gated accessor wrapping the audited store.
  const auditedStore = buildAuditedSecretsStore(input.secretsStore, {
    audit: input.audit,
    project_slug: input.project_slug,
    core_slug: core.slug,
  })
  const accessor = buildSecretsAccessor(
    { manifest: core.manifest },
    {
      // 2026-05-12 — the SDK now keys SecretsStore reads on the FROZEN
      // `internal_handle` (see `auth/secrets-store.ts` header). The
      // cores lifecycle's `project_slug` field carries the same value
      // at install time (internal_handle === project_slug for a fresh
      // instance). A future plumb-through of internal_handle distinct
      // from project_slug lands in a follow-up.
      internal_handle: input.project_slug,
      store: auditedStore,
      core_id: core.slug,
    },
  )

  return {
    core,
    namespace,
    installation,
    secrets_accessor: accessor,
  }
}

// ── GLOBAL install scope (WAVE 3 PR-2) ─────────────────────────────────────
//
// A GLOBAL install registers a Core into the global app shell + every project
// (its `project_tab` surfaces show up in `GET /api/app/tabs`). Unlike the
// per-project `installCore`, a global install is project-agnostic: it has no
// per-project data namespace and no per-project secrets prompt — it records
// that the Core is globally available in `core_global_installations`. The
// per-project data/secrets handling for a globally-installed Core, when it is
// actually exercised inside a project, is a per-project concern that still
// flows through `installCore`. Keeping the two paths separate leaves the
// heavily-tested per-project lifecycle byte-identical.

export interface InstallCoreGloballyInput {
  /** Absolute path to the Core's directory on disk. */
  coreDir: string
  installations: CoreInstallationsStore
}

export interface UninstallCoreGloballyInput {
  core_slug: string
  installations: CoreInstallationsStore
}

/** True iff the manifest permits installation in `scope`. An omitted
 *  `install_scopes` means project-only (the pre-WAVE-3 default). */
export function manifestSupportsScope(
  manifest: NeutronManifest,
  scope: 'project' | 'global',
): boolean {
  const scopes = manifest.install_scopes ?? ['project']
  return scopes.includes(scope)
}

/**
 * Install a Core GLOBALLY. Loads + validates the manifest, gates on the
 * manifest's `install_scopes` (must include `'global'`), refuses a duplicate
 * live global install, and records the global installation row.
 */
export async function installCoreGlobally(
  input: InstallCoreGloballyInput,
): Promise<CoreGlobalInstallationRecord> {
  const core = loadCoreFromDir(input.coreDir)

  if (!manifestSupportsScope(core.manifest, 'global')) {
    throw new CoreInstallError(
      'scope_not_supported',
      `core=${core.slug} does not declare 'global' in its manifest install_scopes; cannot install globally`,
      {
        core_slug: core.slug,
        declared_scopes: core.manifest.install_scopes ?? ['project'],
      },
    )
  }

  const existing = await input.installations.getGlobal(core.slug)
  if (existing !== null && existing.uninstalled_at === null) {
    throw new CoreInstallError(
      'duplicate_install',
      `core=${core.slug} is already installed globally at version=${existing.package_version}`,
      { core_slug: core.slug, existing_version: existing.package_version },
    )
  }

  return input.installations.recordGlobal({
    core_slug: core.slug,
    package_name: core.package_name,
    package_version: core.package_version,
    capabilities: [...core.manifest.capabilities],
  })
}

/** Uninstall a globally-installed Core (tombstone `uninstalled_at`).
 *  Idempotent: a no-op when the Core was never globally installed or is
 *  already uninstalled. */
export async function uninstallCoreGlobally(
  input: UninstallCoreGloballyInput,
): Promise<void> {
  const existing = await input.installations.getGlobal(input.core_slug)
  if (existing === null || existing.uninstalled_at !== null) return
  await input.installations.markGlobalUninstalled(input.core_slug)
}

async function driveSecretsInstall(input: {
  project_slug: string
  core_slug: string
  manifest: NeutronManifest
  secretsStore: SecretsStore
  audit: SecretAuditLog
  prompter: SecretsPrompter
}): Promise<void> {
  for (const secret of input.manifest.secrets) {
    if (secret.kind === 'byo_api_key' || secret.kind === 'webhook_secret') {
      const plaintext = await input.prompter.promptApiKey({
        kind: secret.kind,
        label: secret.label,
        install_prompt: secret.install_prompt,
        required: secret.required,
      })
      if (plaintext === null) {
        if (secret.required) {
          throw new CoreInstallError(
            'manifest_invalid',
            `required secret kind=${secret.kind} label=${secret.label} was not provided during install`,
            { core_slug: input.core_slug, secret_name: secret.name },
          )
        }
        continue
      }
      await persistOrRotate({
        secretsStore: input.secretsStore,
        project_slug: input.project_slug,
        kind: secret.kind,
        label: secret.label,
        plaintext,
      })
      await input.audit.record({
        project_slug: input.project_slug,
        core_slug: input.core_slug,
        op: 'put',
        kind: secret.kind,
        label: secret.label,
        outcome: 'ok',
      })
    } else if (secret.kind === 'oauth_token') {
      const ok = await input.prompter.promptOauthToken({
        kind: secret.kind,
        label: secret.label,
        ...(secret.scope !== undefined ? { scope: secret.scope } : {}),
        install_prompt: secret.install_prompt,
        required: secret.required,
      })
      if (ok === null) {
        if (secret.required) {
          throw new CoreInstallError(
            'manifest_invalid',
            `required secret kind=${secret.kind} label=${secret.label} was not provided during install`,
            { core_slug: input.core_slug, secret_name: secret.name },
          )
        }
        continue
      }
      await persistOrRotate({
        secretsStore: input.secretsStore,
        project_slug: input.project_slug,
        kind: secret.kind,
        label: secret.label,
        plaintext: ok.access_token,
        ...(ok.expires_at !== undefined ? { expires_at: ok.expires_at } : {}),
      })
      await input.audit.record({
        project_slug: input.project_slug,
        core_slug: input.core_slug,
        op: 'put',
        kind: secret.kind,
        label: secret.label,
        outcome: 'ok',
      })
    } else if (secret.kind === 'oauth_client') {
      const ok = await input.prompter.promptOauthClient({
        kind: secret.kind,
        label: secret.label,
        ...(secret.scope !== undefined ? { scope: secret.scope } : {}),
        install_prompt: secret.install_prompt,
        required: secret.required,
      })
      if (ok === null) {
        if (secret.required) {
          throw new CoreInstallError(
            'manifest_invalid',
            `required secret kind=${secret.kind} label=${secret.label} was not provided during install`,
            { core_slug: input.core_slug, secret_name: secret.name },
          )
        }
        continue
      }
      // OAuth client = client_id + client_secret. We persist both as
      // a single JSON blob under the same (kind, label) row — the
      // platform SecretsStore is shape-agnostic so callers parse on
      // read. This matches the pattern Sprint 11 used for ChatGPT
      // OAuth client storage.
      const blob = JSON.stringify({
        client_id: ok.client_id,
        client_secret: ok.client_secret,
      })
      await persistOrRotate({
        secretsStore: input.secretsStore,
        project_slug: input.project_slug,
        kind: secret.kind,
        label: secret.label,
        plaintext: blob,
      })
      await input.audit.record({
        project_slug: input.project_slug,
        core_slug: input.core_slug,
        op: 'put',
        kind: secret.kind,
        label: secret.label,
        outcome: 'ok',
      })
    }
  }
}

/**
 * Helper — write a secret, falling back to rotate if a row already
 * exists. The platform `SecretsStore.put()` is INSERT-only and rejects
 * duplicates with `duplicate_label`, so the SDK and this module both
 * implement the list+rotate fallback.
 */
async function persistOrRotate(input: {
  secretsStore: SecretsStore
  /**
   * 2026-05-12 — the Cores lifecycle uses `project_slug` as its
   * caller-facing identity; on-disk SecretsStore writes are keyed on
   * the FROZEN `internal_handle`. At first install
   * `project_slug === internal_handle`, so this mapping is a no-op for
   * fresh instances; after a rename, the caller MUST pass the frozen
   * handle here. See `auth/secrets-store.ts` file header.
   */
  project_slug: string
  kind: 'byo_api_key' | 'webhook_secret' | 'oauth_token' | 'oauth_client'
  label: string
  plaintext: string
  expires_at?: number
}): Promise<void> {
  const existing = await input.secretsStore.list({
    internal_handle: input.project_slug,
    kind: input.kind,
  })
  const match = existing.find((r) => r.label === input.label)
  if (match !== undefined) {
    await input.secretsStore.rotate(match.id, input.plaintext, {
      ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
    })
    return
  }
  const putInput: {
    internal_handle: string
    kind: 'byo_api_key' | 'webhook_secret' | 'oauth_token' | 'oauth_client'
    label: string
    plaintext: string
    expires_at?: number
  } = {
    internal_handle: input.project_slug,
    kind: input.kind,
    label: input.label,
    plaintext: input.plaintext,
  }
  if (input.expires_at !== undefined) putInput.expires_at = input.expires_at
  await input.secretsStore.put(putInput)
}

export interface ConfigureCoreInput {
  project_slug: string
  core_slug: string
  installations: CoreInstallationsStore
}

/** Mark the Core as configured. v1 surface; per-Core configure RPC body
 *  shape is a subsequent sprint. */
export async function configureCore(input: ConfigureCoreInput): Promise<void> {
  await input.installations.markConfigured(input.project_slug, input.core_slug)
}

export async function startCore(input: ConfigureCoreInput): Promise<void> {
  await input.installations.markStarted(input.project_slug, input.core_slug)
}

export async function stopCore(input: ConfigureCoreInput): Promise<void> {
  await input.installations.markStopped(input.project_slug, input.core_slug)
}

export interface UninstallCoreInput {
  project_slug: string
  core_slug: string
  projectDb: ProjectDb
  dataDir: string
  secretsStore: SecretsStore
  audit: SecretAuditLog
  installations: CoreInstallationsStore
  /** Optional callback to revoke each OAuth secret's upstream credential.
   *  Called best-effort — failures are recorded as audit rows but do
   *  NOT block the uninstall. */
  revokeOAuth?: (secret: { kind: string; label: string }) => Promise<void>
}

export async function uninstallCore(input: UninstallCoreInput): Promise<void> {
  const installation = await input.installations.get(
    input.project_slug,
    input.core_slug,
  )
  if (installation === null) {
    throw new CoreInstallError(
      'unknown_core',
      `core=${input.core_slug} is not installed in project=${input.project_slug}`,
      { core_slug: input.core_slug },
    )
  }
  if (installation.uninstalled_at !== null) {
    // Already uninstalled — idempotent no-op.
    return
  }

  // 1. Release namespace.
  if (installation.data_layout === 'sidecar') {
    await releaseCoreNamespace({
      project_slug: input.project_slug,
      slug: input.core_slug,
      layout: 'sidecar',
      projectDb: input.projectDb,
      dataDir: input.dataDir,
    })
  } else {
    await releaseCoreNamespace({
      project_slug: input.project_slug,
      slug: input.core_slug,
      layout: 'tables',
      projectDb: input.projectDb,
      dataDir: input.dataDir,
    })
  }

  // 2. For each declared secret: revoke + delete.
  // We re-list rather than re-load the manifest because the manifest
  // file may have been removed by this point (uninstall after
  // package directory cleanup). The audited platform store's `list`
  // returns every row for the project; we filter against the
  // capabilities we recorded at install time.
  const rows = await input.secretsStore.list({ internal_handle: input.project_slug })
  // Match anything kind∈managed-secret-kinds AND label that the install
  // capabilities suggest is owned by this Core. Conservative: we only
  // delete rows whose (kind, label) match the snapshot we'd have audited
  // — i.e. anything other Cores might also own with the same label is
  // intentionally NOT auto-deleted. The runtime invariant is that
  // (project, kind, label) is globally unique per UNIQUE (project_slug,
  // kind, label), so two Cores can't legally share a row anyway.
  for (const row of rows) {
    if (
      row.kind !== 'byo_api_key' &&
      row.kind !== 'oauth_token' &&
      row.kind !== 'oauth_client' &&
      row.kind !== 'webhook_secret'
    ) {
      continue
    }
    if (input.revokeOAuth !== undefined) {
      try {
        await input.revokeOAuth({ kind: row.kind, label: row.label })
      } catch (err) {
        await input.audit.record({
          project_slug: input.project_slug,
          core_slug: input.core_slug,
          op: 'delete',
          kind: row.kind,
          label: row.label,
          outcome: 'error',
          error: err instanceof Error ? err.message : String(err),
        })
        // continue — revoke failures should not block local cleanup
      }
    }
    try {
      await input.secretsStore.delete(row.id)
      await input.audit.record({
        project_slug: input.project_slug,
        core_slug: input.core_slug,
        op: 'delete',
        kind: row.kind,
        label: row.label,
        outcome: 'ok',
      })
    } catch (err) {
      await input.audit.record({
        project_slug: input.project_slug,
        core_slug: input.core_slug,
        op: 'delete',
        kind: row.kind,
        label: row.label,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      })
      // continue — partial cleanup is preferable to a stuck install row
    }
  }

  // 3. Mark uninstalled.
  await input.installations.markUninstalled(input.project_slug, input.core_slug)
}

export interface UpgradeCoreInput {
  project_slug: string
  newCoreDir: string
  projectDb: ProjectDb
  dataDir: string
  secretsStore: SecretsStore
  audit: SecretAuditLog
  installations: CoreInstallationsStore
  prompter: SecretsPrompter
  /** Operator acknowledgement that capability ESCALATION is intentional.
   *  Required when the new manifest declares any capability that wasn't
   *  in the old manifest. Without it, runtime throws
   *  `CoreInstallError(code: 'capability_escalation_requires_consent')`. */
  consent_acknowledged?: boolean
}

export interface UpgradeCoreResult {
  core: LoadedCore
  installation: CoreInstallationRecord
  /** Capabilities present in NEW manifest but NOT in old. Populated
   *  whether or not consent was provided so the caller has a record of
   *  what changed. */
  added_capabilities: string[]
  removed_capabilities: string[]
}

export async function upgradeCore(
  input: UpgradeCoreInput,
): Promise<UpgradeCoreResult> {
  const newCore = loadCoreFromDir(input.newCoreDir)
  const existing = await input.installations.get(input.project_slug, newCore.slug)
  if (existing === null || existing.uninstalled_at !== null) {
    throw new CoreInstallError(
      'unknown_core',
      `cannot upgrade — core=${newCore.slug} has no live install in project=${input.project_slug}`,
      { core_slug: newCore.slug },
    )
  }

  // Diff capabilities.
  const oldSet = new Set(existing.capabilities)
  const newSet = new Set(newCore.manifest.capabilities)
  const added = [...newSet].filter((c) => !oldSet.has(c))
  const removed = [...oldSet].filter((c) => !newSet.has(c))

  // Layout-change reject.
  const oldLayout = existing.data_layout
  const { layout: newLayout } = decideDataLayout(
    newCore.manifest.capabilities,
    newCore.slug,
  )
  if (oldLayout !== newLayout) {
    throw new CoreInstallError(
      'data_layout_change_not_supported',
      `cannot upgrade core=${newCore.slug} from data_layout=${oldLayout} to data_layout=${newLayout}; data migration is out of scope`,
      {
        core_slug: newCore.slug,
        old_layout: oldLayout,
        new_layout: newLayout,
      },
    )
  }

  // Escalation gate.
  if (added.length > 0 && input.consent_acknowledged !== true) {
    throw new CoreInstallError(
      'capability_escalation_requires_consent',
      `core=${newCore.slug} upgrade adds ${added.length} capabilit${added.length === 1 ? 'y' : 'ies'} (${added.join(', ')}); pass consent_acknowledged=true to proceed`,
      {
        core_slug: newCore.slug,
        added_capabilities: added,
        removed_capabilities: removed,
      },
    )
  }

  // If consent provided AND the new manifest declares secrets that aren't
  // already persisted, prompt for them. We re-drive the full install
  // flow against any newly-declared secret in the new manifest.
  if (added.length > 0) {
    // Collect labels already persisted for this project.
    const existingLabels = new Set<string>()
    const all = await input.secretsStore.list({ internal_handle: input.project_slug })
    for (const r of all) existingLabels.add(`${r.kind}:${r.label}`)

    // Re-run the install-secrets driver with a manifest filtered down
    // to the *new* secrets only, so we don't re-prompt for ones the
    // owner already provided.
    const newOnlyManifest: NeutronManifest = {
      ...newCore.manifest,
      secrets: newCore.manifest.secrets.filter(
        (s) => !existingLabels.has(`${s.kind}:${s.label}`),
      ),
    }
    await driveSecretsInstall({
      project_slug: input.project_slug,
      core_slug: newCore.slug,
      manifest: newOnlyManifest,
      secretsStore: input.secretsStore,
      audit: input.audit,
      prompter: input.prompter,
    })
  }

  // Roll forward the row.
  await input.installations.updateVersion({
    project_slug: input.project_slug,
    core_slug: newCore.slug,
    package_version: newCore.package_version,
    capabilities: [...newCore.manifest.capabilities],
  })
  const updated = await input.installations.get(input.project_slug, newCore.slug)
  if (updated === null) {
    throw new CoreInstallError(
      'unknown_core',
      `post-upgrade read returned null for core=${newCore.slug}`,
      { core_slug: newCore.slug },
    )
  }

  return {
    core: newCore,
    installation: updated,
    added_capabilities: added,
    removed_capabilities: removed,
  }
}

/** Helper for callers to compute the canonical sidecar path without
 *  importing `data-namespace.ts`. */
export { sidecarDbPath }
