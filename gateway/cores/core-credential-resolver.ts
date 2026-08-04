/**
 * @neutronai/gateway/cores — the CORE CREDENTIAL RESOLVER (D2 follow-up to #149,
 * 2026-07-01).
 *
 * #149 built the `project_credentials` store + its per-project → global → unset
 * `resolve(owner_slug, project_id, service)` resolver, but no Core consumed it —
 * the Cores still read Google OAuth tokens straight off the per-instance
 * `OAuthTokenManager`. THIS is the wiring: every Core's credential now resolves
 * through one seam, keyed by `(active project, service)`, with the per-project
 * store as THE path and the legacy OAuth manager as the global fallback.
 *
 * ── D2 per-credential granularity (the whole point) ────────────────────────────
 * The scope a service resolves at is a POLICY, not a flag:
 *   - Email + Calendar Google OAuth (`gmail_compose` / `google_calendar`) stay
 *     GLOBAL — routed through the resolver for uniform plumbing, but the active
 *     project id is IGNORED (scope forced to global) so there is no per-project
 *     re-consent and no regression to the working inbox/calendar.
 *   - A project's own Google Drive (`google_workspace`) + any static service
 *     token (Meta Ads, Google Ads, an Apify key, …) resolve PER-PROJECT → global:
 *     a project's pasted token wins; else the instance-wide default.
 *
 * ── Resolution order (per call) ────────────────────────────────────────────────
 *   1. `project_credentials` via `ProjectCredentialStore.resolve` — per-project
 *      (when the service's scope is 'project' and a project is active) → global.
 *   2. Legacy Google OAuth backing store — `OAuthTokenManager.getAccessToken`
 *      (transparent refresh) for the three Google labels, as the global default.
 *   3. `null` — uncredentialed (the Core renders its graceful empty state).
 *
 * ── MANY ACCOUNTS PER SERVICE ──────────────────────────────────────────────────
 * `accountsFor(service)` — not `resolve` — is the primitive. It returns EVERY
 * connected account for a service, each with its own lazy token accessor, so a
 * Core that reads (calendar, mail) can span all of them and tag what it found.
 * `resolve` is the same chain narrowed to the primary account, which is what a
 * write path and a single-account service want. Keeping one primitive means
 * "which accounts are connected" is answered in one place, and the resolution
 * ORDER above holds identically whether you ask for one account or all of them.
 *
 * ── PER-PROJECT ACCOUNT SELECTION (ISSUES #500) ────────────────────────────────
 * CONNECTING stays global — one consent, one refresh token, one thing to rotate.
 * SELECTION is per-project: `accountsFor` filters the connected set through
 * `project_account_selection` before returning it, so a work project can stop
 * sweeping a personal mailbox without disconnecting anything. Because this is
 * the primitive, every Core inherits it; no Core implements its own filter.
 * Rows are DISABLES, so an unconfigured project sees everything (unchanged
 * behaviour) and a newly connected account is visible in every project.
 */

import type { OAuthTokenManager } from './oauth-token-manager.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
import type { ProjectAccountSelectionStore } from '@neutronai/project-credentials/account-selection-store.ts'
import type { OwnerHandle } from '@neutronai/persistence/index.ts'
import { currentActiveProjectId } from './active-project-context.ts'

/**
 * A service's effective credential scope.
 *   - 'global'  — instance-wide; the active project id is ignored (Email/Calendar).
 *   - 'project' — per-project → global (Drive + static service tokens). Default.
 */
export type ServiceScope = 'global' | 'project'

/**
 * The three Google OAuth service labels are ALSO the `OAuthTokenManager` labels
 * (a Core exports its label as `OAUTH_SECRET_LABEL`), so `service === label` for
 * the legacy fallback. Any service not listed defaults to 'project' scope.
 */
export const SERVICE_SCOPE: Readonly<Record<string, ServiceScope>> = {
  google_calendar: 'global',
  gmail_compose: 'global',
  google_workspace: 'project',
}

/** Services backed by the legacy Google `OAuthTokenManager` (transparent refresh). */
const GOOGLE_OAUTH_LABELS: ReadonlySet<string> = new Set([
  'google_calendar',
  'gmail_compose',
  'google_workspace',
])

/** The effective scope for `service` (defaults to 'project' for static tokens). */
export function scopeForService(service: string): ServiceScope {
  return SERVICE_SCOPE[service] ?? 'project'
}

/**
 * The services a project can narrow its account selection over (#500) — the
 * services an owner can hold MORE THAN ONE account for. Ordered for display.
 * A single-account service has nothing to choose between, so listing it would
 * be a toggle whose only setting is "break this project".
 */
export const SELECTABLE_ACCOUNT_SERVICES: readonly string[] = [
  'google_calendar',
  'gmail_compose',
  'google_workspace',
]

/** `account_id` for a manually-pasted `project_credentials` token. */
export const MANUAL_ACCOUNT_ID = 'manual' as const
/** `account_id` for a legacy un-keyed OAuth grant (pre-multi-account install). */
export const LEGACY_ACCOUNT_ID = 'default' as const

