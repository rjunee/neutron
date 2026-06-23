/**
 * @neutronai/core-sdk — Core manifest type contracts.
 *
 * Shape of the `"neutron"` section in a Core's `package.json` per the locked
 * Core authoring decision (engineering-plan § B.P3 + § A.3.5). The types here
 * are the exclusive source of truth for what a valid Core manifest looks like
 * — the runtime Core dispatcher (P1), substrate router (P1), install pipeline
 * (P3), and Cores marketplace (P3+) all read against these types.
 *
 * Cross-refs:
 * - docs/engineering-plan.md § A.3.5 (linked-source pattern)
 * - docs/engineering-plan.md § B.P3 (npm-shape Core authoring lock)
 * - docs/plans/P0-system-user-data-separation.md § 1.6 (Core SDK contract)
 *
 * Lift target: OpenClaw `packages/plugin-package-contract/src/index.ts`
 * (renamed `openclaw.compat.pluginApi` → `neutron.compat.coreApi`,
 * `openclaw.build.openclawVersion` → `neutron.build.neutronVersion`).
 */

/**
 * Substrate tier a Core declares it supports. `regular` = Claude / GPT-5
 * (managed substrate); `private` = on-demand H100 Confidential Computing
 * with an open-weight model (per § B.P4); `both` = the Core ships parallel
 * code paths and works on either.
 */
export type TierSupport = 'regular' | 'private' | 'both'

/**
 * WAVE 3 PR-2 — install SCOPE a Core supports. `project` installs into one
 * project; `global` installs into the global app shell + every project. A
 * manifest's `install_scopes` field (optional; defaults to project-only)
 * lists the scopes it permits. Mirrors `cores/sdk/manifest.ts:InstallScope`.
 */
export type InstallScope = 'project' | 'global'

/**
 * Cross-project linked-source kind. Per § A.3.5, a Core can opt-in to
 * read/write data from a workspace instance other than the owner's own
 * instance — gated by the linked-source consent record on both sides.
 *
 * Sprint 24 widened this from a closed enum to an open string so
 * first-party Cores (Topline `dtc-analytics` declaring `shopify`,
 * `google-ads`, `meta-ads`, etc.) work today without requiring a
 * marketplace-edit per new third-party. The closed enum is preserved
 * as `KNOWN_LINKED_SOURCE_KINDS` for marketplace display + warning
 * surfaces — `kind` values outside the known set still validate.
 */
export type LinkedSourceKind = string

export type LinkedSourceScope = 'read' | 'read_write'

export type LinkedSourceTargetKind = 'user' | 'workspace'

export interface LinkedSourceDef {
  kind: LinkedSourceKind
  scope: LinkedSourceScope
  /**
   * Target kinds the Core is willing to link from. Empty array means the
   * Core opts out of this linked source at install time (warning, not
   * error — the Core is still installable, just won't surface the link).
   */
  target_kinds: LinkedSourceTargetKind[]
}

export type BillingModel = 'flat_monthly' | 'usage_metered' | 'one_time'

export interface BillingHookDef {
  model: BillingModel
  /** Price in the smallest currency unit (e.g. cents for USD). */
  price_cents: number
  /** ISO 4217 currency code. */
  currency: string
  /** Optional install-time hook entry-point name. */
  on_install?: string
  /** Optional uninstall-time hook entry-point name. */
  on_uninstall?: string
}

export type UiComponentSurface =
  | 'launcher_icon'
  | 'project_tab'
  | 'settings_panel'
  // Sprint 24: Cores that ship a full admin UI (Topline `dtc-analytics`)
  // mount it at `<route_mount.mount_path>/*`. The `cores/sdk/route.ts`
  // helper resolves the mount from this surface kind. The runtime
  // surface MUST set `mount_path` when surface is `route_mount` —
  // enforced by both validators.
  | 'route_mount'
  // Notes Core S1 (2026-05-20) — `app_tab` surfaces a Core's in-app
  // tab under the per-project view shell at the canonical
  // `/projects/<project_id>/<core_slug>` Expo Router path. P5.3
  // launcher tiles whose `primary_action='open_app_tab'` navigate to
  // this surface.
  | 'app_tab'

/** A JSON Schema document (kept loose at the SDK layer; downstream tooling validates). */
export type JsonSchemaDocument = Record<string, unknown>

