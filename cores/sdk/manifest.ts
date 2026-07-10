/**
 * @neutronai/cores-sdk — Core manifest (Zod schema for the `"neutron"` block
 * in a Core's `package.json`).
 *
 * This is the contract first-party Cores (Topline `dtc-analytics`, future
 * Acme/Northwind analytics, etc.) build against BEFORE the full Cores
 * runtime ships in P3 (engineering-plan § B.P3). The shape is deliberately
 * narrow — only what a Core author needs to declare at install time.
 *
 * Cross-refs:
 * - docs/engineering-plan.md § A.3.5 (linked-source pattern)
 * - docs/engineering-plan.md § B.P3 (npm-shape Core authoring lock,
 *   2026-04-25)
 * - docs/engineering-plan.md § D.10.4 (capability-gated `secrets:` block,
 *   2026-05-06)
 *
 * Relationship to `core-sdk/`:
 * - `core-sdk/types.ts` is the prior P0 contract surface — strict literal
 *   capability union + a hand-written validator. It survives as the wire
 *   shape consumed by the (P3) install pipeline; this Zod schema is the
 *   author-facing surface a Core uses when it imports
 *   `@neutronai/cores-sdk` to build/validate its own manifest at boot.
 * - The two MUST stay shape-compatible. The lone difference is the
 *   capability list: `core-sdk` enumerates a fixed union, `cores-sdk`
 *   accepts the broader `<verb>:<resource>`-shaped string the Core author
 *   declares (a Core may declare a third-party connector capability that
 *   the closed enum doesn't yet name — `connect:google-ads`, etc.). The
 *   P3 install pipeline cross-checks against the closed enum and refuses
 *   unknown capabilities. SDK-side we accept the broader shape so a Core
 *   can build green against the SDK while marketplace registration
 *   surfaces the unknown-capability error.
 */

import { z } from 'zod'

/**
 * Capability strings follow the locked `<verb>:<resource>` colon form
 * (engineering-plan § B.P3 DECISION 2026-04-26). Examples:
 *   read:project.db, write:project.db   (shared project DB — the canonical pair)
 *   read:<slug>.db, write:<slug>.db     (a Core's own sidecar DB)
 *   read:gmail, write:gmail
 *   connect:shopify, connect:google-ads, connect:meta-ads
 *   network:external
 *   fs:project_data
 *
 * Validated as a non-empty, lowercase string with at least one colon — this
 * schema checks SHAPE only (a Core may declare its own `<slug>.db` sidecar
 * cap, so the resource side stays open). The closed capability enum lives in
 * `core-sdk/types.ts:NeutronCapability`. Per § 2.3 (ZERO back-compat) the
 * retired pre-§2.3 shared-DB/data-dir aliases were removed from that enum +
 * types; Open ships no manifest declaring them. (Shape validation here does
 * NOT enumerate the retired forms — there is no runtime install-time
 * hard-reject of them; correctness rests on
 * the closed enum + the fact that no legacy manifest exists.)
 */

export const CapabilitySchema = z
  .string()
  .min(1)
  // Lowercase-only — case-insensitive matching used to silently
  // accept `Read:Gmail` here, then fail in core-sdk's exact-string
  // capability check. Drop the /i flag so both validators reject the
  // same casing.
  .regex(/^[a-z][a-z0-9_]*(?:[.-][a-z0-9_]+)*:[a-z][a-z0-9_]*(?:[.-][a-z0-9_.\-/]+)*$/, {
    message: 'capability must match <verb>:<resource> with lowercase identifiers',
  })

export type Capability = z.infer<typeof CapabilitySchema>

