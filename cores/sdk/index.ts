/**
 * @neutronai/cores-sdk — public barrel.
 *
 * Stable contract first-party Cores (Topline `dtc-analytics`, future
 * Acme/Northwind analytics, etc.) build against BEFORE the full
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
  JsonSchemaDocumentSchema,
  LinkedSourceDefSchema,
  LinkedSourceScopeSchema,
  LinkedSourceTargetKindSchema,
  ManifestSecretKindSchema,
  ManifestSecretSchema,
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
  type JsonSchemaDocument,
  type LinkedSourceDef,
  type LinkedSourceScope,
  type LinkedSourceTargetKind,
  type ManifestSecret,
  type ManifestSecretKind,
  type NeutronBuild,
  type NeutronCompat,
  type NeutronManifest,
  type TierSupport,
  type ToolDef,
  type UiComponentDef,
  type UiComponentSurface,
} from './manifest.ts'

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

// Secrets
export {
  CapabilityDeniedError,
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
