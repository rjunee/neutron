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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { resolveNeutronHome, resolveOpenDbPath } from '@neutronai/migrations/db-path.ts'

/** The env bag shape we read. Matches `NodeJS.ProcessEnv`. */
export type EnvBag = Record<string, string | undefined>

// ---------------------------------------------------------------------------
// Verbatim defaults — the single source of truth. Copied from the original
// read sites (file:line noted). The defaults-table test pins each one.
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  // runtime/models.ts:53/71/89/96
  bestModel: 'claude-opus-5',
  fableModel: 'claude-fable-5',
  sonnetModel: 'claude-sonnet-5',
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
  // S2 wide-bind guard — dev-auth BYPASS vars, snapshotted RAW so the guard
  // reads the SAME env the config was resolved from (never live process.env,
  // which can drift between resolve and boot). NEUTRON_DEV_AUTH is above.
  NEUTRON_APP_WS_BYPASS: optStr,
  NEUTRON_APP_WS_DEV_SECRET: optStr,
  NEUTRON_E2E_DEV_SECRET: optStr,
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

/**
 * THE THREE INPUTS TO "WHICH INSTANCE AM I", and nothing else.
 *
 * `resolveOwnerSlugSourceFromConfig` (gateway/index.ts) reads exactly these
 * three fields off {@link BootConfig} — the effective owner home it looks for
 * `.url_slug` in, and the raw `NEUTRON_INSTANCE_SLUG`. It never reads a port, a
 * model id or an upload cap.
 *
 * They live in their own interface because ASKING WHO I AM MUST NOT REQUIRE THE
 * WHOLE ENVIRONMENT TO BE VALID. A prior round made the CLI's slug resolver
 * delegate to `resolveBootConfig` — correct about the inputs, and it dragged
 * every unrelated numeric knob's validation along with it, so `NEUTRON_PORT=bad`
 * made `neutron doctor` THROW out of `collectCliDiagnostics` instead of
 * returning its documented `{ok:false}` (open/diagnostics-cli-impl.ts:32 calls
 * the resolver outside the try). A diagnostic that dies on the malformed
 * configuration it exists to report is the one failure mode it cannot have.
 *
 * `BootConfig` structurally satisfies this, so boot keeps passing its frozen
 * full config and there is still exactly ONE resolver body.
 */
export interface IdentityConfig {
  /** Effective `NEUTRON_HOME` — including the `~/neutron` default. */
  readonly neutronHome: string
  /** Raw `OWNER_HOME`; the `.url_slug` lookup prefers it over `neutronHome`. */
  readonly ownerHome: string | undefined
  /** Raw `NEUTRON_INSTANCE_SLUG` — `undefined` exactly when the var was absent. */
  readonly instanceSlug: string | undefined
}

export interface BootConfig extends IdentityConfig {
  /** Raw `NODE_ENV` (compared `=== 'test'` / `=== 'production'` at read sites). */
  readonly nodeEnv: string | undefined
  /** Resolved deployment role (`NEUTRON_ROLE`, default `open`). */
  readonly role: DeploymentRole
  /** TRUE only on the hosted relay we operate (role=connect AND marker set). */
  readonly hostedRelayMetered: boolean

  // identity / paths -------------------------------------------------------
  // `neutronHome` / `ownerHome` / `instanceSlug` are INHERITED from
  // `IdentityConfig` and deliberately not re-declared: two declarations of the
  // same field are two places to change it, and the whole point of that
  // interface is that there is one answer to "which instance am I".
  /**
   * THE resolved SQLite path — `NEUTRON_DB_PATH` else `<neutronHome>/project.db`
   * (the `migrations/db-path.ts` single-source precedence). This unifies the
   * dual-entrypoint trap: `gateway/index.ts` previously fell back to
   * `~/.local/share/neutron/owner.db` (a DIFFERENT, "wrong" DB per the C1
   * brief) — both entrypoints now resolve the SAME file through here.
   */
  readonly dbPath: string
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