/**
 * Known-platform capability set — the closed list of capabilities the
 * PLATFORM itself implements and can gate natively. Folded in from the
 * former `core-sdk/types.ts:NeutronCapability` union +
 * `core-sdk/validator.ts:KNOWN_CAPABILITIES` (X3 — one manifest contract).
 *
 * CRITICAL — this set does NOT restrict what a Core may DECLARE. The
 * manifest `CapabilitySchema` above stays deliberately OPEN: any well-formed
 * `<verb>:<resource>` string validates, so third-party (and first-party
 * sidecar) Cores can declare capabilities the platform doesn't enumerate
 * (`connect:google-ads`, `read:notes.db`, `read:calendar_core.events`, …).
 * Membership here only answers "is this a capability the platform knows how
 * to enforce with a built-in gate?" — the enabler for X1's install-time
 * capability gate. An unknown-but-well-formed capability is STILL a valid
 * declaration and STILL installs; X1's gate treats platform-known vs
 * platform-unknown differently, it does not reject the unknown.
 *
 * Adding a platform capability is a single edit here (the closed enum, the
 * hand validator, and the JSON-schema mirror that used to need parallel
 * edits are all gone — this is the one source).
 */
export const KNOWN_CAPABILITIES = [
  'read:gmail',
  'write:gmail',
  'read:calendar',
  'write:calendar',
  'read:tasks',
  'write:tasks',
  'read:docs',
  'write:docs',
  'read:project_data',
  'write:project_data',
  'read:memory',
  'write:memory',
  'read:project.db',
  'write:project.db',
  'network:external',
  'network:github',
  'network:browse',
  'fs:project_data',
  'fs:cache',
  'host:gh',
  'agent:dispatch_subagent',
  'mcp:tool_register',
] as const

/**
 * A capability the platform implements + gates natively. Every member also
 * satisfies `CapabilitySchema` (the open shape); this is the narrower,
 * platform-known subset X1's gate consults. Formerly
 * `core-sdk/types.ts:NeutronCapability`.
 */
export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number]

/**
 * Back-compat alias for the one-release `@neutronai/core-sdk` path-shim.
 * @deprecated import `KnownCapability` (or the open `Capability`) from
 * `@neutronai/cores-sdk` instead.
 */
export type NeutronCapability = KnownCapability

const KNOWN_CAPABILITY_SET: ReadonlySet<string> = new Set(KNOWN_CAPABILITIES)

/**
 * Is `cap` a platform-known capability (one the platform can enforce with a
 * built-in gate)? Consumed by X1's install-time capability gate. A `false`
 * result does NOT mean the capability is invalid — a well-formed capability
 * outside this set is a legitimate third-party/sidecar declaration that
 * still validates + installs; it simply has no native platform gate.
 */
export function isKnownCapability(cap: string): cap is KnownCapability {
  return KNOWN_CAPABILITY_SET.has(cap)
}

/**
 * Substrate tier a Core declares it supports.
 * `regular` = managed substrate (Claude / GPT-5).
 * `private` = on-demand H100 confidential computing with open-weight model.
 * `both` = the Core ships parallel code paths and works on either.
 *
 * Mirrors `core-sdk/types.ts:TierSupport`; both schemas accept the
 * same enum so a Core's manifest passes both validators.
 */
export const TierSupportSchema = z.enum(['regular', 'private', 'both'])
export type TierSupport = z.infer<typeof TierSupportSchema>

/**
 * WAVE 3 PR-2 — which install SCOPES a Core supports. `project` = installs
 * into one project (the `core_installations` path, the historical default).
 * `global` = installs into the global app shell + every project (the new
 * `core_global_installations` path). A manifest may declare both. The field
 * is OPTIONAL on the manifest; an omitted value means project-only
 * (`['project']`), so every pre-WAVE-3 Core keeps installing exactly as
 * before. The install lifecycle gates global installs on this list.
 *
 * Mirrors `core-sdk/types.ts:InstallScope`.
 */
export const InstallScopeSchema = z.enum(['project', 'global'])
export type InstallScope = z.infer<typeof InstallScopeSchema>

/**
 * A JSON Schema document. Loose at the SDK layer; downstream tooling
 * validates the body when the Core actually registers tools at runtime.
 */
