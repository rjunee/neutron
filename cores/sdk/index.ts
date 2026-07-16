/**
 * @neutronai/cores-sdk — public barrel.
 *
 * Stable contract first-party Cores (the reference `dtc-analytics`
 * Core, future Acme/Northwind analytics, etc.) build against BEFORE the full
 * Cores runtime ships in P3. Everything exported here is a stable
 * v1 surface; the runtime swap-in happens in P3 with no caller-side
 * code changes (the dev-mode stubs are replaced with platform-backed
 * implementations behind the same APIs).
 *
 * See `cores/sdk/SDK-CONTRACT.md` for the full design spec, the
 * dev-stub-vs-prod migration shape, and the "how to write a first-
 * party Core" walkthrough.
 */

export const __MODULE__ = '@neutronai/cores-sdk' as const

// Manifest
export {
  BillingHookDefSchema,
  BillingMeterSchema,
  BillingModelSchema,
  CapabilitySchema,
  ERROR_CODES,
  WARNING_CODES,
  KNOWN_CAPABILITIES,
  KNOWN_BILLING_MODELS,
  KNOWN_INSTALL_SCOPES,
  KNOWN_LINKED_SOURCE_KINDS,
  KNOWN_LINKED_SOURCE_SCOPES,
  KNOWN_LINKED_SOURCE_TARGET_KINDS,
  KNOWN_MANIFEST_SECRET_KINDS,
  KNOWN_TIER_SUPPORTS,
  KNOWN_UI_SURFACES,
  isKnownCapability,
  isValidSemverRange,
  validateNeutronManifest,
  JsonSchemaDocumentSchema,
  LinkedSourceDefSchema,
  LinkedSourceScopeSchema,
  LinkedSourceTargetKindSchema,
  ManifestSecretKindSchema,
  ManifestSecretSchema,
  InstallScopeSchema,
  NeutronBuildSchema,
  NeutronCompatSchema,
  NeutronManifestSchema,
  TierSupportSchema,
  ToolDefSchema,
  UiComponentDefSchema,
  UiComponentSurfaceSchema,
  parseManifest,
  safeParseManifest,
  type BillingHookDef,
  type BillingMeter,
  type BillingModel,
  type Capability,
  type InstallScope,
  type JsonSchemaDocument,
  type KnownCapability,
  type LinkedSourceDef,
  type LinkedSourceKind,
  type LinkedSourceScope,
  type LinkedSourceTargetKind,
  type ManifestSecret,
  type ManifestSecretKind,
  type NeutronBuild,
  type NeutronCapability,
  type NeutronCompat,
  type NeutronManifest,
  type ValidationError,
  type ValidationResult,
  type ValidationWarning,
  type TierSupport,
  type ToolDef,
  type UiComponentDef,
  type UiComponentSurface,
} from './manifest.ts'

// Typed Core module contract (X2)
export {
  defineCore,
  isCoreModule,
  type CoreModule,
  type CoreToolFactory,
  type CoreToolHandler,
  type DefineCoreInput,
  type ToolCallContext,
} from './define-core.ts'

// Connector
export type {
  Connector,
  ConnectorRow,
  ConnectorTestResult,
  CursorState,
  WatermarkState,
} from './connector.ts'

// Auth
export {
  JwksCache,
  PlatformJwtError,
  buildDevPlatformJwtValidator,
  buildPlatformJwtValidator,
  validatePlatformJwt,
  type BuildPlatformJwtValidatorOptions,
  type DevPlatformJwtValidatorOptions,
  type FetchLike,
  type JwksCacheEntry,
  type JwksCacheOptions,
  type PlatformAuthResult,
  type PlatformClaims,
  type PlatformJwtErrorCode,
  type PlatformJwtValidator,
  type PlatformMembership,
  type ValidatePlatformJwtOptions,
} from './auth.ts'

// Errors (X4 — single unified CapabilityDeniedError, shared with cores/runtime)
export {
  CapabilityDeniedError,
  type CapabilityDeniedCode,
  type CapabilityDeniedErrorInit,
} from './errors.ts'

// Secrets
export {
  buildDevSecretsAccessor,
  buildSecretsAccessor,
  type BuildDevSecretsAccessorOptions,
  type BuildSecretsAccessorOptions,
  type ManifestSecretsInput,
  type PlatformSecretsStore,
  type PlatformSecretsStoreListItem,
  type SecretKind,
  type SecretsAccessor,
  type SecretsAccessorErrorCode,
} from './secrets.ts'

// Route
export {
  apiHandler,
  mountCoreRoutes,
  type ApiHandlerOptions,
  type CoreRouteAuth,
  type HonoApp,
  type MountCoreRoutesOptions,
} from './route.ts'

// Reconcile
export {
  DEFAULT_RECONCILIATION_THRESHOLD,
  ReconciliationError,
  runReconciliation,
  type ReconciliationFailure,
  type ReconciliationGuard,
  type ReconciliationOutcome,
} from './reconcile.ts'
