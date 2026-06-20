/**
 * Structural validator stub for the Neutron Core manifest.
 *
 * Stub-level checks ONLY — the full validator body lands in P3 when Cores
 * actually install. Today the dispatcher (P1) and the install pipeline (P3)
 * both depend on the *shape* being locked, hence Sprint 2B ships this
 * contract surface up front so neither downstream consumer drifts.
 *
 * Cross-refs:
 * - docs/engineering-plan.md § A.3.5 (linked-source pattern)
 * - docs/engineering-plan.md § B.P3 (npm-shape Core authoring lock)
 * - docs/plans/P0-system-user-data-separation.md § 1.6 (Core SDK contract)
 */

import type {
  LinkedSourceDef,
  NeutronCapability,
  NeutronManifest,
  TierSupport,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from './types.ts'

export const KNOWN_CAPABILITIES: ReadonlyArray<NeutronCapability> = [
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

export const KNOWN_TIER_SUPPORTS: ReadonlyArray<TierSupport> = [
  'regular',
  'private',
  'both',
] as const

export const KNOWN_LINKED_SOURCE_KINDS = [
  'gmail',
  'calendar',
  'tasks',
  'docs',
  'memory',
  'custom',
] as const

export const KNOWN_LINKED_SOURCE_SCOPES = ['read', 'read_write'] as const

export const KNOWN_LINKED_SOURCE_TARGET_KINDS = ['user', 'workspace'] as const

export const KNOWN_BILLING_MODELS = ['flat_monthly', 'usage_metered', 'one_time'] as const

export const KNOWN_UI_SURFACES = [
  'launcher_icon',
  'project_tab',
  'settings_panel',
  'route_mount',
  // Notes Core S1 (2026-05-20) — see UiComponentSurface in types.ts.
  'app_tab',
] as const

export const KNOWN_MANIFEST_SECRET_KINDS = [
  'byo_api_key',
  'oauth_token',
  'oauth_client',
  'webhook_secret',
] as const

export const ERROR_CODES = {
  REQUIRED_MISSING: 'E_REQUIRED_MISSING',
  TYPE_MISMATCH: 'E_TYPE_MISMATCH',
  UNKNOWN_CAPABILITY: 'E_UNKNOWN_CAPABILITY',
  INVALID_SEMVER: 'E_INVALID_SEMVER',
  INVALID_TIER_SUPPORT: 'E_INVALID_TIER_SUPPORT',
  INVALID_LINKED_SOURCE: 'E_INVALID_LINKED_SOURCE',
} as const

export const WARNING_CODES = {
  EMPTY_TARGET_KINDS: 'W_EMPTY_TARGET_KINDS',
} as const

const SEMVER_TERM_RE = /^([\^~]|>=?|<=?|=)?\d+(\.\d+){0,2}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/**
 * Conservative semver-range syntax check. Canonical npm-style grammar:
 *   - bare wildcard (`*`)
 *   - single term (`1.2.3`, `^1.2.3`, `>=1.2.3-rc.1`)
 *   - space-joined intersections (`>=1 <2`, `>= 1.0.0 <2.0.0` — npm allows whitespace
 *     between the comparator and the version)
 *   - `||`-joined unions (`^1.0.0 || ^2.0.0`)
 *
 * Mirrors the `pattern` on `compat.coreApi` in `manifest.schema.json`. When you change
 * one, change the other — the validator.test.ts round-trip parity suite will fail
 * loudly otherwise.
 *
 * Stub-level — full satisfies() resolution against a host version lands in P3
 * alongside the install pipeline.
 */
export function isValidSemverRange(input: unknown): boolean {
  if (typeof input !== 'string') return false
  const trimmed = input.trim()
  if (trimmed === '') return false
  // npm tolerates whitespace between the comparator and the version (e.g. `>= 1.0.0`).
  // Collapse it before splitting into terms so the existing per-term regex stays simple.
  // Lookahead requires a digit immediately after the whitespace so split comparators like
  // `> =1.0.0` or `< = 2.0.0` (which the JSON-Schema mirror also rejects) stay split and the
  // per-term regex rejects them.
  const normalized = trimmed.replace(/([\^~]|>=?|<=?|=)\s+(?=\d)/g, '$1')
  for (const orClause of normalized.split(/\s*\|\|\s*/)) {
    const clause = orClause.trim()
    if (clause === '') return false
    // `*` is a valid clause anywhere in a union (`*`, `* || ^1.0.0`, `^1.0.0 || *`).
    if (clause === '*') continue
    const terms = clause.split(/\s+/).filter((t) => t !== '')
    if (terms.length === 0) return false
    for (const term of terms) {
      if (!SEMVER_TERM_RE.test(term)) return false
    }
  }
  return true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function err(code: string, path: string, message: string): ValidationError {
  return { code, path, message }
}

function warn(code: string, path: string, message: string): ValidationWarning {
  return { code, path, message }
}

/**
 * Validate the parsed `"neutron"` section of a Core's `package.json`.
 *
 * Returns a discriminated `ValidationResult` rather than throwing — callers
 * (P1 substrate router, P3 install pipeline, CI tooling) decide their own
 * fail-closed policy. `valid` is `true` iff `errors.length === 0`; warnings
 * never flip the verdict.
 */
export function validateNeutronManifest(input: unknown): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!isPlainObject(input)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '', 'manifest must be a plain object'))
    return { valid: false, errors, warnings }
  }

  validateCapabilities(input['capabilities'], errors)
  validateTierSupport(input['tier_support'], errors)
  validateTools(input['tools'], errors)
  validateUiComponents(input['ui_components'], errors)
  validateBillingHooks(input['billing_hooks'], errors)
  validateLinkedSources(input['linked_sources'], errors, warnings)
  validateSecrets(input['secrets'], errors)
  validateCompat(input['compat'], errors)
  validateBuild(input['build'], errors)

  return { valid: errors.length === 0, errors, warnings }
}