export const JsonSchemaDocumentSchema = z.record(z.string(), z.unknown())
export type JsonSchemaDocument = z.infer<typeof JsonSchemaDocumentSchema>

export const ToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  input_schema: JsonSchemaDocumentSchema,
  output_schema: JsonSchemaDocumentSchema,
  /** Capability the runtime checks against the manifest before dispatch. */
  capability_required: CapabilitySchema,
})
export type ToolDef = z.infer<typeof ToolDefSchema>

/**
 * Where a UI component renders. `route_mount` is the new shape for first-
 * party Cores that ship a full admin UI (mounted under
 * `/<core>/admin/...`); the legacy enum surfaces (`launcher_icon`,
 * `project_tab`, `settings_panel`) remain for parity with `core-sdk` and
 * land when the launcher / per-project tab UI ships in P5+.
 *
 * `app_tab` is the Tasks Core Tier 1 (S1) addition — a Core declares an
 * Expo Router app-tab destination its launcher tile resolves to. The
 * `props_schema` carries the tab metadata (`path`, `label`, `emoji`,
 * `order`) the P5.3 launcher consumes when rendering the tile + handling
 * the long-press menu. The Core does NOT own HTTP routes for the tab;
 * the path points at an existing gateway surface (e.g. P5.4
 * `/api/app/projects/<id>/tasks`).
 */
export const UiComponentSurfaceSchema = z.enum([
  'launcher_icon',
  'project_tab',
  'settings_panel',
  'route_mount',
  // Notes Core S1 (2026-05-20) — `app_tab` surfaces a Core's in-app
  // tab under the per-project view shell at the canonical
  // `/projects/<project_id>/<core_slug>` Expo Router path. P5.3
  // launcher tiles whose `primary_action='open_app_tab'` navigate to
  // this surface; the gateway mounts the HTTP surface (drawer browser
  // etc.) on the same path via the runtime composer.
  'app_tab',
])
export type UiComponentSurface = z.infer<typeof UiComponentSurfaceSchema>

/**
 * Absolute URL prefix without a trailing slash. `mountCoreRoutes`
 * passes this verbatim to Hono `app.use(...)` — relative or trailing-
 * slashed paths would silently fail to gate the intended subtree, so
 * we lock the format here.
 */
const MOUNT_PATH_RE = /^\/([a-zA-Z0-9_\-]+)(\/[a-zA-Z0-9_\-]+)*$/

export const UiComponentDefSchema = z.object({
  name: z.string().min(1),
  /** Module-relative entry path the runtime imports for this surface. */
  entry_point: z.string().min(1),
  surface: UiComponentSurfaceSchema,
  /**
   * For `route_mount` surfaces: the URL prefix under which the Core's
   * admin UI mounts. Must be absolute (leading `/`), no trailing
   * slash, no whitespace. `/admin` is the convention; nested paths
   * like `/admin/settings` work too. Required when
   * `surface === 'route_mount'`; ignored otherwise.
   */
  mount_path: z.string().regex(MOUNT_PATH_RE, {
    message: 'mount_path must be absolute (leading /), no trailing slash',
  }).optional(),
  props_schema: JsonSchemaDocumentSchema.optional(),
})
export type UiComponentDef = z.infer<typeof UiComponentDefSchema>

/**
 * Billing-hook declaration. v1 ships an empty array — billing
 * actually wires up in P3+ when the Cores marketplace adds usage-
 * based billing. Shape mirrors `core-sdk/types.ts:BillingHookDef`
 * so a manifest that parses through this schema also passes
 * `validateNeutronManifest()` on the install pipeline.
 */
export const BillingModelSchema = z.enum([
  'flat_monthly',
  'usage_metered',
  'one_time',
])
export type BillingModel = z.infer<typeof BillingModelSchema>

