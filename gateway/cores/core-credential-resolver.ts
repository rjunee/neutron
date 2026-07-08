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
 */

import type { OAuthTokenManager } from './oauth-token-manager.ts'
import type { ProjectCredentialStore } from '@neutronai/project-credentials/store.ts'
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

export interface CoreCredentialResolverInput {
  /** Server-derived owner boundary (the instance's `project_slug`). */
  owner_slug: string
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
  private readonly owner_slug: string
  private readonly store: ProjectCredentialStore
  private readonly oauthTokens: OAuthTokenManager | null

  constructor(input: CoreCredentialResolverInput) {
    this.owner_slug = input.owner_slug
    this.store = input.store
    this.oauthTokens = input.oauthTokens
  }

  /**
   * Resolve a plaintext credential for `service` against the active project
   * (per-project → global → legacy → unset). The active project id is read from
   * the ambient `runWithActiveProject` frame unless `opts.projectId` overrides it
   * (tests + call sites that already hold the id). GLOBAL-scope services ignore
   * the active project entirely.
   */
  async resolve(service: string, opts?: { projectId?: string }): Promise<string | null> {
    const scope = scopeForService(service)
    const activeProjectId = opts?.projectId ?? currentActiveProjectId()
    // GLOBAL-scope services (Email/Calendar) resolve instance-wide: force the
    // global sentinel so a stray per-project row can never shadow the shared grant.
    const effectiveProjectId = scope === 'global' ? '' : activeProjectId

    // 1. project_credentials — per-project → global (THE path).
    const resolved = this.store.resolve(this.owner_slug, effectiveProjectId, service)
    if (resolved !== null) return resolved.plaintext

    // 2. legacy Google OAuth backing store — the global default (transparent refresh).
    if (this.oauthTokens !== null && GOOGLE_OAUTH_LABELS.has(service)) {
      return await this.oauthTokens.getAccessToken(service)
    }

    // 3. unset.
    return null
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