function validateCapabilities(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/capabilities', 'required field is missing'))
    return
  }
  if (!Array.isArray(value)) {
    errors.push(
      err(ERROR_CODES.TYPE_MISMATCH, '/capabilities', 'must be an array of capability strings'),
    )
    return
  }
  const known = new Set<string>(KNOWN_CAPABILITIES)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    const path = `/capabilities/${i}`
    if (typeof item !== 'string') {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be a string'))
      continue
    }
    if (!known.has(item)) {
      errors.push(
        err(
          ERROR_CODES.UNKNOWN_CAPABILITY,
          path,
          `unknown capability ${JSON.stringify(item)} (must be one of: ${KNOWN_CAPABILITIES.join(', ')})`,
        ),
      )
    }
  }
}

function validateTierSupport(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/tier_support', 'required field is missing'))
    return
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/tier_support', 'must be a non-empty array'))
    return
  }
  const known = new Set<string>(KNOWN_TIER_SUPPORTS)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    const path = `/tier_support/${i}`
    if (typeof item !== 'string' || !known.has(item)) {
      errors.push(
        err(
          ERROR_CODES.INVALID_TIER_SUPPORT,
          path,
          `must be one of: ${KNOWN_TIER_SUPPORTS.join(', ')}`,
        ),
      )
    }
  }
}

function validateTools(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/tools', 'required field is missing'))
    return
  }
  if (!Array.isArray(value)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/tools', 'must be an array'))
    return
  }
  const knownCaps = new Set<string>(KNOWN_CAPABILITIES)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    const path = `/tools/${i}`
    if (!isPlainObject(item)) {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be an object'))
      continue
    }
    requireString(item, 'name', `${path}/name`, errors)
    requireString(item, 'description', `${path}/description`, errors)
    requireObject(item, 'input_schema', `${path}/input_schema`, errors)
    requireObject(item, 'output_schema', `${path}/output_schema`, errors)
    const cap = item['capability_required']
    const capPath = `${path}/capability_required`
    if (typeof cap !== 'string') {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, capPath, 'must be a string'))
    } else if (!knownCaps.has(cap)) {
      errors.push(
        err(ERROR_CODES.UNKNOWN_CAPABILITY, capPath, `unknown capability ${JSON.stringify(cap)}`),
      )
    }
  }
}

