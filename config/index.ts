/**
 * @neutronai/config — the typed BootConfig lane composer (refactor unit C1).
 *
 * ONE place that resolves + validates the process environment ONCE per process
 * into a frozen, typed {@link BootConfig}. Before C1 ~64 runtime env vars were
 * read across ~71 files via scattered `process.env.X` with inline `?? default`
 * coercions; a bad numeric (`NEUTRON_PORT=abc`) silently became `NaN`, and the
 * two entrypoints (`gateway/index.ts`, `open/server.ts`) resolved the SAME var
 * (`NEUTRON_DB_PATH`) with two DIFFERENT defaults — the dual-entrypoint trap.
 *
 * This leaf is the single source of truth for those defaults. It is a
 * `contracts`-band leaf (see `.dependency-cruiser.cjs`): it imports only the
 * `migrations/db-path.ts` DB-path resolver (also a contracts leaf — reused so
 * DB-path precedence stays defined in exactly one place) and `zod`. It imports
 * NOTHING upward, so it can be depended on from every band without a cycle.
 *
 * VERBATIM-FIDELITY CONTRACT: every default below is copied verbatim from the
 * original read site. `config/__tests__/bootconfig-defaults.test.ts` is the
 * proof — a table asserting each resolved default EQUALS the original inline
 * default. Numeric knobs additionally FAIL LOUD on a bad value instead of
 * silently becoming `NaN` (the C1 mandate). The unset→default path is unchanged.
 *
 * SCOPE NOTE (what is intentionally NOT modelled here):
 *   - `EXPO_PUBLIC_*` — Expo bundler-inlined at build time, not Node-runtime
 *     resolvable; they belong to the RN bundle, never the server BootConfig.
 *   - OS/process-manager vars (`PATH`, `HOME`, `TMPDIR`, `BUN_INSTALL`,
 *     `NOTIFY_SOCKET`) — supplied by the OS/systemd, not app config.
 *   - Spawned-child contract vars (`SINK_PORT`, `SINK_TOKEN`, `SESSION_ID`,
 *     `CHANNEL_NAME`, `BRIDGE_SERVER_NAME`, `TOOLS_MANIFEST_PATH`,
 *     `NEUTRON_ENFORCE_REPLY_LOG`) — injected by the parent into a child
 *     process's env; they are a subprocess IPC contract, not gateway boot input.
 *   - Test-harness flags (`NEUTRON_ISO_*`, `NEUTRON_PTY_E2E`,
 *     `NEUTRON_E2E_NETWORK`, `__NEUTRON_TEST_TIMEOUT__`).
 * These are documented in the C1 STEP-0 inventory and stay served by their
 * existing (already env-injectable) resolvers.
 */

import { z } from 'zod'

import { resolveNeutronHome, resolveOpenDbPath } from '../migrations/db-path.ts'

/** The env bag shape we read. Matches `NodeJS.ProcessEnv`. */
export type EnvBag = Record<string, string | undefined>

// ---------------------------------------------------------------------------
// Verbatim defaults — the single source of truth. Copied from the original
// read sites (file:line noted). The defaults-table test pins each one.
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  // runtime/models.ts:53/71/89/96
  bestModel: 'claude-opus-4-8',
  fableModel: 'claude-fable-5',
  sonnetModel: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5-20251001',
  // runtime/adapters/claude-code/index.ts (CLAUDE_BIN ?? 'claude')
  claudeBin: 'claude',
  // gateway/index.ts:308 (NEUTRON_HOST ?? '127.0.0.1')
  host: '127.0.0.1',
  // gateway/boot-helpers.ts:84 (DEFAULT_LISTEN_PORT)
  port: 7_800,
  // gateway/deployment-mode.ts:32 (DEFAULT_DEPLOYMENT_MODE)
  role: 'open' as const,
  // gateway/index.ts:156 / open/owner-identity.ts:41 (resolveOwnerSlug fallback)
  slugFallback: 'dev',
  // gateway/upload/import-upload-handler.ts:79 (5 GB)
  maxUploadBytes: 5 * 1024 * 1024 * 1024,
  // onboarding/synthesis/synthesis-session.ts:70
  maxSynthesisProjects: 10,
  // onboarding/overnight/dispatcher.ts:57/58
  overnightMaxConcurrent: 2,
  overnightMaxPerWindow: 8,
  // runtime/adapters/.../persistent-repl-substrate.ts (REPL_LIVENESS_KEEPALIVE_MS)
  replKeepaliveMs: 10_000,
  // runtime/doc-links.ts:70 & contracts/handoff-config.ts:27 (NEUTRON_WEB_APP_BASE ?? '')
  webAppBase: '',
  // runtime/doc-links.ts:84 (VAULT_REDIRECTOR_BASE ?? default placeholder)
  vaultRedirectorBase: 'https://vault.example.test',
  // runtime/return-url-validator.ts:51 (NEUTRON_BASE_DOMAIN ?? '')
  baseDomain: '',
  // connect/member-join.ts:66 (NEUTRON_TRUSTED_HOME_AUTHORITY ?? '')
  trustedHomeAuthority: '',
  // onboarding/feedback/m2-week-4-collector.ts:87 (M2_FEEDBACK_PATH ?? DEFAULT)
  // The concrete DEFAULT_M2_FEEDBACK_PATH is owned by the collector; BootConfig
  // stores only the env override (undefined => the collector keeps its default).
} as const

