/**
 * @neutronai/gateway/cores — bundled-Cores install orchestration (P3 wire-up).
 *
 * Drives the `cores` module's `init` body: build the bundled-Cores
 * registry, run each Core's install lifecycle (idempotent, isolated
 * per-Core failures), allocate per-Core data dirs, register each
 * Core's `buildTools(deps)` output against the production
 * `ToolRegistry`.
 *
 * Per `docs/plans/P3-cores-wireup-sprint-brief.md § 2.2`.
 *
 * The brief's "happy path" expects every Tier 1 Core to install
 * cleanly, but the Calendar + Email-Managed manifests declare
 * `required: true` OAuth secrets — a Noop prompter that returns
 * `null` for those routes them into the install-failure bucket with
 * `code: 'manifest_invalid'`. That's the SAME bucket a packaging-
 * broken Core would land in, and it's correct: a Core whose required
 * secret hasn't been provisioned cannot install. The boot warning +
 * `/api/cores`'s `install_state: 'failed'` surface lets the user see
 * and resolve the gap via the connectors UI without dropping the
 * gateway.
 *
 * Failure-rate gate: >50% of discovered Cores failing tips the boot
 * into a hard fault (`CoreInstallError('manifest_invalid')`-shape
 * thrown out of `init`). That's the right behavior — five or more
 * Cores collapsing in one boot indicates a config-level fault
 * (`dataDir` unwritable, DB migration regression), NOT a per-Core
 * bug to log past.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ProjectDb } from '../../persistence/index.ts'
import type { ToolRegistry } from '../../tools/registry.ts'
import type { ApprovalPolicy } from '../../tools/registry.ts'
import type { NeutronCapability } from '../../core-sdk/types.ts'
import { SecretsStore } from '../../auth/secrets-store.ts'
import {
  buildBundledRegistry,
  type BundledCore,
  type BundledRegistry,
  type BundledRegistryEvent,
} from '../../cores/runtime/bundled-registry.ts'
import {
  CoreInstallationsStore,
} from '../../cores/runtime/installations-store.ts'
import { SecretAuditLog } from '../../cores/runtime/secret-audit.ts'
import { CoreInstallError } from '../../cores/runtime/errors.ts'
import {
  installCore,
  type InstallCoreResult,
  type SecretsPrompter,
} from '../../cores/runtime/lifecycle.ts'

import type {
  CoreInstallFailure,
  CoresModuleState,
  LauncherIconLongPressEntry,
  LauncherIconMeta,
} from './composer-state.ts'

/**
 * Per-Core backend factories. The composer calls one per slug after a
 * Core successfully installs; the returned `deps` object is the
 * `ToolDeps` argument of the Core's `buildTools(...)`. Returning
 * `null` (e.g. a Core whose backend dep isn't wired yet) means the
 * tools register with a stub handler returning `not_implemented`
 * per the sprint brief § 2.2 step 6.
 *
 * Production wires real backends here (MemoryStore for Notes,
 * per-instance ReminderStore for Reminders, etc.); test fixtures pass
 * the Cores' in-memory reference adapters.
 */
export type CoreBackendFactory = (
  ctx: CoreBackendFactoryContext,
) => Promise<unknown> | unknown

export interface CoreBackendFactoryContext {
  core: BundledCore
  project_slug: string
  projectDb: ProjectDb
  installation: InstallCoreResult
}

export type CoreBackendFactoryMap = Readonly<Record<string, CoreBackendFactory>>

export interface InstallBundledCoresInput {
  project_slug: string
  projectDb: ProjectDb
  /** `<owner_home>/data` — sidecar files land at `<dataDir>/cores/<slug>.db`. */
  dataDir: string
  /** Pre-built ToolRegistry the Cores' tools register into. */
  tools: ToolRegistry
  /** Pre-built SecretsStore (per-instance, already wired). */
  secretsStore: SecretsStore
  /** Repo roots the bundled registry walks. From
   *  `platform.getBundledCoreRoots()` in production. */
  rootDirs: readonly string[]
  /** Per-slug backend factory map. Slugs not present register tools
   *  with the `not_implemented` stub. */
  backends?: CoreBackendFactoryMap
  /** Override the install-time secrets prompter. Defaults to a
   *  no-prompt prompter that returns `null` for every kind —
   *  required secrets surface as `manifest_invalid` install failures. */
  prompter?: SecretsPrompter
  /** Structured-log sink for registry telemetry + per-Core install
   *  failures. Defaults to `console.warn` for failures and a no-op
   *  for non-blocking telemetry events. */
  log?: (event: BundledRegistryEvent | InstallTelemetryEvent) => void
  /**
   * Threshold of failed Cores (as a fraction of total discovered)
   * above which the composer hard-fails boot. Defaults to 0.5 (>50%
   * fail → throw). Set to `1` in tests to disable the gate when
   * exercising failure isolation in isolation.
   */
  hardFailFailureRatio?: number
}

