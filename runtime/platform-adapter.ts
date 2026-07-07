/**
 * @neutronai/runtime — PlatformAdapter (Sprint B, 2026-05-17).
 *
 * The logical seam between **Open** (self-hosted single-instance) and
 * **Managed** (multi-instance hosted VPS). Per Atlas O/M doc §§ 2.4.2 + A:
 * core code (runtime/, gateway/, channels/, onboarding/ core, persistence/,
 * cores/) must NOT directly import Managed-classified modules
 * (the provisioning module, `proxy/`, `identity/`, `signup/`,
 * `connect/api/`, `landing/install-token-*`,
 * `onboarding/api/<managed>`). Instead, callers depend on this interface
 * and the production composer wires the appropriate adapter:
 *
 *   - `LocalPlatformAdapter` (runtime/platform-adapter-local.ts) — Open
 *     stub. Single-instance; slug-rename / install-token / OAuth handoff /
 *     connect fan-out / manager-bot provisioning / Caddy reload /
 *     sudoers regenerate all throw `PlatformOperationUnsupportedError`.
 *     The slug-availability probe returns `{available: true}` for every
 *     well-formed slug because there's nothing to conflict against.
 *
 *   - `ManagedPlatformAdapter` (runtime/platform-adapter-managed.ts) —
 *     thin shim around the existing provisioning module,
 *     `proxy/`, `identity/`, `signup/` modules. Sprint B keeps this
 *     adapter in `runtime/`; Sprint C will physically relocate the
 *     Managed-side file to the proprietary repo so `runtime/` stays
 *     pure-Open.
 *
 * Sprint B is the LOGICAL split only — no files move, no behavior
 * changes, no dependencies added. Production callers continue to wire
 * the Managed adapter; the M2 onboarding fixture produces a
 * byte-identical emit sequence + phase transitions before and after.
 *
 * Spec-conformance audit (5-line diff from the sprint brief):
 *
 *     SPEC § 9 / § A of Atlas O/M doc says: core code must NOT
 *     import Managed-specific modules; the adapter is the seam.
 *     CURRENT WIRING does: core modules directly import from
 *     the provisioning module, proxy/, identity/, signup/, etc.
 *     GAP: every direct import is a violation of the Open/Managed
 *     split (per Atlas O/M doc § 2 + § A).
 *     THIS SPRINT FIXES: introduces this interface; inverts every
 *     direct import via the adapter; ships LocalPlatformAdapter
 *     (Open stub) + ManagedPlatformAdapter (current behavior).
 *     EXPLICITLY OUT OF SCOPE: physical repo split (Sprint C),
 *     publishing @neutronai/core-sdk (Sprint E), check-open-purity
 *     lint (Sprint F).
 */

import type {
  SlugAvailability,
  SlugHistoryProbe,
  SlugRegistryProbe,
} from './slug-grammar.ts'
import type { OnboardingPhase } from '../onboarding/interview/phase.ts'
import type {
  ClaimStartTokenJtiFn,
  VerifyStartTokenFn,
} from './start-token-types.ts'
import type { ConnectApiBundle } from './connect-handlers.ts'

/**
 * Thrown by `LocalPlatformAdapter` when Open invokes a Managed-only
 * platform operation (slug rename, install-token mint, OAuth handoff,
 * cross-instance fan-out, manager-bot provisioning, Caddy reload, sudoers
 * regenerate). The boot path uses the absence of these capabilities to
 * decide whether to mount the slug-picker / multi-sub / invite-accept
 * surfaces — see the M2 onboarding spec for the phase-by-phase contract.
 *
 * Production code should NEVER catch + swallow this — it surfaces a
 * structural misconfiguration (the wrong adapter was wired). The
 * intended pattern: the boot shell asks `platform.capabilities.X` BEFORE
 * invoking the operation; the unsupported error is only thrown when a
 * caller bypasses that check, which is itself a bug.
 */
export class PlatformOperationUnsupportedError extends Error {
  readonly code = 'PLATFORM_OP_UNSUPPORTED'
  readonly operation: string

  constructor(operation: string, message?: string) {
    super(
      message ??
        `PlatformAdapter operation '${operation}' is not supported on this platform tier (Open single-owner)`,
    )
    this.name = 'PlatformOperationUnsupportedError'
    this.operation = operation
  }
}

