/**
 * @neutronai/core-sdk — ONE-RELEASE PATH SHIM.
 *
 * X3 (one manifest contract) collapsed the two manifest validators to a
 * single Zod source, `@neutronai/cores-sdk` (`cores/sdk/manifest.ts`), and
 * folded this package's pure manifest types into it. The 650-line hand
 * validator (`validator.ts`), its JSON-schema mirror (`manifest.schema.json`)
 * and the schema runner had ZERO production callers and were deleted.
 *
 * This module now only RE-EXPORTS the pure manifest types from the single
 * source so existing `@neutronai/core-sdk/types.ts` importers keep resolving
 * during the deprecation window. New code MUST import from
 * `@neutronai/cores-sdk` directly.
 *
 * The re-export is type-only (erased at runtime) and points at the manifest
 * module subpath rather than the barrel, so this leaf pulls in nothing
 * beyond the single Zod schema module it re-types.
 */

export type {
  BillingHookDef,
  BillingModel,
  Capability,
  InstallScope,
  JsonSchemaDocument,
  KnownCapability,
  LinkedSourceDef,
  LinkedSourceKind,
  LinkedSourceScope,
  LinkedSourceTargetKind,
  ManifestSecret,
  ManifestSecretKind,
  NeutronBuild,
  // `NeutronCapability` is the platform-known closed set (aliased to
  // `KnownCapability` at the source). The manifest schema itself validates
  // the OPEN `Capability` string — importers that need the open shape should
  // move to `Capability` from `@neutronai/cores-sdk`.
  NeutronCapability,
  NeutronCompat,
  NeutronManifest,
  TierSupport,
  ToolDef,
  UiComponentDef,
  UiComponentSurface,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from '@neutronai/cores-sdk/manifest'