function validateUiComponents(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/ui_components', 'required field is missing'))
    return
  }
  if (!Array.isArray(value)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/ui_components', 'must be an array'))
    return
  }
  const knownSurfaces = new Set<string>(KNOWN_UI_SURFACES)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    const path = `/ui_components/${i}`
    if (!isPlainObject(item)) {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be an object'))
      continue
    }
    requireString(item, 'name', `${path}/name`, errors)
    requireString(item, 'entry_point', `${path}/entry_point`, errors)
    const surface = item['surface']
    const surfacePath = `${path}/surface`
    if (typeof surface !== 'string' || !knownSurfaces.has(surface)) {
      errors.push(
        err(
          ERROR_CODES.TYPE_MISMATCH,
          surfacePath,
          `must be one of: ${KNOWN_UI_SURFACES.join(', ')}`,
        ),
      )
    }
    // Sprint 24: route_mount surface MUST declare an absolute
    // mount_path. Same refinement as cores/sdk/manifest.ts:
    // parseManifest — keeps install-time validation aligned with
    // author-side parsing. Hono `app.use(mount_path, mw)` only
    // protects subtrees rooted at an absolute path; a value like
    // 'admin' or 'admin/' would silently leave `/admin...` un-
    // gated, so we lock the format at validate time.
    if (surface === 'route_mount') {
      const mountPath = item['mount_path']
      if (typeof mountPath !== 'string' || mountPath.length === 0) {
        errors.push(
          err(
            ERROR_CODES.TYPE_MISMATCH,
            `${path}/mount_path`,
            'mount_path is required when ui_components[].surface is route_mount',
          ),
        )
      } else if (!/^\/([a-zA-Z0-9_\-]+)(\/[a-zA-Z0-9_\-]+)*$/.test(mountPath)) {
        errors.push(
          err(
            ERROR_CODES.TYPE_MISMATCH,
            `${path}/mount_path`,
            'mount_path must be absolute (leading /), no trailing slash, no whitespace',
          ),
        )
      }
    }
    if ('props_schema' in item) {
      const propsSchema = item['props_schema']
      if (!isPlainObject(propsSchema)) {
        errors.push(
          err(
            ERROR_CODES.TYPE_MISMATCH,
            `${path}/props_schema`,
            'must be a plain object when present (matches manifest.schema.json UiComponentDef)',
          ),
        )
      }
    }
  }
}

function validateBillingHooks(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/billing_hooks', 'required field is missing'))
    return
  }
  if (!Array.isArray(value)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/billing_hooks', 'must be an array'))
    return
  }
  const knownModels = new Set<string>(KNOWN_BILLING_MODELS)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    const path = `/billing_hooks/${i}`
    if (!isPlainObject(item)) {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be an object'))
      continue
    }
    const model = item['model']
    const modelPath = `${path}/model`
    if (typeof model !== 'string' || !knownModels.has(model)) {
      errors.push(
        err(
          ERROR_CODES.TYPE_MISMATCH,
          modelPath,
          `must be one of: ${KNOWN_BILLING_MODELS.join(', ')}`,
        ),
      )
    }
    if (typeof item['price_cents'] !== 'number') {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, `${path}/price_cents`, 'must be a number'))
    }
    requireString(item, 'currency', `${path}/currency`, errors)
    for (const optionalKey of ['on_install', 'on_uninstall'] as const) {
      if (optionalKey in item) {
        const v = item[optionalKey]
        if (typeof v !== 'string') {
          errors.push(
            err(
              ERROR_CODES.TYPE_MISMATCH,
              `${path}/${optionalKey}`,
              'must be a string when present (matches manifest.schema.json BillingHookDef)',
            ),
          )
        }
      }
    }
  }
}

function validateLinkedSources(
  value: unknown,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/linked_sources', 'required field is missing'))
    return
  }
  if (!Array.isArray(value)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/linked_sources', 'must be an array'))
    return
  }
  const knownKinds = new Set<string>(KNOWN_LINKED_SOURCE_KINDS)
  const knownScopes = new Set<string>(KNOWN_LINKED_SOURCE_SCOPES)
  const knownTargets = new Set<string>(KNOWN_LINKED_SOURCE_TARGET_KINDS)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    const path = `/linked_sources/${i}`
    if (!isPlainObject(item)) {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be an object'))
      continue
    }
    const kind = item['kind']
    if (typeof kind !== 'string' || kind.length === 0) {
      errors.push(
        err(
          ERROR_CODES.INVALID_LINKED_SOURCE,
          `${path}/kind`,
          'must be a non-empty string identifying the third-party data source',
        ),
      )
    } else if (!knownKinds.has(kind)) {
      // Sprint 24: kind is now a free-form string per § A.3.5 so
      // first-party Cores can declare novel providers (`shopify`,
      // `google-ads`, `meta-ads`) without requiring a 4-place
      // closed-enum edit per new connector. Unknown values are
      // surfaced as a warning, not an error — marketplace display
      // can still flag them but install proceeds.
      warnings.push(
        warn(
          'W_UNKNOWN_LINKED_SOURCE_KIND',
          `${path}/kind`,
          `kind ${JSON.stringify(kind)} is not in the known set (${KNOWN_LINKED_SOURCE_KINDS.join(', ')})`,
        ),
      )
    }
    const scope = item['scope']
    if (typeof scope !== 'string' || !knownScopes.has(scope)) {
      errors.push(
        err(
          ERROR_CODES.INVALID_LINKED_SOURCE,
          `${path}/scope`,
          `must be one of: ${KNOWN_LINKED_SOURCE_SCOPES.join(', ')}`,
        ),
      )
    }
    const targets = item['target_kinds']
    const targetsPath = `${path}/target_kinds`
    if (!Array.isArray(targets)) {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, targetsPath, 'must be an array'))
      continue
    }
    if (targets.length === 0) {
      warnings.push(
        warn(
          WARNING_CODES.EMPTY_TARGET_KINDS,
          targetsPath,
          'empty target_kinds means the Core opts out of cross-project linking for this source',
        ),
      )
    } else {
      for (let j = 0; j < targets.length; j++) {
        const t = targets[j]
        if (typeof t !== 'string' || !knownTargets.has(t)) {
          errors.push(
            err(
              ERROR_CODES.INVALID_LINKED_SOURCE,
              `${targetsPath}/${j}`,
              `must be one of: ${KNOWN_LINKED_SOURCE_TARGET_KINDS.join(', ')}`,
            ),
          )
        }
      }
    }
  }
}