export interface UiComponentDef {
  name: string
  /** Module-relative entry path the runtime imports for this surface. */
  entry_point: string
  surface: UiComponentSurface
  /**
   * URL prefix for `route_mount` surfaces (e.g. `/admin`). Required
   * when `surface === 'route_mount'`; ignored otherwise.
   */
  mount_path?: string
  props_schema?: JsonSchemaDocument
}

export interface ToolDef {
  name: string
  description: string
  input_schema: JsonSchemaDocument
  output_schema: JsonSchemaDocument
  /** The Core capability this tool exercises. Runtime gates accordingly. */
  capability_required: NeutronCapability
}

/**
 * Exhaustive list of capability strings a Core can declare. Format is
 * `<verb>:<resource>`. Adding a new capability is a 4-step edit:
 *
 *   1. Append the literal to this union.
 *   2. Append the same literal to KNOWN_CAPABILITIES in validator.ts.
 *   3. Append the same literal to the `enum` in manifest.schema.json.
 *   4. Add coverage in validator.test.ts.
 *
 * The runtime Core dispatcher reads `capability_required` on each tool and
 * fails closed when a Core invokes a capability not declared in its manifest.
 *
 * OSS-split C4-a (§ 2.3 rename map, SD1): the shared-DB + data-dir
 * capabilities use project vocabulary — `read:project.db`/`write:project.db`
 * for the shared DB and `fs:project_data` for the data dir. These are the
 * only accepted forms; manifests declare them directly and the runtime gate
 * (`cores/runtime/data-namespace.ts`) enforces them.
 */
export type NeutronCapability =
  | 'read:gmail'
  | 'write:gmail'
  | 'read:calendar'
  | 'write:calendar'
  | 'read:tasks'
  | 'write:tasks'
  | 'read:docs'
  | 'write:docs'
  | 'read:project_data'
  | 'write:project_data'
  | 'read:memory'
  | 'write:memory'
  | 'read:project.db'
  | 'write:project.db'
  | 'network:external'
  | 'network:github'
  | 'network:browse'
  | 'fs:project_data'
  | 'fs:cache'
  | 'host:gh'
  | 'agent:dispatch_subagent'
  | 'mcp:tool_register'

export interface NeutronCompat {
  /** Semver range against which the host's Core SDK version is matched. */
  coreApi: string
}

export interface NeutronBuild {
  /** The Neutron host version this Core was built and tested against. */
  neutronVersion: string
}

/**
 * Capability-gated secret declaration per engineering-plan § D.10.4.
 * A Core declares every secret it intends to read; the runtime
 * `SecretsAccessor` enforces that the requested `(kind, label)` is
 * in this list before plaintext is returned. Mirrors
 * `cores/sdk/manifest.ts:ManifestSecret`.
 */
export type ManifestSecretKind =
  | 'byo_api_key'
  | 'oauth_token'
  | 'oauth_client'
  | 'webhook_secret'

export interface ManifestSecret {
  name: string
  kind: ManifestSecretKind
  label: string
  scope?: string
  required: boolean
  install_prompt: string
}

/**
 * The full Core manifest. Maps 1:1 to the `"neutron"` section of a Core's
 * `package.json`. Every Core ships exactly one of these.
 *
 * Array fields (`capabilities`, `tier_support`, `tools`, `ui_components`,
 * `billing_hooks`, `linked_sources`, `secrets`) are required-but-may-be-
 * empty. A Core with no linked sources declares `"linked_sources": []`
 * explicitly so the absence is intentional rather than accidentally
 * omitted.
 */
export interface NeutronManifest {
  capabilities: NeutronCapability[]
  tier_support: TierSupport[]
  /**
   * WAVE 3 PR-2 — install scopes the Core supports. Optional; when omitted
   * the Core is project-only (`['project']`). Present values must be a
   * non-empty subset of {`project`, `global`}.
   */
  install_scopes?: InstallScope[]
  tools: ToolDef[]
  ui_components: UiComponentDef[]
  billing_hooks: BillingHookDef[]
  linked_sources: LinkedSourceDef[]
  secrets: ManifestSecret[]
  compat: NeutronCompat
  build: NeutronBuild
}

export interface ValidationError {
  code: string
  /** JSON-Pointer-ish path into the manifest, e.g. `/capabilities/2`. */
  path: string
  message: string
}

export interface ValidationWarning {
  code: string
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
}