/**
 * Structural subset of `OwnersRegistry.OwnerRow` that Open callers
 * actually consume. Both `LocalPlatformAdapter` and
 * `ManagedPlatformAdapter` return this shape so Open code never sees
 * the full Managed registry row type.
 */
export interface PlatformInstanceInfo {
  internal_handle: string
  url_slug: string
  owner_home: string
  agent_name: string | null
  /** Open: always 'open'. Managed: 'managed-shared' | 'managed-dedicated'. */
  tier: string
  /** Open: 'user' (the single local user). Managed: 'user' | 'workspace'. */
  kind: string
}

/**
 * Slug-availability probe surface — narrow seam used by the interview
 * engine to compute candidate slug suggestions during the `slug_chosen`
 * phase WITHOUT importing the provisioning module's slug-availability helper.
 *
 * - `check(...)` returns `{available, reason}`.
 *   Open: always `{available:true, reason:null}` for grammar-legal
 *   slugs; `{available:false, reason:'invalid_format'}` otherwise. There
 *   are no other instances to collide against in Open, no slug-history,
 *   no reserved set.
 *   Managed: delegates to `checkSlugAvailability` against the live
 *   registry / slug-history / merged reserved-set.
 *
 * - `sanitize(...)` is pure on both tiers (delegates to
 *   `runtime/slug-grammar.ts:sanitizeToSlug`).
 */
export interface SlugAvailabilityProbe {
  check(input: {
    slug: string
    selfInternalHandle?: string
  }): SlugAvailability
  sanitize(input: string): string | null
}

/**
 * Rename-orchestrator inputs (Managed-only). The full type lives in
 * The rename orchestrator in the provisioning module
 * (`rename-url-slug.ts:RenameOrchestratorDeps`); the adapter's
 * `renameSlug` accepts a structural subset so Open code can type-check
 * without importing the Managed module.
 *
 * Open: `LocalPlatformAdapter.renameSlug` throws
 * `PlatformOperationUnsupportedError('renameSlug')` — single-instance
 * Open has no slug to rename to.
 *
 * Managed: delegates to `renameUrlSlug` with the per-instance gateway
 * restart driver wired through the chat-bridge slug-picker hook.
 */
export interface RenameSlugInput {
  internal_handle: string
  current_url_slug: string
  new_url_slug: string
}

export interface RenameSlugResult {
  status: 'committed' | 'rejected'
  /** Set when `status === 'rejected'`. */
  reason?: 'cas_mismatch' | 'taken' | 'invalid_format' | 'reserved' | 'in_history'
}

/**
 * Install-token mint surface (Managed-only). The Managed install-token
 * flow runs through `landing/install-token-routes.ts` → `signup/
 * start-token.ts` against the hosted auth service.
 *
 * Open: throws `PlatformOperationUnsupportedError('mintInstallToken')`.
 * A self-hosted single-instance box has no hosted auth
 * service to mint against and no install-token landing page.
 */
export interface InstallTokenInput {
  /** Frozen internal_handle of the instance the token is being minted for. */
  internal_handle: string
  /** OAuth identity of the requesting user (email, sub, provider). */
  identity: {
    provider: 'google' | 'apple'
    sub: string
    email: string
  }
  /** Audience claim — typically the per-instance subdomain. */
  audience: string
  /** Token lifetime in seconds. */
  ttl_s: number
}

export interface InstallTokenResult {
  token: string
  jti: string
  expires_at_s: number
}

/**
 * OAuth handoff surface — the per-instance Claude-Code OAuth handshake
 * that completes after the post-OAuth start-token redirect.
 *
 * Open: the per-instance Claude-Code OAuth flow works on Open via the
 * user's own Anthropic Max subscription. `LocalPlatformAdapter` runs
 * the standard OAuth handshake locally. Managed: delegates to the
 * existing `identity/oauth/max-handoff.ts:handleMaxHandoff` flow.
 */
export interface OAuthHandoffInput {
  provider: 'anthropic-max' | 'google' | 'apple'
  code: string
  redirect_uri: string
  pkce_verifier?: string
}

export interface OAuthHandoffResult {
  refresh_token: string
  access_token: string
  expires_at_s: number
  identity: {
    sub: string
    email: string
  }
}