  /**
   * S2 wide-bind guard input — the RAW dev-auth BYPASS env values captured at
   * resolution time, so `assertWideBindPolicy` reads the SAME snapshot the rest
   * of BootConfig came from (NOT live `process.env`, which can drift between
   * resolve and boot — the single-snapshot contract). Keyed by env-var name so
   * it is a drop-in `BindEnvBag` for the guard.
   */
  readonly devBypassEnv: Readonly<Record<string, string | undefined>>

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
 * The identity-only slice of {@link bootEnvSchema} — three raw vars, every one
 * of them a plain optional string, so parsing it CANNOT fail on a malformed
 * knob it does not contain.
 *
 * `NEUTRON_DB_PATH` is deliberately absent: `resolveNeutronHome`
 * (`migrations/db-path.ts:35-41`) reads only `NEUTRON_HOME` then `OWNER_HOME`
 * then the `~/neutron` default — it never looks at the DB path. Passing it
 * would suggest a precedence that does not exist.
 */
const identityEnvSchema = bootEnvSchema.pick({
  NEUTRON_HOME: true,
  OWNER_HOME: true,
  NEUTRON_INSTANCE_SLUG: true,
})

/**
 * Resolve ONLY the three identity inputs (see {@link IdentityConfig}).
 *
 * `resolveBootConfig` below calls this for its own identity fields, so the
 * `~/neutron` default that `resolveNeutronHome` materialises when neither
 * `NEUTRON_HOME` nor `OWNER_HOME` is set is computed in ONE place and boot, the
 * gateway wrapper and the CLI cannot drift apart on it — which is what the
 * previous rounds were fixing. What this does NOT do is validate `NEUTRON_PORT`
 * or any other knob: `neutron doctor`'s whole job is to run on a box whose
 * configuration is broken.
 */
export function resolveIdentityConfig(env: EnvBag = process.env): IdentityConfig {
  const e = identityEnvSchema.parse(env)
  return {
    neutronHome: resolveNeutronHome({
      NEUTRON_HOME: e.NEUTRON_HOME,
      OWNER_HOME: e.OWNER_HOME,
    }),
    ownerHome: e.OWNER_HOME,
    instanceSlug: e.NEUTRON_INSTANCE_SLUG,
  }
}

/**
 * THE EFFECTIVE OWNER HOME — the directory the `.url_slug` rename file is read
 * from (`gateway/index.ts` `resolveOwnerSlugSourceFromConfig`) AND the value
 * {@link envShimFromBootConfig} publishes back to `OWNER_HOME`. Those two are
 * documented as the same value, so they compute it in ONE place.
 *
 * AN EMPTY `OWNER_HOME` IS NOT A HOME. This was `config.ownerHome ??
 * config.neutronHome` at both sites, and `??` falls through on `null`/`undefined`
 * but NOT on `''` — so `OWNER_HOME=''` resolved the effective home to `''`, the
 * slug resolver rejected that as unusable and SKIPPED the `.url_slug` lookup
 * entirely instead of falling back to `neutronHome`. On a correctly renamed
 * instance that exports an empty `OWNER_HOME`, all three slug resolvers
 * collapsed onto the bare `'dev'` fallback at once, boot journalled the handle
 * as orphaned, and every explicit credential migration answered `Refused` —
 * telling the owner to set a handle that was already set.
 *
 * `resolveNeutronHome` (`migrations/db-path.ts`) has always treated an empty
 * `NEUTRON_HOME`/`OWNER_HOME` as UNSET. The two halves of one identity
 * resolution now agree about what empty means; they did not before.
 *
 * WHITESPACE IS EMPTY TOO, and a `length > 0` guard does not say so. A review
 * measured `OWNER_HOME='   '` reaching this line and being answered as a home:
 * the `.url_slug` lookup then ran against a directory named three spaces, found
 * nothing, and a correctly renamed instance resolved to the anonymous fallback
 * again — the same defect as the empty string, one space away from it and past
 * the fix for it. So this predicate trims, and so does every other TYPESCRIPT
 * read of `OWNER_HOME` / `NEUTRON_HOME` / `NEUTRON_DB_PATH` in the repo.
 *
 * THE SCOPE OF THAT CLAIM IS A GREP, NOT A MEMORY — this sentence has been
 * wrong twice, and both times because it was written from a mental model of
 * "the identity resolvers" while the divergent readers sat just outside it.
 * Round 1 said "every sibling trims" while three did not (`resolveOpenDbPath`,
 * `resolveRegistryDbPath`, and the return half of `resolveStatePath` — they
 * were on the OTHER two variables, which is why the sweep missed them). Round 2
 * enumerated seven sites and called the list exhaustive; five more readers were
 * outside it, and one of the seven — `open/server.ts` — was NAMED as trimming
 * while the file contained no `trim()` at all. A docblock asserting a property
 * the repo lacks is worse than no docblock: it is confidently specific, it
 * reads as design documentation, and the next reader trusts it instead of
 * checking.
 *
 * Round 3 replaced the list with a grep — and the grep had the same hole one
 * level down. It matched only the LITERAL forms (`.OWNER_HOME`, `OWNER_HOME']`),
 * so `buildPromptVars` (`prompts/template.ts`), which reads the variable through
 * the exported `OWNER_HOME_KEY` constant, was invisible to it. Worse than
 * invisible: the command DID print `prompts/template.ts`, at the docblock line
 * that merely mentions `env.OWNER_HOME` — so the file appeared in the output,
 * looked audited, and the untrimmed read below it was never opened. A check that
 * returns a hit it cannot justify is the same defect as a check that returns a
 * negative it cannot justify; this one just wears a tick instead of a cross.
 *
 * So the claim is bounded by a command anyone can re-run rather than by a list
 * anyone can fall off — and the command now covers the constant-key form:
 *
 *   grep -rn --include='*.ts' "NEUTRON_HOME'\]\|\.NEUTRON_HOME\|OWNER_HOME'\]\|\.OWNER_HOME\|NEUTRON_DB_PATH'\]\|\.NEUTRON_DB_PATH\|OWNER_HOME_KEY" .
 *
 * Every non-test hit either trims its predicate or is a WRITE. The readers, all
 * fixed: {@link resolveOwnerSlugSourceFromConfig}'s `instanceSlug` branch and
 * this function here; `resolveNeutronHome` + `resolveOpenDbPath`
 * (`migrations/db-path.ts`); `resolveRegistryDbPath` + `resolveOwnerHome`
 * (`gateway/boot-listener-registry.ts`); `resolveOwnerHomeFromEnv`
 * (`onboarding/overnight/register.ts`); `resolveStatePath`
 * (`gbrain-memory/gbrain-doctor.ts`); the env shim's fill predicate
 * (`open/server.ts`); `main`'s `--home` guard (`scripts/email-accounts.ts`);
 * `resolveReplCwdAndHome` (`runtime/adapters/claude-code/index.ts`);
 * `resolveSkillsDir` (`gateway/wiring/build-phase-spec-resolver.ts`);
 * `resolveM2FeedbackPath` (`onboarding/feedback/m2-week-4-collector.ts`); and
 * `buildPromptVars` (`prompts/template.ts`) — the constant-key one.
 *
 * WHICH OF THEM A LIVE PATH REACHES, because "brought onto the rule" and "fixed
 * a reachable defect" are different claims and this docblock has already been
 * burned by conflating two things that sounded alike. Reachable today:
 * `resolveNeutronHome`, `resolveOpenDbPath`, `resolveOwnerHome`,
 * `resolveOwnerHomeFromEnv`, `resolveStatePath`, the env shim pair, and
 * `buildPromptVars` (via `trident/agent-prompts.ts`). Published surfaces with no
 * in-tree invocation — `resolveRegistryDbPath` (re-exported at
 * `gateway/index.ts` and `gateway/composer-contract.ts`, both re-exports, no
 * caller) and `resolveM2FeedbackPath` (its collector has no non-test
 * instantiation). Defensive on a live path whose only current callers pass a
 * real value: `resolveReplCwdAndHome` and `resolveSkillsDir`. Consistency across
 * a family is the point either way, but the unreachable ones are hardening, not
 * bug fixes, and saying so is cheaper than the next reviewer re-deriving it.
 *
 * WHAT THE COMMAND DOES NOT COVER, STATED RATHER THAN IMPLIED. It is
 * `--include='*.ts'`, so the claim it bounds is a claim about TYPESCRIPT. The
 * repo has readers of these same three variables in other languages, and they do
 * NOT follow this rule: `install.sh` honours a whitespace-only `NEUTRON_DB_PATH`
 * via `!= ""`, and `neutron-service.sh` / `neutron-backup.sh` resolve the data
 * dir with `[ -n "$DATA_DIR" ]`, which is true for three spaces. So an installer
 * and the server it installs can still disagree about which database exists —
 * the same split, one language over. That is deliberately NOT fixed here: the
 * shell entrypoints are the install / uninstall / backup paths, they are a
 * different blast radius from a resolver, and folding them into a TypeScript
 * change would make this diff unreviewable.
 *
 * It is written down because the alternative is the defect this docblock keeps
 * committing — a claim wider than its proof. Three rounds of that produced three
 * rounds of real bugs hiding in the gap; the fix is not a better sweep, it is a
 * claim that stops at the edge of what was actually checked.
 *
 * The list is documentation. The GUARD is
 * `open/__tests__/owner-slug-agreement.test.ts`, which drives blank values
 * through the readers it can import and pins the answers, each with a
 * real-path control — so a reader that stops trimming goes red instead of
 * going unnoticed until the next review reads this paragraph.
 *
 * The RETURN is verbatim, not trimmed: a blank value means unset, but a value
 * that is genuinely a path is published back to `OWNER_HOME` byte-for-byte
 * (`envShimFromBootConfig`), which is the verbatim-fidelity contract this leaf
 * is built on.
 */
export function effectiveOwnerHome(config: IdentityConfig): string {
  const ownerHome = config.ownerHome
  if (typeof ownerHome === 'string' && ownerHome.trim().length > 0) return ownerHome
  return config.neutronHome
}

/** Where the boot slug came from — see {@link resolveOwnerSlugSourceFromConfig}. */
export type OwnerSlugSource = 'file' | 'env' | 'fallback'

/** The boot slug plus its provenance. */
export interface OwnerSlugResolution {
  readonly slug: string
  readonly source: OwnerSlugSource
}

/**
 * Thrown when `.url_slug` EXISTS but cannot be read — a chmod-000 file
 * (a recorded real deployment failure, `docs/AS_BUILT.md`), or a DIRECTORY of
 * that name (EISDIR). `existsSync` is true for both.
 *
 * IT IS A THROW AND NOT A DEGRADE, AND THAT IS THE WHOLE POINT. A round of this
 * branch swallowed the read error and fell through to `NEUTRON_INSTANCE_SLUG`,
 * which is the one outcome that must never happen: on a renamed instance the
 * env var still holds the OLD handle, the fall-through classifies it
 * `source: 'env'`, `slug_is_fallback` reaches the credential direction guard as
 * `false`, and the sweep migrates the owner's credential rows BACKWARD onto the
 * name they were renamed away from. Silently. The unreadable file is the only
 * evidence that the fall-through answer is wrong, so discarding it converts a
 * loud, fixable permissions problem into silent data movement.
 *
 * Callers that need an answer rather than a throw catch THIS type and decide
 * for themselves — `neutron doctor` renders its documented `{ok:false}` error
 * (`open/diagnostics-cli-impl.ts`), and `boot()` fails loudly, which is what it
 * did before this branch existed and what
 * `gateway/__tests__/boot-init-cleanup.test.ts` pins.
 */
export class OwnerSlugUnreadableError extends Error {
  /** The `.url_slug` path that exists and could not be read. */
  readonly slugFile: string