function validateSecrets(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/secrets', 'required field is missing'))
    return
  }
  if (!Array.isArray(value)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/secrets', 'must be an array'))
    return
  }
  const knownKinds = new Set<string>(KNOWN_MANIFEST_SECRET_KINDS)
  for (let i = 0; i < value.length; i++) {
    const item = value[i]
    const path = `/secrets/${i}`
    if (!isPlainObject(item)) {
      errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be an object'))
      continue
    }
    requireString(item, 'name', `${path}/name`, errors)
    requireString(item, 'label', `${path}/label`, errors)
    requireString(item, 'install_prompt', `${path}/install_prompt`, errors)
    const kind = item['kind']
    if (typeof kind !== 'string' || !knownKinds.has(kind)) {
      errors.push(
        err(
          ERROR_CODES.TYPE_MISMATCH,
          `${path}/kind`,
          `must be one of: ${KNOWN_MANIFEST_SECRET_KINDS.join(', ')}`,
        ),
      )
    }
    const required = item['required']
    if (typeof required !== 'boolean') {
      errors.push(
        err(ERROR_CODES.TYPE_MISMATCH, `${path}/required`, 'must be a boolean'),
      )
    }
    if ('scope' in item) {
      const scope = item['scope']
      if (typeof scope !== 'string' || scope.length === 0) {
        errors.push(
          err(
            ERROR_CODES.TYPE_MISMATCH,
            `${path}/scope`,
            'must be a non-empty string when present',
          ),
        )
      }
    }
  }
}

function validateCompat(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/compat', 'required field is missing'))
    return
  }
  if (!isPlainObject(value)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/compat', 'must be an object'))
    return
  }
  const coreApi = value['coreApi']
  if (coreApi === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/compat/coreApi', 'required field is missing'))
    return
  }
  if (typeof coreApi !== 'string') {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/compat/coreApi', 'must be a string'))
    return
  }
  if (!isValidSemverRange(coreApi)) {
    errors.push(
      err(
        ERROR_CODES.INVALID_SEMVER,
        '/compat/coreApi',
        `not a valid semver range: ${JSON.stringify(coreApi)}`,
      ),
    )
  }
}

function validateBuild(value: unknown, errors: ValidationError[]): void {
  if (value === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, '/build', 'required field is missing'))
    return
  }
  if (!isPlainObject(value)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, '/build', 'must be an object'))
    return
  }
  requireString(value, 'neutronVersion', '/build/neutronVersion', errors)
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationError[],
): void {
  const v = obj[key]
  if (v === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, path, 'required field is missing'))
    return
  }
  if (typeof v !== 'string' || v === '') {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be a non-empty string'))
  }
}

function requireObject(
  obj: Record<string, unknown>,
  key: string,
  path: string,
  errors: ValidationError[],
): void {
  const v = obj[key]
  if (v === undefined) {
    errors.push(err(ERROR_CODES.REQUIRED_MISSING, path, 'required field is missing'))
    return
  }
  if (!isPlainObject(v)) {
    errors.push(err(ERROR_CODES.TYPE_MISMATCH, path, 'must be an object'))
  }
}

/**
 * Re-export of the imported types for callers that want to grab everything
 * from `@neutronai/core-sdk/validator`. Use `import type { ... } from "..."`
 * downstream so this stays a structural barrel under `verbatimModuleSyntax`.
 */
export type {
  LinkedSourceDef,
  NeutronCapability,
  NeutronManifest,
  TierSupport,
  ValidationError,
  ValidationResult,
  ValidationWarning,
}