/**
 * Cross-instance fan-out call surface (Managed-only). Used by the
 * workspace ↔ owner origin-tagged HTTPS API when a workspace-project
 * reply needs to be broadcast to the members' personal instances.
 * The full type lives in `connect/api/`.
 *
 * Open: throws — there are no other instances to fan out to.
 */
export interface ConnectCallInput {
  // NOTE: `target_instance_slug` / `workspace_instance_slug` are connect WIRE
  // origin-tag fields carried by the Managed concrete; Open never populates
  // them. Mirrored verbatim to stay wire-compatible with the Managed
  // origin-tag producer.
  target_instance_slug: string
  origin_tag: {
    workspace_instance_slug: string
    project_id: string
  }
  endpoint: string
  body: unknown
}

export interface ConnectCallResult {
  status: number
  body: unknown
}

/**
 * Manager-bot provisioning surface (Telegram, Managed-only). Auto-
 * registers a per-instance Telegram bot via Bot API 9.6's `registerBot`
 * primitive. Open users register their own bot with BotFather; this
 * operation is Managed-tier orchestration.
 */
export interface ProvisionManagerBotInput {
  internal_handle: string
  bot_name_hint: string
}

export interface ProvisionManagerBotResult {
  bot_token: string
  bot_username: string
}

/**
 * Sprint B (2026-05-20) — narrow structural alias for the Managed
 * `OwnersRegistry` lookup chat-bridge uses to resolve an instance's
 * CURRENT `url_slug` by frozen `internal_handle`. The Managed concrete
 * `OwnersRegistry` structurally satisfies this alias; Open boot
 * supplies a stub that returns the single local instance's slug for the
 * boot-time handle and null otherwise.
 *
 * Captured here (rather than in chat-bridge) so any cores-side caller
 * that needs the same narrow contract can import from `runtime/`
 * directly.
 */
export interface OwnerRegistryLookup {
  /**
   * Returns the CURRENT `url_slug` for the given `internal_handle`, or
   * null when the instance row is missing. Hot-path: every JWT-mismatch
   * connect runs this once; backing store is a single indexed SQLite
   * SELECT on Managed and a constant-time check on Open.
   */
  getCurrentUrlSlugByInternalHandle(internal_handle: string): string | null
}

/**
 * Sprint B (2026-05-20) — structural alias for the per-instance gateway
 * refresh driver the slug-rename orchestrator invokes after the
 * registry / Caddy / identity steps commit. Lifted out of the
 * provisioning module's `rename-url-slug` so the chat-bridge slug-
 * picker hook can hold a typed reference without importing the
 * Managed rename module.
 */
export interface GatewayRestartDriver {
  refreshAfterRename(input: {
    internal_handle: string
    owner_home: string
    new_url_slug: string
    previous_url_slug: string
  }): Promise<{
    file_written: boolean
    restart_status: 'success' | 'skipped' | 'failed'
  }>
}

/**
 * Sprint B (2026-05-20) — structural alias for the rename orchestrator
 * dep bag chat-bridge's slug-picker engine hook flows through. The
 * Managed concrete `RenameOrchestratorDeps`
 * (the provisioning module's `rename-url-slug`) structurally satisfies
 * this alias; the chat-bridge composes the no-restart gateway driver
 * over it and passes the result to `processSlugPickerReply`.
 *
 * Fields use `unknown` for the registry / slug-history / Caddy /
 * identity / Telegram sub-shapes the orchestrator owns internally —
 * chat-bridge only threads the bundle through and does not inspect
 * those sub-shapes.
 */
export interface RenameOrchestratorDeps {
  registry: {
    getByInternalHandle(handle: string): unknown
    [key: string]: unknown
  }
  slugHistory: unknown
  reservedSlugs?: ReadonlySet<string>
  gatewayRestart?: GatewayRestartDriver
  caddy?: unknown
  identitySync?: unknown
  telegramAnnounce?: unknown
  [key: string]: unknown
}

/**
 * Sprint B (2026-05-20) — structural alias for the per-request context
 * the Managed `/recover/<jti>` handler consumes. Captured here so the
 * platform adapter's `recoverSignupRequest?` method does not leak
 * Managed concrete types (identity DB handle + KeyManager + JTI store)
 * into core-side callers.
 */
