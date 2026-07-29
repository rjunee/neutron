/**
 * Production shared-projects resolver (M2.3).
 *
 * The app-side glue that wires the already-built cross-instance substrate
 * into the unified project list:
 *
 *   identity `memberships` table  ──┐
 *   workspace registry (slug→base_url) ─┼─→ workspace sources ─→ getUnifiedProjects
 *   identity KeyManager (signing)  ──┘                          │
 *                                                               ▼
 *                                              SharedProjectItem[] + source_errors
 *
 * Returns ONLY the shared (group) projects from the workspaces the user
 * belongs to; the app-projects surface owns the local-solo side and merges
 * the two. Solo projects are passed to `getUnifiedProjects` as an empty
 * list here on purpose.
 *
 * Graceful degradation is the contract: a workspace that's unreachable,
 * mid-provisioning, or whose token can't be minted is reported in
 * `source_errors` and omitted from `items` — the user still sees their
 * solo projects plus every healthy workspace. This mirrors § A.3.2's
 * "single list, no switcher" while never letting one bad workspace blank
 * the screen.
 *
 * Caching: two layers. `getUnifiedProjects` keeps a 30s per-(user,
 * base_url) cache of each workspace's raw response; on top of that this
 * resolver keeps a ~10s aggregate cache keyed by user_id so a burst of UI
 * re-renders collapses to one fan-out. `invalidate(user_id)` drops both —
 * the M2.4 invite-accept path calls it on a `workspace_members` change.
 */

import {
  getUnifiedProjects as defaultGetUnifiedProjects,
  ProjectListCache,
  type UnifiedProjectListResult,
} from '@neutronai/connect/unified-project-list.ts'
import { resolveSharedProjectSources } from '@neutronai/connect/shared-project-source-resolver.ts'
import {
  mintInstanceToken,
  type CrossInstanceActiveKey,
} from '@neutronai/connect/api/mint-instance-token.ts'
import type { Membership } from '@neutronai/jwt-validator/index.ts'
import type {
  SharedProjectItem,
  SharedProjectsResolver,
  SharedProjectsResult,
} from '@neutronai/gateway/http/app-projects-surface.ts'

/** ~10s aggregate cache — debounces UI re-render bursts. Distinct from the
 *  30s per-workspace cache inside `getUnifiedProjects`. */
export const AGGREGATE_CACHE_TTL_MS = 10_000

interface MembershipLister {
  list(userId: string): Promise<Membership[]>
}

/** Minimal structural shape of a workspace registry row — kept narrow so this
 *  module doesn't pull the full `OwnerRow` type onto its edge. */
export interface InstanceRegistryRow {
  kind: string
  status: string
  port: number | null
  subdomain: string
}

/**
 * Build the cross-instance API base URL for a workspace registry row.
 *   - Managed instances bind a loopback port → `http://127.0.0.1:<port>`
 *     (server-to-server stays on loopback, bypassing Caddy/TLS).
 *   - Port-less rows fall back to the public subdomain (dedicated/remote).
 * Returns `null` for non-workspace or non-active rows so the caller skips
 * them.
 */
export function buildInstanceBaseUrl(row: InstanceRegistryRow): string | null {
  if (row.kind !== 'workspace') return null
  if (row.status !== 'active') return null
  if (typeof row.port === 'number' && row.port > 0) {
    return `http://127.0.0.1:${row.port}`
  }
  if (typeof row.subdomain === 'string' && row.subdomain.length > 0) {
    return `https://${row.subdomain}`
  }
  return null
}

export interface SharedProjectsResolverDeps {
  /** This gateway's own (origin) slug. */
  user_instance_slug: string
  /** Identity-DB membership lookup (`new MembershipStore(identityDbRo)`). */
  membershipStore: MembershipLister
  /** Resolve a workspace slug → its registry row (or undefined). Typically
   *  `(slug) => ownersRegistry.getBySlug(slug)`. Managed mode only. */
  lookupInstance?: (slug: string) => InstanceRegistryRow | undefined
  /** Active EdDSA signing key (`() => keyManager.getActiveKey()`). Managed
   *  mode only — Open clients have no signing key. */
  getActiveKey?: () => Promise<CrossInstanceActiveKey>

  /**
   * M2.5 deployment mode. 'managed' (default) mints a per-workspace token
   * in-process via `getActiveKey`. 'open' uses a single federated multi-aud
   * JWT (`federatedToken`) for every workspace and resolves base URLs via
   * `openResolveBaseUrl`.
   */
  deployment_mode?: 'open' | 'managed'
  /**
   * Open mode: returns the current federated cross-instance JWT (or null when
   * not connected / no workspaces yet). Typically
   * `() => federatedTokenStore.getValidFederatedToken()`. The SAME multi-aud
   * token authorizes every workspace the user belongs to.
   */
  federatedToken?: () => Promise<string | null>
  /** Open mode: resolve a workspace slug → public cross-instance base URL. */
  openResolveBaseUrl?: (slug: string) => string | null

  // ---- test / reuse injection seams ----
  getUnifiedProjects?: typeof defaultGetUnifiedProjects
  /** 30s per-workspace cache reused across calls. */
  instanceCache?: ProjectListCache
  now?: () => number
}