export const BillingHookDefSchema = z.object({
  model: BillingModelSchema,
  /** Smallest currency unit (e.g. cents for USD). */
  price_cents: z.number(),
  /** ISO 4217. */
  currency: z.string().min(1),
  on_install: z.string().min(1).optional(),
  on_uninstall: z.string().min(1).optional(),
})
export type BillingHookDef = z.infer<typeof BillingHookDefSchema>
/** @deprecated alias retained for sprint-24 callers; use BillingHookDef. */
export const BillingMeterSchema = BillingHookDefSchema
export type BillingMeter = BillingHookDef

/**
 * Third-party data source this Core integrates with. Mirrors
 * `core-sdk/types.ts:LinkedSourceDef` so a manifest passes both
 * validators.
 *
 * `kind` is a free-form string per § A.3.5 — Topline's `dtc-analytics`
 * declares `shopify`, `google-ads`, `meta-ads`, `amazon-ads`, etc.
 * `core-sdk`'s closed `LinkedSourceKind` enum is informational only
 * (used by built-in Cores like `gmail`); the validator accepts any
 * non-empty string so first-party Cores can integrate with novel
 * providers.
 *
 * `scope` and `target_kinds[]` are required per the install-pipeline
 * lock — a Core must declare what it reads/writes and which owner
 * kinds it links from. `target_kinds: []` is allowed (warning-only —
 * the Core opts out of cross-project linking at install time).
 */
/**
 * Cross-project linked-source kind. Open string (folded from
 * `core-sdk/types.ts:LinkedSourceKind`) — a Core declares any provider it
 * integrates with (`shopify`, `google-ads`, `meta-ads`, …); the schema
 * accepts any non-empty string. `KNOWN_LINKED_SOURCE_KINDS` (marketplace
 * display) is intentionally NOT enforced here.
 */
export type LinkedSourceKind = string

export const LinkedSourceScopeSchema = z.enum(['read', 'read_write'])
export type LinkedSourceScope = z.infer<typeof LinkedSourceScopeSchema>

export const LinkedSourceTargetKindSchema = z.enum(['user', 'workspace'])
export type LinkedSourceTargetKind = z.infer<
  typeof LinkedSourceTargetKindSchema
>

export const LinkedSourceDefSchema = z.object({
  kind: z.string().min(1),
  scope: LinkedSourceScopeSchema,
  target_kinds: z.array(LinkedSourceTargetKindSchema),
  description: z.string().min(1).optional(),
})
export type LinkedSourceDef = z.infer<typeof LinkedSourceDefSchema>

/**
 * Per § D.10.4 — capability-gated secrets. A Core declares every secret
 * it intends to read; `SecretsAccessor.get(...)` enforces that the
 * calling Core's manifest actually declared the request.
 *
 * Fields:
 * - `name`     — stable identifier the Core uses to look this up
 *                (`stripe_api_key`, `gmail_oauth`, etc.).
 * - `kind`     — `byo_api_key` for paste-flow tokens, `oauth_token`
 *                for OAuth-issued bearer tokens, `oauth_client` for
 *                the OAuth app's client_id+secret pair (Open tier),
 *                `webhook_secret` for inbound-webhook HMAC keys.
 * - `label`    — provider label (`stripe`, `google`, `shopify`).
 * - `scope`    — optional space-delimited OAuth scope or BYOK scope
 *                tag (informational; the platform doesn't parse it
 *                v1 — kept for marketplace display + audit).
 * - `required` — `true` blocks Core install when missing; `false` lets
 *                the Core install but feature-gate the dependent
 *                surfaces.
 * - `install_prompt` — UX copy the onboarding flow shows when asking
 *                the user to provide the secret.
 */
export const ManifestSecretKindSchema = z.enum([
  'byo_api_key',
  'oauth_token',
  'oauth_client',
  'webhook_secret',
])
export type ManifestSecretKind = z.infer<typeof ManifestSecretKindSchema>

export const ManifestSecretSchema = z.object({
  name: z.string().min(1),
  kind: ManifestSecretKindSchema,
  label: z.string().min(1),
  scope: z.string().min(1).optional(),
  required: z.boolean(),
  install_prompt: z.string().min(1),
})
export type ManifestSecret = z.infer<typeof ManifestSecretSchema>