export interface RecoverRequestContext {
  /** Resolves the public key for a given JWT `kid`. */
  resolveKey: (kid: string) => Promise<unknown>
  /** Returns the CURRENT `url_slug` for this instance given a platform user_id. */
  lookupCurrentOwnerSlug: (user_id: string) => string | null
  /** Returns the active signing key (kid + privateKey). */
  getSigningKey: () => Promise<{ kid: string; privateKey: unknown }>
  /** Structured-log tag. */
  log_tag?: string
}

/**
 * Capability flags exposed by the adapter. Boot shells / composer hooks
 * inspect these to decide whether to mount Managed-only HTTP surfaces
 * (slug-check API, install-token landing routes, invite-accept page,
 * workspace promotion API, etc.).
 *
 * The flags are intentionally fine-grained instead of one
 * `supportsManaged: boolean` so a future Open variant that opts into
 * (say) embedded multi-instance slug-availability can flip a single flag
 * without inheriting the entire Managed surface.
 */
export interface PlatformCapabilities {
  /** Slug rename + slug-picker UX. Open: false. Managed: true. */
  readonly slug_rename: boolean
  /** Install-token landing page + start-token mint. Open: false. */
  readonly install_token_mint: boolean
  /** Cross-instance fan-out + origin-tag HTTPS API. Open: false. */
  readonly connect_fanout: boolean
  /** Per-instance manager-bot provisioning (Telegram). Open: false. */
  readonly manager_bot_provisioning: boolean
  /** Caddy reverse-proxy reload after instance route changes. Open: false. */
  readonly caddy_reload: boolean
  /** Sudoers regeneration for per-instance systemd permissions. Open: false. */
  readonly sudoers_regenerate: boolean
  /**
   * Tier 2 (`@neutron-paid/*`) bundled Cores discoverable at boot. Open:
   * false (only the public `cores/free/` tree is walked). Managed: false
   * for Sprint B's `runtime/`-resident shim and the entire P3 sprint
   * (the public `<repoRoot>` is the only root); flips to true in
   * Sprint C when the physical repo split lands and the Managed
   * adapter starts returning `[<publicRoot>, <managedPrivateRoot>]`
   * from `getBundledCoreRoots()`.
   *
   * The flag is informational only this sprint — no boot path branches
   * on it. It exists so a future ops dashboard / boot log can surface
   * "Tier 2 enabled" vs "Tier 1 only" without re-deriving the answer
   * from the multi-root array's length.
   */
  readonly tier_two_cores: boolean
  /**
   * P7.4 Phase 2 — per-project remote backup sync supported on this
   * adapter. Open: true (the admin UI exposes a "Connect remote" form;
   * the user MAY skip and have local-backup-only). Managed: true when
   * the lazy-provisioning hook is wired.
   *
   * When false, the admin UI's Backup tab still surfaces local-backup
   * status but hides the "Connect remote" / "Run backup now" actions
   * that depend on remote orchestration.
   */
  readonly project_backup: boolean
  /**
   * Sprint B (2026-05-20) — `/recover/<jti>` signup-recover HTTP handler
   * is wired. Open: false (Open self-hosted boxes do not run the
   * start-token signup flow; the route is unmounted). Managed: true iff
   * the boot shell wired `recoverSignupRequest`.
   */
  readonly signup_recover: boolean
  /**
   * Sprint B (2026-05-20) — start-token verifier + atomic JTI claimer
   * pair is wired. Open: false (no start-token issuance, nothing to
   * verify). Managed: true iff BOTH `verifyStartToken` AND
   * `claimStartTokenJti` are wired.
   */
  readonly start_token_verify: boolean
  /**
   * Sprint B (2026-05-20) — Cores OAuth internal-signature HMAC pair
   * wired. Open: false (no identity service to handshake with).
   * Managed: true iff BOTH `signInternalRequest` AND
   * `verifyInternalRequest` are wired.
   */
  readonly internal_signature: boolean
  /**
   * Sprint B (2026-05-20) — instance ↔ instance connect API
   * handler bundle is wired. Open: false (Open is single-instance; no
   * fan-out target, no inbound origin-tagged calls). Managed: true iff
   * `connectApiHandlers` is wired.
   */
  readonly connect_api: boolean
}

