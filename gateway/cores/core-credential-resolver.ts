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
 */

import type { OAuthTokenManager } from './oauth-token-manager.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
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

/** `account_id` for a manually-pasted `project_credentials` token. */
export const MANUAL_ACCOUNT_ID = 'manual' as const
/** `account_id` for a legacy un-keyed OAuth grant (pre-multi-account install). */
export const LEGACY_ACCOUNT_ID = 'default' as const

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
}

/**
 * The one seam every Core reads its credential through. Owns the D2 scope policy
 * and the `project_credentials` → OAuth-manager → unset fallback chain.
 */
export class CoreCredentialResolver {
  private readonly owner_slug: OwnerHandle
  private readonly store: ProjectCredentialStore
  private readonly oauthTokens: OAuthTokenManager | null

  constructor(input: CoreCredentialResolverInput) {
    this.owner_slug = input.owner_slug
    this.store = input.store
    this.oauthTokens = input.oauthTokens
  }

  /**
   * EVERY connected account for `service`, primary first, each carrying its own
   * lazy token accessor. Same resolution order as `resolve`; the active project
   * id is read from the ambient `runWithActiveProject` frame unless
   * `opts.projectId` overrides it. GLOBAL-scope services ignore it entirely.
   *
   * A per-project / global `project_credentials` row is a MANUALLY supplied
   * token for one account, so it yields exactly one account and short-circuits
   * the OAuth grants — the same precedence `resolve` has always had, just
   * expressed once.
   */
  async accountsFor(
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