export interface InstallTelemetryEvent {
  event_name:
    | 'cores.install_failed'
    | 'cores.install_ok'
    | 'cores.tool_registration_failed'
  core_slug: string
  /** `CoreInstallErrorCode` or `'unknown'` for non-typed throws. */
  code?: string
  message?: string
  details?: Record<string, unknown>
}

export interface InstallBundledCoresResult extends CoresModuleState {
  /** Number of Cores discovered by the registry walk. Includes both
   *  installed AND failed (every entry that `registry.list()` returned). */
  discovered: number
}

export async function installBundledCores(
  input: InstallBundledCoresInput,
): Promise<InstallBundledCoresResult> {
  const log = input.log ?? defaultLog
  const prompter = input.prompter ?? NOOP_SECRETS_PROMPTER
  const hardFailRatio = input.hardFailFailureRatio ?? DEFAULT_HARD_FAIL_RATIO

  // 1. Build registry. blockOnFirstError=true: a manifest-invalid
  //    bundled Core is a code bug and must NOT boot the gateway
  //    half-broken. `CoreInstallError` propagates out of init.
  const registry: BundledRegistry = buildBundledRegistry({
    rootDir: [...input.rootDirs],
    blockOnFirstError: true,
    telemetry: (event) => log(event),
  })

  // 2. Shared install deps.
  const installations = new CoreInstallationsStore({ db: input.projectDb })
  // Owner-native author (connect-spec §4.3 layer 3): in Open every Core action
  // is the owner's own turn, so audit rows are attributed to 'owner' (matching
  // the owner author #0 stamped on web-chat turns in chat-bridge). A future
  // Connect per-turn collaborator overrides this via a per-call author_id.
  const audit = new SecretAuditLog({ db: input.projectDb, author_id: 'owner' })

  const installed = new Map<string, InstallCoreResult>()
  const failures: CoreInstallFailure[] = []
  const launcherIcons = new Map<string, LauncherIconMeta>()

  const cores = registry.list()
  for (const core of cores) {
    try {
      // Idempotent install — same (project_slug, slug) at same version
      // surfaces as `duplicate_install`. We catch that ONE code and
      // re-load the existing row so a boot loop doesn't force every
      // instance to be uninstalled-and-reinstalled across restarts.
      let result: InstallCoreResult | null = null
      try {
        result = await installCore({
          project_slug: input.project_slug,
          coreDir: core.coreDir,
          projectDb: input.projectDb,
          dataDir: input.dataDir,
          secretsStore: input.secretsStore,
          audit,
          installations,
          prompter,
        })
      } catch (err) {
        if (err instanceof CoreInstallError && err.code === 'duplicate_install') {
          // Live row at same version. Re-run the install lifecycle's
          // accessor build for a fresh process (the in-memory shape
          // didn't survive the restart) but DON'T re-drive
          // `driveSecretsInstall` — the existing rows are authoritative.
          result = await rehydrateExistingInstall({
            core,
            project_slug: input.project_slug,
            projectDb: input.projectDb,
            dataDir: input.dataDir,
            secretsStore: input.secretsStore,
            audit,
            installations,
          })
        } else {
          throw err
        }
      }

      if (result === null) {
        // Defensive — the rehydrate path always returns or throws.
        throw new CoreInstallError(
          'unknown_core',
          `post-install lookup returned null for project=${input.project_slug} core=${core.slug}`,
          { core_slug: core.slug },
        )
      }

      // 3. Register tools into the ToolRegistry.
      const registerArgs: RegisterCoreToolsInput = {
        core,
        project_slug: input.project_slug,
        projectDb: input.projectDb,
        installation: result,
        audit,
        tools: input.tools,
        log,
      }
      const factory = input.backends?.[core.slug]
      if (factory !== undefined) registerArgs.backendFactory = factory
      await registerCoreTools(registerArgs)

      installed.set(core.slug, result)
      // Resolve launcher-icon metadata for the launcher seed. The
      // manifest's `ui_components[].surface === 'launcher_icon'` entry
      // points at a `.ts` module exporting `LAUNCHER_ICON = { emoji,
      // label }`; dynamic-import it once at install time and stash on
      // the module state. Failures here are non-blocking — the Core
      // installed cleanly, the icon is purely cosmetic UX metadata.
      const iconMeta = await resolveLauncherIconMeta(core, log)
      if (iconMeta !== null) {
        launcherIcons.set(core.slug, iconMeta)
      }
      log({
        event_name: 'cores.install_ok',
        core_slug: core.slug,
      })
    } catch (err) {
      const failure = toInstallFailure(core.slug, err)
      failures.push(failure)
      const failEvent: InstallTelemetryEvent = {
        event_name: 'cores.install_failed',
        core_slug: failure.core_slug,
        code: failure.code,
        message: failure.message,
      }
      if (err instanceof CoreInstallError && err.details !== undefined) {
        failEvent.details = err.details
      }
      log(failEvent)
      // Continue to next Core. Failure isolation is the brief's lock.
    }
  }

  // 4. Failure-rate gate. >50% fail = config-level fault.
  if (cores.length > 0) {
    const failureRatio = failures.length / cores.length
    if (failureRatio > hardFailRatio) {
      throw new CoreInstallError(
        'manifest_invalid',
        `bundled Cores boot failure-rate gate tripped: ${failures.length}/${cores.length} failed (>${Math.round(
          hardFailRatio * 100,
        )}%) — refusing to boot a half-broken project`,
        {
          project_slug: input.project_slug,
          failures: failures.map((f) => ({ slug: f.core_slug, code: f.code })),
        },
      )
    }
  }

  return {
    registry,
    installed,
    failures,
    launcherIcons,
    discovered: cores.length,
  }
}