/**
 * The PlatformAdapter interface. Wired into `gateway/composition.ts` via
 * the optional `CompositionInput.platform` field; boot shells construct
 * the appropriate adapter (Local on Open self-hosted boxes; Managed on
 * the hosted VPS) before composing.
 *
 * **Why these methods**: lifted from the Atlas O/M doc § 2.4.2
 * dependency-inversion sketch + § A repo-structure layout. Each method
 * corresponds to one of the cross-cutting Managed-only operations that
 * core code currently invokes via direct import. The Managed adapter
 * delegates; the Local adapter throws (or stubs to a no-op when the
 * operation is semantically degenerate on a single-instance box).
 *
 * Open vs Managed semantics are documented per-method below. Forge:
 * never add a method here without updating BOTH adapters in the same
 * commit, and without updating the M2 byte-identical-emit fixture.
 */
export interface PlatformAdapter {
  /**
   * Capability flags — read-only. Boot shells inspect these before
   * invoking Managed-only operations so the slug-picker / multi-sub /
   * install-token routes only mount on tiers that support them.
   */
  readonly capabilities: PlatformCapabilities

  /**
   * Slug grammar + availability probe. ALWAYS present (both tiers); the
   * Local probe returns `{available:true}` for every grammar-legal slug,
   * which is the correct answer on a single-instance box.
   *
   * Open semantics: no real conflict surface; the grammar check still
   * runs so a user typing 'admin' in a hypothetical local slug-picker
   * still gets `invalid_format` (it's not a grammar-legal slug if the
   * reserved set were merged, but on Open the reserved set is empty —
   * the grammar regex `[a-z][a-z0-9-]{2,30}` is still enforced).
   *
   * Managed semantics: delegates to `checkSlugAvailability` against the
   * live `OwnersRegistry` + `SlugHistoryStore` + merged reserved-set.
   */
  readonly slugAvailability: SlugAvailabilityProbe

  /**
   * Look up an instance by current `url_slug`.
   *
   * Open: returns the single local instance when `url_slug` matches the
   * locally-configured slug (or `null` otherwise). The local instance is
   * configured at boot from `NEUTRON_INSTANCE_SLUG` or a sensible default.
   *
   * Managed: delegates to `OwnersRegistry.getBySlug(...)`.
   */
  resolveOwnerBySlug(url_slug: string): PlatformInstanceInfo | null

  /**
   * Look up an instance by frozen `internal_handle`.
   *
   * Open: same single-instance lookup logic as `resolveOwnerBySlug`.
   * Managed: delegates to `OwnersRegistry.getByInternalHandle(...)`.
   */
  resolveOwnerByInternalHandle(internal_handle: string): PlatformInstanceInfo | null

  /**
   * Slug rename orchestrator — Managed-only.
   *
   * Open: throws `PlatformOperationUnsupportedError('renameSlug')`.
   *
   * Managed: delegates to `renameUrlSlug` (driver chain: registry CAS
   * → slug-history → Caddy reload → identity sync → Telegram
   * announcement → gateway refresh).
   */
  renameSlug(input: RenameSlugInput): Promise<RenameSlugResult>

  /**
   * Install-token mint — Managed-only.
   *
   * Open: throws `PlatformOperationUnsupportedError('mintInstallToken')`.
   * The Open self-hosted install path uses a direct `bun start`; there
   * is no hosted auth-service start-token landing handoff.
   *
   * Managed: delegates to the `signup/start-token.ts:mintStartToken`
   * + `landing/install-token-routes.ts` chain.
   */
  mintInstallToken(input: InstallTokenInput): Promise<InstallTokenResult>

  /**
   * OAuth handoff — both tiers, semantically different.
   *
   * Open: runs the standard Anthropic Max OAuth handshake locally (the
   * user's own developer account; no platform-side identity broker).
   *
   * Managed: delegates to the `identity/oauth/max-handoff.ts` chain,
   * which writes the resulting tokens to the instance's credential pool
   * via the per-instance systemd unit's drop-in.
   */
  oauthHandoff(input: OAuthHandoffInput): Promise<OAuthHandoffResult>

  /**
   * Cross-instance fan-out call — Managed-only.
   *
   * Open: throws `PlatformOperationUnsupportedError('connectCall')`.
   *
   * Managed: delegates to the instance ↔ instance origin-tagged HTTPS API
   * in `connect/api/`.
   */
  connectCall(input: ConnectCallInput): Promise<ConnectCallResult>