  constructor(slugFile: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`owner handle file '${slugFile}' exists but could not be read: ${detail}`, { cause })
    this.name = 'OwnerSlugUnreadableError'
    this.slugFile = slugFile
  }
}

/**
 * THE one resolver for "which instance am I", plus the bit a bare string throws
 * away: WHERE the answer came from.
 *
 * The scope reconciler needs to tell "explicitly dev" from "nobody told me who
 * I am" (defect 2026-08-14: an `NEUTRON_INSTANCE_SLUG`-unset boot that inherited
 * a live `NEUTRON_HOME` re-keyed every credential row onto the `'dev'` fallback,
 * and the running gateway — frozen on its real handle — read zero secrets). A
 * bare string cannot carry that distinction, and `config.instanceSlug` is
 * `undefined` exactly when the env var was absent ({@link resolveIdentityConfig}),
 * so it is recoverable HERE and nowhere later.
 *
 * Precedence: `.url_slug` file > `instanceSlug` > `'dev'`. An EXPLICIT
 * `NEUTRON_INSTANCE_SLUG=dev` is `'env'` — deliberately configuring the same
 * string the fallback happens to use is still configuring it, and the guard
 * must honour that.
 *
 * AN EMPTY OR WHITESPACE VALUE IS `'fallback'`, NOT `'env'`. That sentence used
 * to say the opposite, and the code used to agree with it: a review found that
 * `NEUTRON_INSTANCE_SLUG=''` was classified as a configured identity, which
 * told the credential direction guard this process knows who it is and let an
 * explicit migration move rows onto the empty handle. An empty variable is not
 * an identity; it is the absence of one wearing its shape.
 *
 * TAKES `IdentityConfig`, NOT `BootConfig`. It only ever read those three
 * fields, and demanding the whole config forced every caller to VALIDATE the
 * whole environment first — which is how an unrelated `NEUTRON_PORT=bad` began
 * throwing out of `neutron doctor`. `BootConfig extends IdentityConfig`, so
 * boot still passes its frozen config here unchanged and the three resolvers
 * still share one body.
 *
 * IT LIVES IN THIS LEAF, NOT IN `gateway/index.ts`. It was defined on the
 * gateway ENTRY module, and `open/owner-identity.ts` imported it from there —
 * putting the entry module into the composer's own import graph, which
 * `gateway/composer-contract.ts` forbids outright (the entry↔composer
 * top-level-await cycle). Its only inputs are an {@link IdentityConfig} and the
 * filesystem, so the identity leaf every band may already depend on is where it
 * belongs; `gateway/index.ts` re-exports it for its existing importers.
 *
 * @throws {OwnerSlugUnreadableError} when `.url_slug` exists and cannot be read.
 */