/**
 * Resolve the launcher-icon metadata for a Core by dynamic-importing
 * the first `ui_components[]` entry with `surface === 'launcher_icon'`
 * and reading its exported `LAUNCHER_ICON = { emoji, label }`
 * constant. Returns `null` when:
 *
 *   - the Core has no `launcher_icon` surface in its manifest
 *   - the entry_point module fails to load (file missing, syntax error)
 *   - the module loads but doesn't export `LAUNCHER_ICON` with a string `emoji`
 *
 * Non-blocking: a launcher-icon failure logs a telemetry event but
 * doesn't fail the Core's install (the launcher seed falls back to
 * the per-slug defaults map, and ultimately to 🧩, when this returns
 * null).
 */
async function resolveLauncherIconMeta(
  core: BundledCore,
  log: (event: InstallTelemetryEvent | BundledRegistryEvent) => void,
): Promise<LauncherIconMeta | null> {
  const surface = core.manifest.ui_components.find(
    (c) => c.surface === 'launcher_icon',
  )
  if (surface === undefined) return null
  // entry_point is module-relative (e.g. `./src/ui/launcher-icon.ts`).
  // The runtime composer never validated the path so a Core could ship
  // a garbage value; defend against `undefined` shape errors here.
  if (typeof surface.entry_point !== 'string' || surface.entry_point.length === 0) {
    return null
  }
  const moduleUrl = pathToFileURL(join(core.coreDir, surface.entry_point)).href
  try {
    const mod = (await import(moduleUrl)) as { LAUNCHER_ICON?: unknown }
    const icon = mod.LAUNCHER_ICON
    if (icon === null || typeof icon !== 'object') return null
    const emoji = (icon as { emoji?: unknown }).emoji
    if (typeof emoji !== 'string' || emoji.length === 0) return null
    const label = (icon as { label?: unknown }).label
    const meta: LauncherIconMeta = { emoji }
    if (typeof label === 'string' && label.length > 0) meta.label = label

    // ISSUE #17 — propagate the richer P5.3 launcher fields. All three
    // are optional so Cores shipping the legacy {emoji, label} shape
    // still install cleanly.
    const primary_action = (icon as { primary_action?: unknown }).primary_action
    if (
      typeof primary_action === 'string' &&
      (primary_action === 'open_app_tab' ||
        primary_action === 'chat_send' ||
        primary_action === 'chat_send_prefix')
    ) {
      meta.primary_action = primary_action
    }

    const app_tab_path = (icon as { app_tab_path?: unknown }).app_tab_path
    if (typeof app_tab_path === 'string' && app_tab_path.length > 0) {
      meta.app_tab_path = app_tab_path
    }

    const long_press_menu = (icon as { long_press_menu?: unknown }).long_press_menu
    if (Array.isArray(long_press_menu)) {
      const cleaned: LauncherIconLongPressEntry[] = []
      for (let i = 0; i < long_press_menu.length; i += 1) {
        const raw = long_press_menu[i]
        const sanitized = sanitizeLongPressEntry(raw)
        if (sanitized === null) {
          // Defensive: one malformed entry doesn't kill the whole menu.
          // Surface a structured-log warning so the Core author sees it.
          log({
            event_name: 'cores.tool_registration_failed',
            core_slug: core.slug,
            code: 'launcher_icon_long_press_entry_invalid',
            message: `dropping long_press_menu[${i}] — entry failed shape validation`,
          })
          continue
        }
        cleaned.push(sanitized)
      }
      if (cleaned.length > 0) meta.long_press_menu = cleaned
    }

    return meta
  } catch (err) {
    log({
      event_name: 'cores.tool_registration_failed',
      core_slug: core.slug,
      code: 'launcher_icon_load_failed',
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * Type-narrowing validator for one `long_press_menu[]` entry. Returns
 * the cleaned entry, or `null` if the row failed shape validation
 * (missing or malformed `id` / `label` / `action`, or action-specific
 * field that's required but absent). Used by `resolveLauncherIconMeta`
 * — caller logs and skips on `null`.
 *
 * Validation rules (matches `LauncherIconLongPressEntry` contract):
 *   - `id`     string, length > 0
 *   - `label`  string, length > 0
 *   - `action` one of 'open_app_tab' | 'chat_send' | 'chat_send_prefix'
 *   - when action === 'chat_send'        → `text` MUST be non-empty string
 *   - when action === 'chat_send_prefix' → `prefix` MUST be non-empty string
 *   - when action === 'open_app_tab'     → `prefix` / `text` ignored
 */
function sanitizeLongPressEntry(raw: unknown): LauncherIconLongPressEntry | null {
  if (raw === null || typeof raw !== 'object') return null
  const id = (raw as { id?: unknown }).id
  if (typeof id !== 'string' || id.length === 0) return null
  const label = (raw as { label?: unknown }).label
  if (typeof label !== 'string' || label.length === 0) return null
  const action = (raw as { action?: unknown }).action
  if (
    typeof action !== 'string' ||
    (action !== 'open_app_tab' &&
      action !== 'chat_send' &&
      action !== 'chat_send_prefix')
  ) {
    return null
  }
  const cleaned: LauncherIconLongPressEntry = { id, label, action }
  if (action === 'chat_send') {
    const text = (raw as { text?: unknown }).text
    if (typeof text !== 'string' || text.length === 0) return null
    cleaned.text = text
  } else if (action === 'chat_send_prefix') {
    const prefix = (raw as { prefix?: unknown }).prefix
    if (typeof prefix !== 'string' || prefix.length === 0) return null
    cleaned.prefix = prefix
  }
  return cleaned
}

const DEFAULT_HARD_FAIL_RATIO = 0.5

/**
 * No-prompt SecretsPrompter — returns `null` for every prompt. A Core
 * declaring `required: true` secrets routes to a `manifest_invalid`
 * install failure under this prompter, which is the intended boot
 * behavior: the user hasn't connected the upstream account yet, so
 * the Core cannot install.
 */
const NOOP_SECRETS_PROMPTER: SecretsPrompter = {
  async promptApiKey(): Promise<string | null> {
    return null
  },
  async promptOauthToken(): Promise<{ access_token: string; expires_at?: number } | null> {
    return null
  },
  async promptOauthClient(): Promise<{ client_id: string; client_secret: string } | null> {
    return null
  },
}

/**
 * `SecretsPrompter` that reads a pre-written secret out of the per-
 * instance `SecretsStore` rather than prompting interactively. Used by
 * `reinstallFailedCore(...)` after the Cores OAuth surface has just
 * persisted the required oauth_token rows: the lifecycle re-runs its
 * usual `driveSecretsInstall` loop, and this prompter returns the
 * already-persisted value verbatim. `persistOrRotate` in
 * `cores/runtime/lifecycle.ts` detects the existing row + rotates with
 * the same plaintext — a no-op write that re-affirms the row + writes
 * an audit `put` entry, which is the documented happy path.
 */
export class SecretsStorePrompter implements SecretsPrompter {
  constructor(
    private readonly opts: {
      secretsStore: SecretsStore
      project_slug: string
    },
  ) {}

  async promptApiKey(): Promise<string | null> {
    // BYO API-key flow is interactive paste; this prompter is OAuth-only.
    return null
  }

  async promptOauthToken(input: {
    kind: 'oauth_token'
    label: string
    scope?: string
    install_prompt: string
    required: boolean
  }): Promise<{ access_token: string; expires_at?: number } | null> {
    const value = await this.opts.secretsStore.get({
      internal_handle: this.opts.project_slug,
      kind: 'oauth_token',
      label: input.label,
    })
    if (value === null) return null
    const rows = await this.opts.secretsStore.list({
      internal_handle: this.opts.project_slug,
      kind: 'oauth_token',
    })
    const row = rows.find((r) => r.label === input.label)
    if (row?.expires_at !== undefined && row.expires_at !== null) {
      return { access_token: value, expires_at: row.expires_at }
    }
    return { access_token: value }
  }

  async promptOauthClient(): Promise<{ client_id: string; client_secret: string } | null> {
    return null
  }
}

/**
 * Re-run the install lifecycle for one Core whose prior `installCore`
 * threw — typically `manifest_invalid` because a required OAuth secret
 * wasn't yet provisioned. The caller MUST have just persisted the
 * required secret (e.g. via the OAuth callback handler) before
 * invoking this entry point; the supplied `prompter` is responsible
 * for surfacing it from the SecretsStore.
 *
 * Idempotent: a slug that's already installed (not in
 * `state.failures`) returns `{ updated: false }`. A slug whose lifecycle
 * still throws bubbles the new error AND updates `state.failures` so
 * the next /api/cores read shows the latest failure code/message.
 *
 * Mutates `state` in place — failures array is rewritten + installed
 * map is updated on success — so the caller's downstream reads see
 * the live shape.
 */
export interface ReinstallFailedCoreInput {
  slug: string
  state: InstallBundledCoresResult
  project_slug: string
  projectDb: ProjectDb
  dataDir: string
  tools: ToolRegistry
  secretsStore: SecretsStore
  prompter: SecretsPrompter
  backends?: CoreBackendFactoryMap
  log?: (event: BundledRegistryEvent | InstallTelemetryEvent) => void
}

export async function reinstallFailedCore(
  input: ReinstallFailedCoreInput,
): Promise<{ updated: boolean }> {
  const log = input.log ?? defaultLog
  const failureIdx = input.state.failures.findIndex((f) => f.core_slug === input.slug)
  if (failureIdx < 0 && input.state.installed.has(input.slug)) {
    return { updated: false }
  }
  const core = input.state.registry.list().find((c) => c.slug === input.slug)
  if (core === undefined) {
    throw new CoreInstallError(
      'unknown_core',
      `reinstallFailedCore: no bundled Core with slug='${input.slug}'`,
      { core_slug: input.slug },
    )
  }

  const installations = new CoreInstallationsStore({ db: input.projectDb })
  // Owner-native author (connect-spec §4.3 layer 3) — see installBundledCores.
  const audit = new SecretAuditLog({ db: input.projectDb, author_id: 'owner' })

  try {
    const result = await installCore({
      project_slug: input.project_slug,
      coreDir: core.coreDir,
      projectDb: input.projectDb,
      dataDir: input.dataDir,
      secretsStore: input.secretsStore,
      audit,
      installations,
      prompter: input.prompter,
    })
    const registerArgs: RegisterCoreToolsInput = {
      core,
      project_slug: input.project_slug,
      projectDb: input.projectDb,
      installation: result,
      audit,
      tools: input.tools,
      log,
    }
    const factory = input.backends?.[core.slug]
    if (factory !== undefined) registerArgs.backendFactory = factory
    await registerCoreTools(registerArgs)
    // Mutate state in place.
    const installed = input.state.installed as Map<string, InstallCoreResult>
    installed.set(core.slug, result)
    const failures = input.state.failures as CoreInstallFailure[]
    const idx = failures.findIndex((f) => f.core_slug === input.slug)
    if (idx >= 0) failures.splice(idx, 1)
    // Persist install_state='install_ok'.
    await updateInstallState(input.projectDb, input.project_slug, input.slug, 'install_ok')
    log({ event_name: 'cores.install_ok', core_slug: core.slug })
    return { updated: true }
  } catch (err) {
    const failure = toInstallFailure(core.slug, err)
    const failures = input.state.failures as CoreInstallFailure[]
    const existingIdx = failures.findIndex((f) => f.core_slug === core.slug)
    if (existingIdx >= 0) {
      failures[existingIdx] = failure
    } else {
      failures.push(failure)
    }
    log({
      event_name: 'cores.install_failed',
      core_slug: failure.core_slug,
      code: failure.code,
      message: failure.message,
    })
    throw err
  }
}

/** Update the post-install `install_state` column. Idempotent. */
export async function updateInstallState(
  db: ProjectDb,
  project_slug: string,
  core_slug: string,
  install_state:
    | 'install_ok'
    | 'install_failed_runtime'
    | 'install_failed_dependency_missing',
): Promise<void> {
  await db.run(
    `UPDATE core_installations
       SET install_state = ?
     WHERE project_slug = ? AND core_slug = ?`,
    [install_state, project_slug, core_slug],
  )
}

function defaultLog(event: BundledRegistryEvent | InstallTelemetryEvent): void {
  if (event.event_name === 'cores.install_failed') {
    const e = event as InstallTelemetryEvent
    console.warn(
      `[cores] install_failed core=${e.core_slug} code=${e.code ?? 'unknown'} message=${e.message ?? ''}`,
    )
    return
  }
  if (event.event_name === 'cores.tool_registration_failed') {
    const e = event as InstallTelemetryEvent
    console.warn(
      `[cores] tool_registration_failed core=${e.core_slug} code=${e.code ?? 'unknown'} message=${e.message ?? ''}`,
    )
    return
  }
  if (event.event_name === 'cores.install_ok') {
    const e = event as InstallTelemetryEvent
    console.log(`[cores] install_ok core=${e.core_slug}`)
    return
  }
  if (event.event_name === 'cores.root_skipped') {
    console.warn(
      `[cores] registry root_skipped rootDir=${event.rootDir} reason=${event.reason}`,
    )
    return
  }
  if (event.event_name === 'cores.duplicate_slug_resolved') {
    console.log(
      `[cores] registry duplicate_slug_resolved slug=${event.slug} winning_root=${event.winning_root} losing_root=${event.losing_root}`,
    )
    return
  }
}

function toInstallFailure(slug: string, err: unknown): CoreInstallFailure {
  if (err instanceof CoreInstallError) {
    return { core_slug: slug, code: err.code, message: err.message }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { core_slug: slug, code: 'unknown', message }
}

/**
 * Re-load the install state for a Core whose `core_installations` row
 * already exists (boot after a prior successful install). Mirrors
 * `installCore`'s post-step-5 shape so downstream code can treat the
 * idempotent re-load identically to a fresh install.
 *
 * Crucially: does NOT re-run `driveSecretsInstall` — every secret the
 * Core declared was already prompted at first install. Re-prompting
 * would force the user to re-paste their OAuth tokens on every gateway
 * restart, which is wrong.
 */
async function rehydrateExistingInstall(input: {
  core: BundledCore
  project_slug: string
  projectDb: ProjectDb
  dataDir: string
  secretsStore: SecretsStore
  audit: SecretAuditLog
  installations: CoreInstallationsStore
}): Promise<InstallCoreResult> {
  const { loadCoreFromDir } = await import('../../cores/runtime/loader.ts')
  const {
    allocateCoreNamespace,
    decideDataLayout,
  } = await import('../../cores/runtime/data-namespace.ts')
  const { buildAuditedSecretsStore } = await import(
    '../../cores/runtime/secret-audit.ts'
  )
  const { buildSecretsAccessor } = await import('@neutronai/cores-sdk')

  const core = loadCoreFromDir(input.core.coreDir)
  const installation = await input.installations.get(input.project_slug, core.slug)
  if (installation === null) {
    throw new CoreInstallError(
      'unknown_core',
      `rehydrate: core=${core.slug} has no live install row`,
      { core_slug: core.slug },
    )
  }
  const { layout } = decideDataLayout(core.manifest.capabilities, core.slug)
  const namespace = allocateCoreNamespace({
    project_slug: input.project_slug,
    slug: core.slug,
    manifest_capabilities: core.manifest.capabilities,
    dataDir: input.dataDir,
    layout,
  })
  const auditedStore = buildAuditedSecretsStore(input.secretsStore, {
    audit: input.audit,
    project_slug: input.project_slug,
    core_slug: core.slug,
  })
  const accessor = buildSecretsAccessor(
    { manifest: core.manifest },
    {
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

interface RegisterCoreToolsInput {
  core: BundledCore
  project_slug: string
  projectDb: ProjectDb
  installation: InstallCoreResult
  audit: SecretAuditLog
  tools: ToolRegistry
  backendFactory?: CoreBackendFactory
  log: (event: InstallTelemetryEvent) => void
}

/**
 * Construct each Core's `buildTools(deps)` output and register the
 * resulting handlers into the production `ToolRegistry` against the
 * manifest's `tools[]` declarations. When the backend factory isn't
 * supplied OR throws, the tool registers with a `not_implemented`
 * stub so the manifest still surfaces in `/api/cores` (and any
 * dispatch fails loudly + structurally).
 */
async function registerCoreTools(input: RegisterCoreToolsInput): Promise<void> {
  const { core, tools } = input
  const manifestToolByName = new Map<string, (typeof core.manifest.tools)[number]>()
  for (const t of core.manifest.tools) manifestToolByName.set(t.name, t)

  // Resolve the Core's barrel via its `package.json#main`. Each
  // bundled Core ships a top-level `index.ts` exporting `buildTools`;
  // we import it lazily so the composer doesn't have to enumerate
  // every Core entry point statically.
  //
  // A Core MAY additionally export `buildExtraTools(deps)` (Research
  // Core S1) — a second factory returning ADDITIONAL handlers beyond
  // the base set. Both factories receive the same `deps` bundle; the
  // results are merged. The split exists so the legacy 3-tool surface
  // (research_start / research_status / research_fetch) stays
  // construction-compatible with older callers while the new 5-tool
  // surface (research_deep / research_list / research_find /
  // research_cite / research_claims_list) ships in `buildExtraTools`.
  // Without invoking BOTH, the manifest declares tools that silently
  // fall through to `not_implemented` stubs (Argus r1 BLOCKER #2).
  let buildTools:
    | ((deps: Record<string, unknown>) => Record<string, ToolHandlerFn>)
    | null = null
  let buildExtraTools:
    | ((deps: Record<string, unknown>) => Record<string, ToolHandlerFn>)
    | null = null
  try {
    const pkgMain = await resolveCoreMain(core.coreDir)
    const mod = (await import(pathToFileURL(pkgMain).href)) as {
      buildTools?: (deps: Record<string, unknown>) => Record<string, ToolHandlerFn>
      buildExtraTools?: (
        deps: Record<string, unknown>,
      ) => Record<string, ToolHandlerFn>
    }
    if (typeof mod.buildTools !== 'function') {
      input.log({
        event_name: 'cores.tool_registration_failed',
        core_slug: core.slug,
        code: 'no_build_tools_export',
        message: `Core ${core.slug} barrel does not export buildTools`,
      })
      registerNotImplementedStubs(tools, core)
      return
    }
    buildTools = mod.buildTools
    if (typeof mod.buildExtraTools === 'function') {
      buildExtraTools = mod.buildExtraTools
    }
  } catch (err) {
    input.log({
      event_name: 'cores.tool_registration_failed',
      core_slug: core.slug,
      code: 'core_module_load_failed',
      message: err instanceof Error ? err.message : String(err),
    })
    registerNotImplementedStubs(tools, core)
    return
  }

  // Build the deps bundle. Three Cores always carry the same triple
  // (manifest, project_slug, audit); the fourth field is the backend
  // and is per-Core (notes.backend, tasks.store, calendar.client...).
  const deps: Record<string, unknown> = {
    manifest: core.manifest,
    project_slug: input.project_slug,
    audit: input.audit,
  }
  if (input.backendFactory !== undefined) {
    try {
      const result = await input.backendFactory({
        core,
        project_slug: input.project_slug,
        projectDb: input.projectDb,
        installation: input.installation,
      })
      Object.assign(deps, normalizeBackend(core.slug, result))
    } catch (err) {
      input.log({
        event_name: 'cores.tool_registration_failed',
        core_slug: core.slug,
        code: 'backend_factory_failed',
        message: err instanceof Error ? err.message : String(err),
      })
      registerNotImplementedStubs(tools, core)
      return
    }
  } else {
    // No backend wired — register the manifest's tool surface with a
    // stub handler so the tool name appears in /api/cores and an MCP
    // dispatch fails cleanly with `not_implemented`. The manifest is
    // still the source of truth for the tool's contract.
    registerNotImplementedStubs(tools, core)
    return
  }

  let built: Record<string, ToolHandlerFn>
  try {
    built = buildTools(deps)
  } catch (err) {
    input.log({
      event_name: 'cores.tool_registration_failed',
      core_slug: core.slug,
      code: 'build_tools_failed',
      message: err instanceof Error ? err.message : String(err),
    })
    registerNotImplementedStubs(tools, core)
    return
  }

  // Merge `buildExtraTools` output if the Core exports it. A failure
  // here doesn't sink the entire registration — the base `built`
  // surface is already valid and the affected tool names fall through
  // to the `not_implemented` stub fill-in below.
  if (buildExtraTools !== null) {
    try {
      const extras = buildExtraTools(deps)
      for (const [name, handler] of Object.entries(extras)) {
        if (Object.prototype.hasOwnProperty.call(built, name)) {
          input.log({
            event_name: 'cores.tool_registration_failed',
            core_slug: core.slug,
            code: 'extra_tool_name_collision',
            message: `Core ${core.slug} buildExtraTools returned tool '${name}' that buildTools also returned; keeping buildTools handler`,
          })
          continue
        }
        built[name] = handler
      }
    } catch (err) {
      input.log({
        event_name: 'cores.tool_registration_failed',
        core_slug: core.slug,
        code: 'build_extra_tools_failed',
        message: err instanceof Error ? err.message : String(err),
      })
      // Continue with the base `built` surface — the missing extras
      // will register as `not_implemented` stubs in the fall-through
      // pass at the bottom of this function.
    }
  }

  // Fill in manifest-declared tools that NEITHER buildTools NOR
  // buildExtraTools provided a handler for. Without this the manifest
  // would silently lie about its surface — the `/api/cores` response
  // would advertise tools that an MCP dispatch fails on with the
  // generic "tool not found" path instead of a structured
  // `not_implemented` error.
  for (const def of core.manifest.tools) {
    if (Object.prototype.hasOwnProperty.call(built, def.name)) continue
    built[def.name] = async (): Promise<unknown> => {
      throw new Error(
        `tool '${def.name}' (core=${core.slug}) declared in manifest but no handler returned by buildTools/buildExtraTools`,
      )
    }
    input.log({
      event_name: 'cores.tool_registration_failed',
      core_slug: core.slug,
      code: 'manifest_tool_unimplemented',
      message: `Core ${core.slug} manifest declares tool '${def.name}' but no handler was returned`,
    })
  }

  for (const [toolName, handler] of Object.entries(built)) {
    const def = manifestToolByName.get(toolName)
    if (def === undefined) {
      // The Core's barrel exposed a handler the manifest doesn't
      // declare. That's an authoring bug; skip + log.
      input.log({
        event_name: 'cores.tool_registration_failed',
        core_slug: core.slug,
        code: 'undeclared_tool_handler',
        message: `Core ${core.slug} buildTools returned tool '${toolName}' that is not declared in manifest.tools[]`,
      })
      continue
    }
    try {
      tools.register({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
        output_schema: def.output_schema,
        // The SDK's CapabilitySchema is permissive (`<verb>:<resource>`
        // pattern) while `core-sdk/types.ts:NeutronCapability` is a
        // closed union covering the canonical platform capabilities.
        // Cores legitimately declare custom strings like
        // `read:notes.db` and `read:calendar_core.events` that pass
        // the SDK regex but aren't in the closed union — the ToolRegistry
        // gates on string equality, not on the union, so the runtime
        // accepts the broader shape. Cast through to satisfy the
        // strict TS surface.
        capability_required: def.capability_required as NeutronCapability,
        approval_policy: DEFAULT_APPROVAL_POLICY,
        handler: wrapHandler(handler),
      })
    } catch (err) {
      // Name collision across Cores is fatal for the colliding tool
      // but not for the gateway — the FIRST-registered Core keeps its
      // tool; the LATER Core's tool is dropped + logged.
      input.log({
        event_name: 'cores.tool_registration_failed',
        core_slug: core.slug,
        code: 'tool_name_conflict',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = 'auto'

type ToolHandlerFn = (args: unknown) => Promise<unknown>

function wrapHandler(fn: ToolHandlerFn): (
  args: unknown,
  _ctx: { project_slug: string; topic_id: string | null; call_id: string; speaker_user_id: string | null },
) => Promise<unknown> {
  return async (args, _ctx) => {
    return fn(args)
  }
}

function registerNotImplementedStubs(tools: ToolRegistry, core: BundledCore): void {
  for (const def of core.manifest.tools) {
    try {
      tools.register({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
        output_schema: def.output_schema,
        capability_required: def.capability_required as NeutronCapability,
        approval_policy: DEFAULT_APPROVAL_POLICY,
        handler: async () => {
          throw new Error(
            `tool '${def.name}' (core=${core.slug}) has no backend wired — register a CoreBackendFactory for slug '${core.slug}'`,
          )
        },
      })
    } catch {
      // Already registered by another Core (name collision). The
      // first-winner rule applies; nothing more to do here.
    }
  }
}

/**
 * Each Core's `ToolDeps` puts the backend under a Core-specific key
 * (notes.backend, tasks.store, calendar.client, ...). The factory
 * may return a flat object that's already shaped correctly, or a
 * single primitive that we map to the canonical key for that slug.
 * Returning `null`/`undefined` from the factory short-circuits to
 * the stub path (caller registers `not_implemented`).
 */
function normalizeBackend(
  slug: string,
  result: unknown,
): Record<string, unknown> {
  if (result === null || result === undefined) return {}
  // If the factory already returned a deps map (object with the
  // Core's expected key like `backend` / `store` / `client`), trust
  // it verbatim.
  if (typeof result === 'object' && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>
    if (
      'backend' in obj ||
      'store' in obj ||
      'client' in obj ||
      'orchestrator' in obj ||
      'summarizer' in obj
    ) {
      return obj
    }
  }
  // Otherwise map the single primitive to the per-slug expected
  // key. Sticky to the slug names so the factory can stay shapeless
  // when there's only one backend dep.
  const key = BACKEND_KEY_BY_SLUG[slug] ?? 'backend'
  return { [key]: result }
}

const BACKEND_KEY_BY_SLUG: Readonly<Record<string, string>> = {
  notes: 'backend',
  tasks_core: 'store',
  reminders_core: 'backend',
  calendar_core: 'client',
  email_managed_core: 'client',
  research_core: 'backend',
  codegen_core: 'orchestrator',
  dtc_analytics: 'store',
  agent_settings: 'backend',
}

async function resolveCoreMain(coreDir: string): Promise<string> {
  const { readFileSync } = await import('node:fs')
  const pkgPath = join(coreDir, 'package.json')
  const raw = readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(raw) as { main?: unknown }
  const main = typeof pkg.main === 'string' && pkg.main.length > 0 ? pkg.main : './index.ts'
  return join(coreDir, main)
}