  /**
   * Per-instance Telegram bot provisioning — Managed-only.
   *
   * Open: throws `PlatformOperationUnsupportedError('provisionManagerBot')`.
   * Open users register their own bot with BotFather and configure the
   * token via `.env`.
   *
   * Managed: delegates to the Bot API 9.6 `registerBot` orchestration
   * in `channels/adapters/telegram/`.
   */
  provisionManagerBot(input: ProvisionManagerBotInput): Promise<ProvisionManagerBotResult>

  /**
   * Caddy reverse-proxy reload after an instance route change — Managed-only.
   *
   * Open: throws `PlatformOperationUnsupportedError('reloadCaddy')`.
   * Open self-hosted boxes do not run a Caddy fronting layer (or, if
   * the user opts into a personal reverse proxy, they manage it
   * themselves).
   *
   * Managed: delegates to `proxy/caddy-admin.ts:reloadConfig`.
   */
  reloadCaddy(): Promise<void>

  /**
   * Regenerate the sudoers drop-in that grants per-instance systemd
   * permissions — Managed-only.
   *
   * Open: throws `PlatformOperationUnsupportedError('regenerateSudoers')`.
   * Open self-hosted boxes do not run per-instance systemd units; the
   * user's own dev process supervises itself.
   *
   * Managed: delegates to `scripts/install/render-sudoers.sh`.
   */
  regenerateSudoers(): Promise<void>

  /**
   * Absolute repo roots the bundled-Cores registry walks at boot. The
   * `cores/<container>/<core>/` layout under each root is what
   * `buildBundledRegistry({ rootDir })` consumes; per
   * `cores/runtime/bundled-registry.ts` header the API accepts a
   * one-element array on both tiers today, and the second element
   * lights up on Managed when the Sprint C repo split lands.
   *
   * Open semantics: `[<publicRoot>]` — the local Neutron repo. Tier 2
   * `@neutron-paid/*` Cores are not installable.
   *
   * Managed semantics: `[<publicRoot>]` for Sprint B + the P3 sprint
   * (the `vendor/neutron/` submodule eventually becomes the public
   * root). The constructor accepts an optional `managedPrivateRoot`
   * that, when supplied, expands the array to `[<publicRoot>,
   * <managedPrivateRoot>]` so Tier 2 paid Cores merge into the same
   * registry view.
   *
   * Per `docs/research/neutron-cores-marketplace-split-2026-05-17.md
   * § 3` (multi-root registry shape).
   */
  getBundledCoreRoots(): readonly string[]

  /**
   * P7.4 Phase 2 — per-project project-level backup remote config.
   * Returns `null` when no remote is configured (Open before the user
   * wires one; Managed before lazy-provisioning runs).
   *
   * Open: reads `<project_root>/.project-backup-remote.json`.
   * Managed: same file (auto-populated by the lazy-provisioning hook
   * exposed via `autoProvisionProjectBackupRemote`).
   */
  getProjectBackupRemoteConfig(
    project_id: string,
  ): Promise<ProjectBackupRemoteConfig | null>

  /**
   * P7.4 Phase 2 — set a per-project remote backup config. Open-only.
   *
   * Managed throws `PlatformOperationUnsupportedError(
   * 'setProjectBackupRemoteConfig')` — Managed remotes are
   * auto-provisioned via `autoProvisionProjectBackupRemote` and are
   * not user-editable.
   */
  setProjectBackupRemoteConfig(
    project_id: string,
    input: SetProjectBackupRemoteConfigInput,
  ): Promise<ProjectBackupRemoteConfig>

  /**
   * P7.4 Phase 2 — clear a project's remote backup config. Open-only.
   *
   * Deletes both the JSON config file AND the per-project SSH private
   * key file so a future re-`setProjectBackupRemoteConfig` doesn't
   * reuse a stale key bound to a remote the user no longer controls.
   *
   * Managed throws `PlatformOperationUnsupportedError(
   * 'clearProjectBackupRemoteConfig')`.
   */
  clearProjectBackupRemoteConfig(project_id: string): Promise<void>