/**
 * One account as the per-project Settings surface shows it: the id the toggle
 * addresses, a HUMANISED label (never the raw hex account key), and whether
 * this project currently reads it.
 */
export interface AccountSelectionEntry {
  account_id: string
  /** The address when known; a plain-English stand-in when it is not. */
  label: string
  account_email: string | null
  enabled: boolean
}

/** One selectable service and every account connected for it. */
export interface ServiceAccountSelection {
  service: string
  accounts: AccountSelectionEntry[]
}

/**
 * A humanised name for an account. `account_id` is a SHA-256 prefix
 * (`accountKeyFromEmail`), so it must never reach the owner's screen; the
 * address is what he recognises. The two id sentinels get plain English instead
 * of a digest: a legacy un-keyed grant predates account addresses, and a
 * manually-pasted token never had one.
 */
export function humaniseAccount(account: {
  account_id: string
  account_email: string | null
}): string {
  const email = (account.account_email ?? '').trim()
  if (email.length > 0) return email
  if (account.account_id === MANUAL_ACCOUNT_ID) return 'Pasted token'
  return 'Connected account'
}

/**
 * One connected account, as a Core consumes it: an id to tag results with, the
 * address to show the owner, and a lazy token accessor for THAT account.
 */
export interface ResolvedAccount {
  /** Stable id for this account within its service. Tags every returned item. */
  account_id: string
  /** Account address, when known. Null for a manually-pasted token. */
  account_email: string | null
  /** Resolve this account's access token. Throws on a failed refresh. */
  accessToken: () => Promise<string | null>
}

export interface CoreCredentialResolverInput {
  /**
   * Server-derived owner boundary — the FROZEN instance handle (branded
   * `OwnerHandle`). Constructed via `asOwnerHandle` at the resolution source;
   * a mutable `url_slug` is a compile error.
   */
  owner_slug: OwnerHandle
  /** The canonical per-project credential store (shared with the CRUD surface). */
  store: ProjectCredentialStore
  /**
   * The legacy per-instance Google OAuth manager (transparent refresh). Non-null
   * whenever the Cores OAuth client is configured; the resolver uses it as the
   * GLOBAL fallback for the three Google labels. Null on an OAuth-less box —
   * then only `project_credentials` can supply a token.
   */
  oauthTokens: OAuthTokenManager | null
  /**
   * The per-project connected-account SELECTION (ISSUES #500). Rows are
   * DISABLES, so an unconfigured project has none and sees every account —
   * the pre-#500 behaviour — and a newly connected account is visible
   * everywhere until a project explicitly turns it off.
   */
  accountSelection: ProjectAccountSelectionStore
}

/**
 * The one seam every Core reads its credential through. Owns the D2 scope policy
 * and the `project_credentials` → OAuth-manager → unset fallback chain.
 */
export class CoreCredentialResolver {
  private readonly owner_slug: OwnerHandle
  private readonly store: ProjectCredentialStore
  private readonly oauthTokens: OAuthTokenManager | null
  private readonly accountSelection: ProjectAccountSelectionStore

  constructor(input: CoreCredentialResolverInput) {
    this.owner_slug = input.owner_slug
    this.store = input.store
    this.oauthTokens = input.oauthTokens
    this.accountSelection = input.accountSelection
  }

  /**
   * EVERY connected account for `service` that THIS project reads, primary
   * first, each carrying its own lazy token accessor.
   *
   * Two different project questions are answered here, and conflating them is
   * the bug this shape exists to prevent:
   *
   *   1. WHICH CREDENTIAL STORE supplies the material — `connectedAccountsFor`
   *      below, governed by `SERVICE_SCOPE`. Email/Calendar are forced GLOBAL
   *      so a stray per-project row can never shadow the shared grant.
   *   2. WHICH OF THE CONNECTED ACCOUNTS this project may read — the filter
   *      here, governed by `project_account_selection`. This uses the REAL
   *      active project id even for GLOBAL-scope services, because
   *      Email/Calendar are precisely the services an owner connects several
   *      accounts to and wants narrowed per project. Forcing the global
   *      sentinel here would make the feature a no-op for the only services
   *      that need it.
   *
   * Enforced at THIS seam, not per-Core: `accountsFor` is the primitive every
   * Core reads through (`accountsResolverFor` wraps it, `resolve` narrows it),
   * so every consumer honours the selection automatically and none can drift.
   *
   * Unset means enabled — see `ProjectAccountSelectionStore`. A blank project id
   * (General topic, cron, system dispatch) has no selection and filters nothing.
   */
  async accountsFor(
    service: string,
    opts?: { projectId?: string },
  ): Promise<ResolvedAccount[]> {
    const accounts = await this.connectedAccountsFor(service, opts)
    const disabled = this.accountSelection.disabledAccountIds(
      this.owner_slug,
      opts?.projectId ?? currentActiveProjectId(),
      service,
    )
    return accounts.filter((account) => !disabled.has(account.account_id))
  }