interface AggregateEntry {
  result: SharedProjectsResult
  expires_at: number
}

export interface BuiltSharedProjectsResolver extends SharedProjectsResolver {
  /** Drop the aggregate + per-workspace caches for one user (or all when
   *  omitted). Called by M2.4 invite-accept on a membership change. */
  invalidate(user_id?: string): void
}

export function buildSharedProjectsResolver(
  deps: SharedProjectsResolverDeps,
): BuiltSharedProjectsResolver {
  const getUnified = deps.getUnifiedProjects ?? defaultGetUnifiedProjects
  const instanceCache = deps.instanceCache ?? new ProjectListCache()
  const nowFn = deps.now ?? (() => Date.now())
  const aggregate = new Map<string, AggregateEntry>()

  return {
    invalidate(user_id?: string): void {
      instanceCache.invalidate(user_id)
      if (user_id === undefined) {
        aggregate.clear()
        return
      }
      aggregate.delete(user_id)
    },

    async fetch(args: {
      user_id: string
      project_slug: string
    }): Promise<SharedProjectsResult> {
      const now = nowFn()
      const cached = aggregate.get(args.user_id)
      if (cached !== undefined && now < cached.expires_at) {
        return cached.result
      }

      const memberships = await deps.membershipStore.list(args.user_id)
      const openMode = deps.deployment_mode === 'open'

      // Origin slug stamped on the outbound origin header (see
      // jwt-bearer-middleware) on every outbound cross-instance fan-out
      // request (Argus r2 BLOCKER #2). The receiving workspace's
      // jwt-bearer middleware 403s `origin_not_a_member` unless this slug
      // is one of the federated JWT's `memberships`. Those memberships are
      // minted by the central identity service, which only knows the
      // CENTRAL-assigned user slug — NOT the local
      // self-host box slug (`deps.user_instance_slug`). On any real Open
      // deployment where local-slug ≠ central-slug, stamping the local slug
      // rejects every workspace request. Derive the origin from the
      // federated token's `kind:'user'` membership claim instead; fall back
      // to the local slug for Managed mode (where they're identical) or a
      // malformed token with no user membership.
      const originInstanceSlug = openMode
        ? (memberships.find((m) => m.kind === 'user')?.slug ?? deps.user_instance_slug)
        : deps.user_instance_slug

      // Token source. Managed: per-workspace in-process mint (captures THIS
      // fetch's user + memberships so concurrent fetches can't cross-mint).
      // Open: a single federated multi-aud JWT reused for every workspace.
      // Both return null on failure so the workspace degrades to
      // "unavailable" instead of failing the whole list.
      const mintToken = async (instanceSlug: string): Promise<string | null> => {
        if (openMode) {
          if (deps.federatedToken === undefined) return null
          try {
            return await deps.federatedToken()
          } catch {
            return null
          }
        }
        if (deps.getActiveKey === undefined) return null
        const getActiveKey = deps.getActiveKey
        try {
          const minted = await mintInstanceToken({
            getActiveKey,
            userId: args.user_id,
            memberships,
            targetInstanceSlug: instanceSlug,
            now,
          })
          return minted.token
        } catch {
          return null
        }
      }

      // Base-URL source. Managed: local registry row → loopback/subdomain.
      // Open: public cross-instance ingress via the env template / overrides.
      const resolveBaseUrl = (slug: string): string | null => {
        if (openMode) {
          return deps.openResolveBaseUrl?.(slug) ?? null
        }
        const row = deps.lookupInstance?.(slug)
        if (row === undefined) return null
        return buildInstanceBaseUrl(row)
      }

      const { sources, skipped } = await resolveSharedProjectSources({
        user_instance_slug: originInstanceSlug,
        memberships,
        resolveBaseUrl,
        mintToken,
      })

      let unified: UnifiedProjectListResult = { projects: [], source_errors: [] }
      if (sources.length > 0) {
        unified = await getUnified({
          user_instance_slug: originInstanceSlug,
          local_solo_projects: [],
          instance_sources: sources,
          cache: instanceCache,
          now: () => now,
        })
      }

      const items: SharedProjectItem[] = unified.projects.map((p) => ({
        project_id: p.project_id,
        display_name: p.display_name,
        owning_instance_slug: p.owning_instance_slug,
      }))
      // Boundary map: the connect wire surface now carries `instance_slug`
      // (R4 / P2-13 rename); the gateway↔app projects-surface HTTP contract still
      // uses `workspace_instance_slug` (a separate contract, owned by a later
      // tranche). Translate at this seam — connect input (RIGHT) → HTTP output (LEFT).
      const source_errors = [
        ...unified.source_errors.map((e) => ({
          workspace_instance_slug: e.instance_slug,
          error: e.error,
        })),
        ...skipped.map((s) => ({
          workspace_instance_slug: s.instance_slug,
          error: s.reason,
        })),
      ]

      const result: SharedProjectsResult = { items, source_errors }
      aggregate.set(args.user_id, { result, expires_at: now + AGGREGATE_CACHE_TTL_MS })
      return result
    },
  }
}