  /**
   * P7.4 Phase 2 — generate a fresh ED25519 keypair and stage it for
   * an upcoming `setProjectBackupRemoteConfig` call. Returns the
   * public key for the user to register on the remote (GitHub deploy
   * key, GitLab project SSH key, etc.) along with a `request_id` the
   * caller threads back into `setProjectBackupRemoteConfig` instead
   * of `ssh_key_pem`.
   *
   * Open-only. Managed throws.
   */
  generateProjectBackupKeypair(
    project_id: string,
  ): Promise<GenerateProjectBackupKeypairResult>

  /**
   * P7.4 Phase 2 — Managed-only lazy provisioning hook. When wired,
   * `ProjectBackupStore.backupNow` invokes this at first backup
   * (when `getProjectBackupRemoteConfig` returns `null`) to create
   * the per-project GitHub repo + deploy key + per-project SSH key
   * on disk.
   *
   * Open: undefined (the property exists on the interface but the
   * Local adapter does not implement it).
   *
   * Managed: present when the boot shell wires the provisioning hook.
   */
  autoProvisionProjectBackupRemote?: (
    project_id: string,
  ) => Promise<ProjectBackupRemoteConfig>

  // ──────────────────────────────────────────────────────────────────
  // Sprint B (2026-05-20) — optional Managed-only delegations added
  // as part of the PlatformAdapter inversion of every direct Managed-
  // import in core. Each method maps 1:1 to a Managed primitive the
  // boot shell wires through `ManagedPlatformAdapterInput`; Open boot
  // leaves them undefined and `capabilities.<X>` stays false.
  // ──────────────────────────────────────────────────────────────────

  /**
   * Sprint B — Managed-only `/recover/<jti>` signup-recover handler.
   *
   * Open: undefined. Open self-hosted boxes do not run the start-token
   * signup flow (no hosted auth service to mint against), so the
   * recover route is unmounted entirely.
   *
   * Managed: present when the boot shell wires
   * `signup/recover-handler.ts:handleRecover` against the identity
   * DB read handle + KeyManager + JTI store. The `RecoverRequestContext`
   * is a structural alias (above) so the adapter does not leak
   * Managed concrete types.
   */
  recoverSignupRequest?: (
    req: Request,
    ctx: RecoverRequestContext,
  ) => Promise<Response>

  /**
   * Sprint B — Managed-only start-token verifier. Returns the verified
   * payload on success or throws `StartTokenError` on failure (the
   * Managed implementation in `signup/start-token.ts` defines the
   * `StartTokenError` class; callers that need to discriminate failure
   * reasons should still import `StartTokenError` from there).
   *
   * Open: undefined. No start-token issuance, nothing to verify.
   * Managed: present when the boot shell wires `verifyStartToken` from
   * `signup/start-token.ts`.
   */
  verifyStartToken?: VerifyStartTokenFn

  /**
   * Sprint B — Managed-only atomic JTI claim. Pairs with
   * `verifyStartToken` for callers that need verify-then-side-effect-
   * then-claim ordering (the chat-bridge's `startSession` for the web
   * landing path is the canonical caller).
   *
   * Open: undefined. Managed: present when the boot shell wires
   * `claimStartTokenJti` from `signup/start-token.ts`.
   */
  claimStartTokenJti?: ClaimStartTokenJtiFn

  /**
   * Sprint B — Managed-only HMAC sign helper for the identity →
   * per-instance gateway internal handoff (the Cores OAuth
   * `/register` / `/ingest` chain in particular).
   *
   * Open: undefined. Managed: present when the boot shell wires
   * `runtime/internal-signature.ts:signInternalRequest`.
   */
  signInternalRequest?: (
    input: import('./internal-signature.ts').SignInternalRequestInput,
  ) => string

  /**
   * Sprint B — Managed-only HMAC verify helper, the inverse of
   * `signInternalRequest`. Returns the discriminated verification
   * result so callers can branch on the rejection reason.
   *
   * Open: undefined. Managed: present when the boot shell wires
   * `runtime/internal-signature.ts:verifyInternalRequest`.
   */
  verifyInternalRequest?: (
    input: import('./internal-signature.ts').VerifyInternalRequestInput,
  ) => import('./internal-signature.ts').VerifyInternalRequestResult