  /**
   * The per-project Settings read model (#500): every SELECTABLE service, every
   * account connected for it, and whether `projectId` currently reads it.
   *
   * Built from the SAME `connectedAccountsFor` + `disabledAccountIds` pair
   * `accountsFor` filters with, so what the owner toggles is definitionally what
   * the Cores read — a second enumeration here is exactly how a settings screen
   * drifts from the behaviour it claims to control.
   *
   * A service with no connected account yields an empty `accounts` array rather
   * than being dropped, so the surface can say "nothing connected" for it
   * instead of silently omitting a service the owner is looking for.
   */
  async accountSelectionView(projectId: string): Promise<ServiceAccountSelection[]> {
    const out: ServiceAccountSelection[] = []
    for (const service of SELECTABLE_ACCOUNT_SERVICES) {
      const connected = await this.connectedAccountsFor(service, { projectId })
      const disabled = this.accountSelection.disabledAccountIds(
        this.owner_slug,
        projectId,
        service,
      )
      out.push({
        service,
        accounts: connected.map((account) => ({
          account_id: account.account_id,
          label: humaniseAccount(account),
          account_email: account.account_email,
          enabled: !disabled.has(account.account_id),
        })),
      })
    }
    return out
  }

  /**
   * Every account CONNECTED for `service`, before the per-project selection is
   * applied. The active project id is read from the ambient
   * `runWithActiveProject` frame unless `opts.projectId` overrides it;
   * GLOBAL-scope services ignore it entirely.
   *
   * A per-project / global `project_credentials` row is a MANUALLY supplied
   * token for one account, so it yields exactly one account and short-circuits
   * the OAuth grants — the same precedence `resolve` has always had, just
   * expressed once.
   */
  private async connectedAccountsFor(
    service: string,
    opts?: { projectId?: string },
  ): Promise<ResolvedAccount[]> {
    const scope = scopeForService(service)
    const activeProjectId = opts?.projectId ?? currentActiveProjectId()
    // GLOBAL-scope services (Email/Calendar) resolve instance-wide: force the
    // global sentinel so a stray per-project row can never shadow the shared grant.
    const effectiveProjectId = scope === 'global' ? '' : activeProjectId

    // 1. project_credentials — per-project → global (THE path).
    const resolved = this.store.resolve(this.owner_slug, effectiveProjectId, service)
    if (resolved !== null) {
      const plaintext = resolved.plaintext
      return [
        {
          account_id: MANUAL_ACCOUNT_ID,
          account_email: null,
          accessToken: async (): Promise<string | null> => plaintext,
        },
      ]
    }

    // 2. Google OAuth backing store — the global default (transparent refresh),
    //    fanned out over every account granted for this service.
    if (this.oauthTokens !== null && GOOGLE_OAUTH_LABELS.has(service)) {
      const tokens = this.oauthTokens
      const grants = await tokens.listGrants(service)
      return grants.map((grant) => ({
        // A legacy un-keyed grant has no account key; it is the only account of
        // its kind by construction, so a fixed id is unambiguous and stable.
        account_id: grant.account_key ?? LEGACY_ACCOUNT_ID,
        account_email: grant.email,
        accessToken: (): Promise<string> => tokens.getAccessToken(grant.label),
      }))
    }

    // 3. unset.
    return []
  }

  /**
   * Resolve a plaintext credential for `service` against the active project
   * (per-project → global → legacy → unset), narrowed to the PRIMARY account.
   * The write paths and single-account services use this.
   */
  async resolve(service: string, opts?: { projectId?: string }): Promise<string | null> {
    const accounts = await this.accountsFor(service, opts)
    const primary = accounts[0]
    if (primary === undefined) return null
    return await primary.accessToken()
  }

  /**
   * A lazy accounts resolver a fan-out Core client consumes verbatim. Read at
   * CALL time, so an account connected after boot joins the fan-out with no
   * restart — the multi-account counterpart of `accessorFor`. Fail-soft: any
   * error resolving the SET of accounts degrades to "nothing connected" rather
   * than throwing, exactly as `accessorFor` does. A failure to read one
   * account's TOKEN is a different thing and is surfaced per-account by the
   * fan-out client, never swallowed here.
   */
  accountsResolverFor(service: string): () => Promise<ResolvedAccount[]> {
    return async (): Promise<ResolvedAccount[]> => {
      try {
        return await this.accountsFor(service)
      } catch {
        return []
      }
    }
  }

  /**
   * A lazy `accessToken` closure a Core's REST client consumes verbatim. Reads
   * the active project from ambient context at CALL time (not build time), and
   * fail-soft returns null on any error so the Core degrades to "not connected"
   * rather than throwing — the exact contract the previous per-instance accessor
   * honored.
   */
  accessorFor(service: string): () => Promise<string | null> {
    return async (): Promise<string | null> => {
      try {
        return await this.resolve(service)
      } catch {
        return null
      }
    }
  }
}