// ---------------------------------------------------------------------------
// Zod schema — validates + coerces the raw env bag. Numeric knobs coerce and
// range-check LOUD (a bad value throws with a clear message, never `NaN`).
// ---------------------------------------------------------------------------

/** A required-positive integer knob: unset => fallback; bad => LOUD throw. */
function intKnob(name: string, fallback: number, min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number => {
      if (raw === undefined || raw === '') return fallback
      const n = Number(raw)
      if (!Number.isInteger(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name}=${JSON.stringify(raw)} is not an integer (was NaN-silent before C1)`,
        })
        return z.NEVER
      }
      if (n < min || n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name}=${n} out of range [${min}, ${max}]`,
        })
        return z.NEVER
      }
      return n
    })
}

/**
 * An OPTIONAL integer knob: unset/empty => `undefined` (the downstream resolver
 * keeps its own default — e.g. `resolveListenPort`'s 7800), bad => LOUD throw.
 * Used for `NEUTRON_PORT`, whose seam default lives in `resolveListenPort`.
 */
function optionalIntKnob(name: string, min: number, max: number) {
  return z
    .string()
    .optional()
    .transform((raw, ctx): number | undefined => {
      if (raw === undefined || raw === '') return undefined
      const n = Number(raw)
      if (!Number.isInteger(n)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name}=${JSON.stringify(raw)} is not an integer (was NaN-silent before C1)`,
        })
        return z.NEVER
      }
      // Canonical-decimal guard, preserved BIT-FOR-BIT from the legacy
      // `resolveListenPort` (`String(parsed) === fromEnv.trim()`): reject
      // non-canonical lexicals that `Number()` would silently accept — hex
      // (`0x10`→16), scientific (`1e3`→1000), signs/leading-zeros (`+16`,
      // `016`). Trimmed whitespace is allowed (matches `.trim()`).
      if (String(n) !== raw.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name}=${JSON.stringify(raw)} is not a canonical decimal integer`,
        })
        return z.NEVER
      }
      if (n < min || n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name}=${n} out of range [${min}, ${max}]`,
        })
        return z.NEVER
      }
      return n
    })
}

const optStr = z.string().optional()

/**
 * The env schema. Every field is optional at the raw layer (env vars may be
 * unset); numeric defaults land here, string defaults land in the resolver so
 * the raw value survives for the process.env write-back shim.
 */
export const bootEnvSchema = z.object({
  // identity / paths
  NEUTRON_HOME: optStr,
  OWNER_HOME: optStr,
  NEUTRON_DB_PATH: optStr,
  NEUTRON_INSTANCE_SLUG: optStr,
  NEUTRON_AGENT_NAME: optStr,
  NEUTRON_CODEX_HOME: optStr,
  NEUTRON_LANDING_STATIC_DIR: optStr,
  NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET: optStr,
  NEUTRON_POST_ONBOARDING_CLAIM_URL: optStr,
  // listener / role
  NEUTRON_HOST: optStr,
  NEUTRON_PORT: optionalIntKnob('NEUTRON_PORT', 0, 65_535),
  NEUTRON_ROLE: optStr,
  NEUTRON_CONNECT_METERED: optStr,
  NODE_ENV: optStr,
  TZ: optStr,
  // graph-composer injection seam
  NEUTRON_GRAPH_COMPOSER_MODULE: optStr,
  NEUTRON_AUTH_JWKS_URL: optStr,
  // models
  NEUTRON_BEST_MODEL: optStr,
  NEUTRON_FABLE_MODEL: optStr,
  NEUTRON_SONNET_MODEL: optStr,
  NEUTRON_FAST_MODEL: optStr,
  CLAUDE_BIN: optStr,
  // numeric knobs (loud range checks)
  NEUTRON_MAX_UPLOAD_BYTES: intKnob(
    'NEUTRON_MAX_UPLOAD_BYTES',
    DEFAULTS.maxUploadBytes,
    1,
    Number.MAX_SAFE_INTEGER,
  ),
  NEUTRON_MAX_SYNTHESIS_PROJECTS: intKnob(
    'NEUTRON_MAX_SYNTHESIS_PROJECTS',
    DEFAULTS.maxSynthesisProjects,
    1,
    Number.MAX_SAFE_INTEGER,
  ),
  NEUTRON_OVERNIGHT_MAX_CONCURRENT: intKnob(
    'NEUTRON_OVERNIGHT_MAX_CONCURRENT',
    DEFAULTS.overnightMaxConcurrent,
    1,
    Number.MAX_SAFE_INTEGER,
  ),
  NEUTRON_OVERNIGHT_MAX_PER_WINDOW: intKnob(
    'NEUTRON_OVERNIGHT_MAX_PER_WINDOW',
    DEFAULTS.overnightMaxPerWindow,
    1,
    Number.MAX_SAFE_INTEGER,
  ),
  NEUTRON_REPL_KEEPALIVE_MS: intKnob(
    'NEUTRON_REPL_KEEPALIVE_MS',
    DEFAULTS.replKeepaliveMs,
    1,
    Number.MAX_SAFE_INTEGER,
  ),
  // urls / domains (raw kept; read sites normalize at call time)
  NEUTRON_WEB_APP_BASE: optStr,
  VAULT_REDIRECTOR_BASE: optStr,
  NEUTRON_BASE_DOMAIN: optStr,
  NEUTRON_TRUSTED_HOME_AUTHORITY: optStr,
  M2_FEEDBACK_PATH: optStr,
  // boolean flags (raw kept; resolver applies each site's exact truthiness rule)
  NEUTRON_REPL_DEBUG: optStr,
  NEUTRON_DEV_AUTH: optStr,
  NEUTRON_SKIP_GBRAIN: optStr,
  NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: optStr,
  // secrets (optional passthrough)
  OPENAI_API_KEY: optStr,
  OPENAI_API_TOKEN: optStr,
  OPENAI_AUTH_TOKEN: optStr,
  ANTHROPIC_API_KEY: optStr,
  CLAUDE_CODE_OAUTH_TOKEN: optStr,
})

export type BootEnv = z.infer<typeof bootEnvSchema>

// ---------------------------------------------------------------------------
// BootConfig — the frozen, typed result the entrypoints thread through boot().
// ---------------------------------------------------------------------------

export type DeploymentRole = 'open' | 'managed' | 'connect'

export interface BootConfigModels {
  readonly best: string
  readonly fable: string
  readonly sonnet: string
  readonly fast: string
}

export interface BootConfigSecrets {
  readonly openaiApiKey: string | undefined
  readonly openaiApiToken: string | undefined
  readonly openaiAuthToken: string | undefined
  readonly anthropicApiKey: string | undefined
  readonly claudeCodeOauthToken: string | undefined
}

export interface BootConfig {
  /** Raw `NODE_ENV` (compared `=== 'test'` / `=== 'production'` at read sites). */
  readonly nodeEnv: string | undefined
  /** Resolved deployment role (`NEUTRON_ROLE`, default `open`). */
  readonly role: DeploymentRole
  /** TRUE only on the hosted relay we operate (role=connect AND marker set). */
  readonly hostedRelayMetered: boolean

  // identity / paths -------------------------------------------------------
  readonly neutronHome: string
  readonly ownerHome: string | undefined
  /**
   * THE resolved SQLite path — `NEUTRON_DB_PATH` else `<neutronHome>/project.db`
   * (the `migrations/db-path.ts` single-source precedence). This unifies the
   * dual-entrypoint trap: `gateway/index.ts` previously fell back to
   * `~/.local/share/neutron/owner.db` (a DIFFERENT, "wrong" DB per the C1
   * brief) — both entrypoints now resolve the SAME file through here.
   */
  readonly dbPath: string
  readonly instanceSlug: string | undefined
  readonly agentName: string | undefined
  readonly codexHome: string | undefined
  readonly landingStaticDir: string | undefined
  readonly onboardingChatCookieSecret: string | undefined
  readonly postOnboardingClaimUrl: string | undefined

  // listener ---------------------------------------------------------------
  readonly host: string
  /** Parsed `NEUTRON_PORT`; `undefined` when unset (resolveListenPort default). */
  readonly port: number | undefined

  // graph-composer injection seam -----------------------------------------
  readonly graphComposerModule: string | undefined
  readonly authJwksUrl: string | undefined

  // models -----------------------------------------------------------------
  readonly models: BootConfigModels
  readonly claudeBin: string

  // numeric knobs ----------------------------------------------------------
  readonly maxUploadBytes: number
  readonly maxSynthesisProjects: number
  readonly overnightMaxConcurrent: number
  readonly overnightMaxPerWindow: number
  readonly replKeepaliveMs: number

  // urls / domains (raw, read sites normalize) -----------------------------
  readonly webAppBase: string
  readonly vaultRedirectorBase: string
  readonly baseDomain: string
  readonly trustedHomeAuthority: string
  readonly m2FeedbackPath: string | undefined

  // boolean flags (exact per-site truthiness preserved) --------------------
  readonly replDebug: boolean
  readonly devAuth: boolean
  readonly skipGbrain: boolean
  readonly disableAmbientClaudeAuth: boolean

  // timezone ---------------------------------------------------------------
  readonly tz: string | undefined

  // secrets ----------------------------------------------------------------
  readonly secrets: BootConfigSecrets
}

const KNOWN_ROLES: ReadonlySet<DeploymentRole> = new Set(['open', 'managed', 'connect'])

/** Mirror of `gateway/deployment-mode.ts` role normalization (verbatim rule). */
function normalizeRole(raw: string | undefined): DeploymentRole {
  const v = (raw ?? '').trim().toLowerCase()
  return KNOWN_ROLES.has(v as DeploymentRole) ? (v as DeploymentRole) : DEFAULTS.role
}

/** Mirror of `isHostedRelay` marker rule (verbatim). */
function hostedRelayMarker(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * Resolve + validate the process environment ONCE into a frozen BootConfig.
 * Throws (aggregated Zod error) if any numeric knob is malformed — the loud
 * failure that replaces the old silent-`NaN` behavior.
 */
export function resolveBootConfig(env: EnvBag = process.env): BootConfig {
  const e = bootEnvSchema.parse(env)

  // DB path via the single-source resolver (Open precedence). Feed it the
  // raw string values so its `NEUTRON_HOME`/`OWNER_HOME`/`NEUTRON_DB_PATH`
  // precedence is byte-for-byte the one `open/server.ts` + the migration
  // runner already use.
  const dbEnv: EnvBag = {
    NEUTRON_HOME: e.NEUTRON_HOME,
    OWNER_HOME: e.OWNER_HOME,
    NEUTRON_DB_PATH: e.NEUTRON_DB_PATH,
  }

  const disableAmbientRaw = e.NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH
  const skipRaw = e.NEUTRON_SKIP_GBRAIN

  const config: BootConfig = {
    nodeEnv: e.NODE_ENV,
    role: normalizeRole(e.NEUTRON_ROLE),
    hostedRelayMetered:
      normalizeRole(e.NEUTRON_ROLE) === 'connect' && hostedRelayMarker(e.NEUTRON_CONNECT_METERED),

    neutronHome: resolveNeutronHome(dbEnv),
    ownerHome: e.OWNER_HOME,
    dbPath: resolveOpenDbPath(dbEnv),
    instanceSlug: e.NEUTRON_INSTANCE_SLUG,
    agentName: e.NEUTRON_AGENT_NAME,
    codexHome: e.NEUTRON_CODEX_HOME,
    landingStaticDir: e.NEUTRON_LANDING_STATIC_DIR,
    onboardingChatCookieSecret: e.NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET,
    postOnboardingClaimUrl: e.NEUTRON_POST_ONBOARDING_CLAIM_URL,

    host: e.NEUTRON_HOST ?? DEFAULTS.host,
    port: e.NEUTRON_PORT,

    graphComposerModule: e.NEUTRON_GRAPH_COMPOSER_MODULE,
    authJwksUrl: e.NEUTRON_AUTH_JWKS_URL,

    models: {
      best: e.NEUTRON_BEST_MODEL ?? DEFAULTS.bestModel,
      fable: e.NEUTRON_FABLE_MODEL ?? DEFAULTS.fableModel,
      sonnet: e.NEUTRON_SONNET_MODEL ?? DEFAULTS.sonnetModel,
      fast: e.NEUTRON_FAST_MODEL ?? DEFAULTS.fastModel,
    },
    claudeBin: e.CLAUDE_BIN ?? DEFAULTS.claudeBin,

    maxUploadBytes: e.NEUTRON_MAX_UPLOAD_BYTES,
    maxSynthesisProjects: e.NEUTRON_MAX_SYNTHESIS_PROJECTS,
    overnightMaxConcurrent: e.NEUTRON_OVERNIGHT_MAX_CONCURRENT,
    overnightMaxPerWindow: e.NEUTRON_OVERNIGHT_MAX_PER_WINDOW,
    replKeepaliveMs: e.NEUTRON_REPL_KEEPALIVE_MS,

    webAppBase: e.NEUTRON_WEB_APP_BASE ?? DEFAULTS.webAppBase,
    vaultRedirectorBase: e.VAULT_REDIRECTOR_BASE ?? DEFAULTS.vaultRedirectorBase,
    baseDomain: e.NEUTRON_BASE_DOMAIN ?? DEFAULTS.baseDomain,
    trustedHomeAuthority: e.NEUTRON_TRUSTED_HOME_AUTHORITY ?? DEFAULTS.trustedHomeAuthority,
    m2FeedbackPath: e.M2_FEEDBACK_PATH,

    // Exact per-site truthiness rules, preserved verbatim:
    replDebug: e.NEUTRON_REPL_DEBUG === '1', // persistent-repl-substrate.ts:264
    devAuth: e.NEUTRON_DEV_AUTH === '1', // cores/sdk/{secrets,auth}.ts (`!== '1'` inverted)
    skipGbrain: skipRaw === '1' || skipRaw === 'true', // gbrain-doctor.ts:578
    disableAmbientClaudeAuth:
      typeof disableAmbientRaw === 'string' &&
      disableAmbientRaw.length > 0 &&
      disableAmbientRaw !== '0' &&
      disableAmbientRaw !== 'false', // ambient-claude-auth.ts:96

    tz: e.TZ,

    secrets: Object.freeze({
      openaiApiKey: e.OPENAI_API_KEY,
      openaiApiToken: e.OPENAI_API_TOKEN,
      openaiAuthToken: e.OPENAI_AUTH_TOKEN,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      claudeCodeOauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
    }),
  }

  return Object.freeze({ ...config, models: Object.freeze(config.models) })
}

/**
 * The subset of BootConfig values `open/server.ts` writes BACK onto
 * `process.env` (the SHIM). Below-the-seam readers (the composer's
 * sub-builders, still reading `process.env` today) keep working unchanged.
 * This shim is marked to die once those readers thread BootConfig directly.
 *
 * Only keys whose ABSENCE would change behavior are written, and only when the
 * env slot is empty — never clobbering an operator-set value.
 */
export function envShimFromBootConfig(config: BootConfig): Record<string, string> {
  const out: Record<string, string> = {}
  out['OWNER_HOME'] = config.ownerHome ?? config.neutronHome
  out['NEUTRON_DB_PATH'] = config.dbPath
  if (config.onboardingChatCookieSecret !== undefined) {
    out['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = config.onboardingChatCookieSecret
  }
  return out
}