/**
 * Compat / build version metadata. Mirrors `core-sdk/types.ts:NeutronCompat`
 * + `NeutronBuild` so the install-pipeline + marketplace contract holds
 * across both manifest validators. `coreApi` is a semver range matched
 * against the host's Core SDK version at install time; `neutronVersion`
 * names the Neutron host version this Core was built against.
 */
export const NeutronCompatSchema = z.object({
  coreApi: z.string().min(1, { message: 'compat.coreApi semver range required' }),
})
export type NeutronCompat = z.infer<typeof NeutronCompatSchema>

export const NeutronBuildSchema = z.object({
  neutronVersion: z
    .string()
    .min(1, { message: 'build.neutronVersion required' }),
})
export type NeutronBuild = z.infer<typeof NeutronBuildSchema>

/**
 * The full Core manifest body — the value of the `"neutron"` field in
 * a Core's `package.json`. Array fields are required-but-may-be-empty
 * so that an absent declaration is intentional rather than accidental.
 *
 * `compat` + `build` are required to keep this schema shape-compatible
 * with the install-time validator in `core-sdk/validator.ts` — a
 * manifest that parses through `@neutronai/cores-sdk` MUST also pass
 * `validateNeutronManifest()` on the same input.
 *
 * The cross-field `route_mount` ⇒ `mount_path` invariant lives on the
 * schema itself via `superRefine`, so callers who use
 * `NeutronManifestSchema.parse`/`safeParse` directly get the same
 * enforcement as `parseManifest`/`safeParseManifest`.
 */
export const NeutronManifestSchema = z
  .object({
    capabilities: z.array(CapabilitySchema),
    tier_support: z.array(TierSupportSchema).min(1, {
      message: 'tier_support must declare at least one tier',
    }),
    /**
     * WAVE 3 PR-2 — install scopes the Core supports. Optional; omitted ⇒
     * project-only. A non-empty list when present (an empty array would
     * mean "installable nowhere", which is a packaging mistake).
     */
    install_scopes: z.array(InstallScopeSchema).min(1, {
      message: 'install_scopes, when present, must declare at least one scope',
    }).optional(),
    tools: z.array(ToolDefSchema),
    ui_components: z.array(UiComponentDefSchema),
    billing_hooks: z.array(BillingMeterSchema),
    linked_sources: z.array(LinkedSourceDefSchema),
    secrets: z.array(ManifestSecretSchema),
    compat: NeutronCompatSchema,
    build: NeutronBuildSchema,
  })
  .superRefine((data, ctx) => {
    for (const [i, comp] of data.ui_components.entries()) {
      if (comp.surface === 'route_mount' && comp.mount_path === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ui_components', i, 'mount_path'],
          message:
            'mount_path is required when ui_components[].surface is route_mount',
        })
      }
    }
  })
export type NeutronManifest = z.infer<typeof NeutronManifestSchema>

/**
 * Parse-and-validate a candidate manifest (typically `pkg.neutron` from
 * a Core's `package.json`). Throws a `z.ZodError` on invalid input.
 * Enforces every shape rule including the cross-field `route_mount` ⇒
 * `mount_path` invariant (which now lives on the schema itself, so
 * `NeutronManifestSchema.parse(input)` is equivalent).
 */
export function parseManifest(input: unknown): NeutronManifest {
  return NeutronManifestSchema.parse(input)
}

/**
 * Non-throwing variant — returns `{ success, data | error }` matching
 * Zod's `safeParse` shape. Cores that want to surface validation errors
 * to the user (e.g. dev-mode boot diagnostics) prefer this.
 */
export function safeParseManifest(
  input: unknown,
):
  | { success: true; data: NeutronManifest }
  | { success: false; error: z.ZodError } {
  return NeutronManifestSchema.safeParse(input)
}