export function resolveOwnerSlugSourceFromConfig(config: IdentityConfig): OwnerSlugResolution {
  // AN EMPTY `OWNER_HOME` IS NOT A HOME, AND IT USED TO COLLAPSE ALL THREE
  // RESOLVERS AT ONCE. This read `config.ownerHome ?? config.neutronHome`, and
  // `??` does not fall through on `''` — so `OWNER_HOME=''` resolved the
  // effective home to `''`, the guard below rejected it, and the `.url_slug`
  // lookup was skipped instead of falling back to `neutronHome`. A correctly
  // renamed instance then booted on the bare `'dev'` fallback and refused every
  // credential migration, telling the owner to set a handle already set.
  // `effectiveOwnerHome` is the ONE place that decides, and it agrees with
  // `resolveNeutronHome` (`migrations/db-path.ts`) about what empty means.
  const ownerHome = effectiveOwnerHome(config)
  if (ownerHome.length > 0) {
    const slugFile = join(ownerHome, '.url_slug')
    if (existsSync(slugFile)) {
      // AN UNREADABLE RENAME FILE IS AN ERROR, NOT AN ABSENT ONE. The previous
      // round caught this read and fell through to the env slug so that
      // `neutron doctor` would stop throwing; that made a permissions problem
      // indistinguishable from "no rename has happened", and on a renamed box
      // the env var holds the OLD handle — so the credential guard was handed
      // `source: 'env'` and migrated the rows backward. See
      // {@link OwnerSlugUnreadableError}. The doctor's `{ok:false}` contract is
      // honoured by CATCHING at the diagnostics caller, which is the only
      // caller that wants an answer more than it wants the truth.
      // EVERY errno, INCLUDING `ENOENT` — DELIBERATE, and reviewed. A review
      // proposed falling through when the read races an unlink (`existsSync`
      // passed, then the file vanished), on the reasoning that a file which is
      // no longer there IS the absent case. It is not, and the difference is
      // the point of this module: the fall-through answers with
      // `NEUTRON_INSTANCE_SLUG`, which on a renamed box holds the OLD handle,
      // and hands the credential guard `source: 'env'` — i.e. "this process
      // knows who it is" — at the exact moment something is rewriting the file
      // that says who it is. Racing a rename is when to trust the env LEAST.
      // The window is also tiny in practice, because the writer truncates
      // rather than unlinks. Throwing costs a loud boot failure on a race that
      // a retry fixes; falling through costs the owner's credential rows,
      // silently. Not special-cased, on purpose.
      let fromFile: string
      try {
        fromFile = readFileSync(slugFile, 'utf8').trim()
      } catch (err) {
        throw new OwnerSlugUnreadableError(slugFile, err)
      }
      // An EMPTY rename file is a different thing from an unreadable one: it
      // was read successfully and says nothing, which is the absent case.
      if (fromFile.length > 0) return { slug: fromFile, source: 'file' }
    }
  }
  // TRIMMED AND NON-EMPTY, exactly like the `.url_slug` branch above — the
  // asymmetry between them WAS the bug. `NEUTRON_INSTANCE_SLUG=''` is not a
  // configured identity, it is an empty variable wearing the costume of one,
  // and classifying it as `'env'` told the credential guard this process knows
  // who it is. Found by review with a repro: resolve with an empty slug, call
  // the explicit migration, and rows move off the live handle onto `''`.
  //
  // A blank value means nobody said, which is what `'fallback'` means.
  const fromEnv = config.instanceSlug?.trim() ?? ''
  if (fromEnv.length > 0) return { slug: fromEnv, source: 'env' }
  return { slug: 'dev', source: 'fallback' }
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

  // The identity slice comes from the SAME function the slug-only callers use,
  // so a full boot and a `neutron doctor` on the same box cannot disagree about
  // which instance they are looking at.
  const identity = resolveIdentityConfig(env)

  const disableAmbientRaw = e.NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH
  const skipRaw = e.NEUTRON_SKIP_GBRAIN

  const config: BootConfig = {
    nodeEnv: e.NODE_ENV,
    role: normalizeRole(e.NEUTRON_ROLE),
    hostedRelayMetered:
      normalizeRole(e.NEUTRON_ROLE) === 'connect' && hostedRelayMarker(e.NEUTRON_CONNECT_METERED),

    neutronHome: identity.neutronHome,
    ownerHome: identity.ownerHome,
    dbPath: resolveOpenDbPath(dbEnv),
    instanceSlug: identity.instanceSlug,
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

    // S2 wide-bind guard snapshot — raw values, frozen with the rest of config.
    devBypassEnv: Object.freeze({
      NEUTRON_DEV_AUTH: e.NEUTRON_DEV_AUTH,
      NEUTRON_APP_WS_BYPASS: e.NEUTRON_APP_WS_BYPASS,
      NEUTRON_APP_WS_DEV_SECRET: e.NEUTRON_APP_WS_DEV_SECRET,
      NEUTRON_E2E_DEV_SECRET: e.NEUTRON_E2E_DEV_SECRET,
    }),

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
  // Via {@link effectiveOwnerHome}, so a BLANK `OWNER_HOME` is repaired here
  // too. What this function COMPUTES is only half of it: `applyEnvShim`
  // (`open/server.ts`) decides what actually reaches the env, and it filled a
  // slot that was `undefined` OR `''` — so the old `??` re-wrote the empty
  // string over itself, and a whitespace-only value was mistaken for an
  // operator pin and left in place while this function had already resolved it
  // to the real home. Both halves now agree that blank is unset; the pair is
  // pinned together in `open/__tests__/owner-slug-agreement.test.ts`.
  out['OWNER_HOME'] = effectiveOwnerHome(config)
  out['NEUTRON_DB_PATH'] = config.dbPath
  if (config.onboardingChatCookieSecret !== undefined) {
    out['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = config.onboardingChatCookieSecret
  }
  return out
}