  /**
   * Sprint B — Managed-only instance ↔ instance connect API
   * handler bundle. The composer mounts the surface on the per-instance
   * HTTP listener when this returns a non-null bundle; otherwise the
   * surface stays unmounted.
   *
   * Open: undefined (Open is single-instance; no fan-out target).
   * Managed: present when the boot shell wires the bundle from
   * `connect/api/server.ts:buildHandlers` +
   * `connect/api/handlers/on-inbound-message.ts`.
   */
  connectApiHandlers?: () => ConnectApiBundle | null
}

// ────────────────────────────────────────────────────────────────────────
// Open-core vs Managed-extension surface split (audit §0 item 5 / Q5).
//
// `PlatformAdapter` (above) is the full contract both tiers satisfy. The two
// derived views below name the seam explicitly so the genuinely-unsupported
// surface is a typed unit rather than a scatter of throw-stubs:
//
//   - `OpenPlatformAdapter`      — every method has real single-instance
//                                  behavior; this is what `LocalPlatformAdapter`
//                                  implements with live logic.
//   - `ManagedPlatformExtension` — Managed-tier orchestrations. The required
//                                  ops throw `PlatformOperationUnsupportedError`
//                                  on Open (capability flag false); the optional
//                                  hooks are undefined on Open.
//
// Deriving them from `PlatformAdapter` (rather than re-declaring) keeps ONE
// source of truth for every signature — `PlatformAdapter` ≡ `OpenPlatformAdapter
// & ManagedPlatformExtension` by construction, so existing consumers + the
// Managed concrete are unaffected.
// ────────────────────────────────────────────────────────────────────────

/**
 * Required `PlatformAdapter` methods that are Managed-tier orchestrations.
 * `LocalPlatformAdapter` throws `PlatformOperationUnsupportedError` for each.
 */
export type ManagedOnlyPlatformOp =
  | 'renameSlug'
  | 'mintInstallToken'
  | 'connectCall'
  | 'provisionManagerBot'
  | 'reloadCaddy'
  | 'regenerateSudoers'

/**
 * Optional Managed-only hooks — present on the Managed adapter when the boot
 * shell wires them, left undefined on Open.
 */
export type ManagedOptionalPlatformHook =
  | 'autoProvisionProjectBackupRemote'
  | 'recoverSignupRequest'
  | 'verifyStartToken'
  | 'claimStartTokenJti'
  | 'signInternalRequest'
  | 'verifyInternalRequest'
  | 'connectApiHandlers'

/** The Managed-tier extension surface (unsupported / undefined on Open). */
export type ManagedPlatformExtension = Pick<
  PlatformAdapter,
  ManagedOnlyPlatformOp | ManagedOptionalPlatformHook
>

/** The Open-core surface: every method has real single-instance behavior. */
export type OpenPlatformAdapter = Omit<
  PlatformAdapter,
  ManagedOnlyPlatformOp | ManagedOptionalPlatformHook
>

/**
 * Per-project remote backup config. SSH-shape only in v1; HTTPS is
 * out of scope.
 */
export interface ProjectBackupRemoteConfig {
  /** Full git remote URL. Must match the SSH grammar
   *  `git@<host>:<owner>/<repo>(\.git)?`. */
  remote_url: string
  /** Absolute path to the SSH private key. Mode 0600. */
  ssh_key_path: string
  /** Provenance: `managed_provisioned` (lazy-provisioning) vs
   *  `user_connected` (Open admin UI). */
  source: 'managed_provisioned' | 'user_connected'
  /** Wall-clock ISO of when the remote was wired. */
  configured_at: string
}

/**
 * Input for `setProjectBackupRemoteConfig`. Either supply a PEM-encoded
 * private key directly (the "use an existing key" path), or commit a
 * previously-generated keypair by its `request_id` (the
 * "generate-then-register" two-call path).
 */
export interface SetProjectBackupRemoteConfigInput {
  remote_url: string
  /** Path A — full PEM-encoded SSH private key (ED25519 or RSA). */
  ssh_key_pem?: string
  /** Path B — `request_id` returned by `generateProjectBackupKeypair`. */
  generated_key_request_id?: string
}

/**
 * Result shape for `generateProjectBackupKeypair`. The caller surfaces
 * the public key in the UI for the user to register on the remote;
 * subsequent `setProjectBackupRemoteConfig` calls pass back the
 * `request_id`.
 */
export interface GenerateProjectBackupKeypairResult {
  request_id: string
  public_key: string
  expires_at_ms: number
}
