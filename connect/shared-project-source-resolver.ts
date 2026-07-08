/**
 * Shared-project source resolver (connect-spec §1.7).
 *
 * Turns the logged-in user's membership list into the
 * `UnifiedProjectListSource[]` that `getUnifiedProjects` fans out over. For each
 * shared-project membership it resolves the host instance's connect API base URL
 * and mints an outbound access bearer authorized for that host — the
 * `{ host base_url, access bearer }` source the live-connect session uses.
 *
 * Built on the Slack-Connect model (not the old replicate-everywhere mesh): a
 * shared project is single-hosted on the host's instance, so this resolves the
 * HOST to connect to, not a node to replicate from.
 *
 * Pure + fully injectable: `resolveBaseUrl` and `mintToken` are passed in so
 * this module has no static edge into the instance registry or the identity
 * KeyManager and is unit-testable with plain stubs. The production wiring
 * (`gateway/projects/shared-projects-resolver.ts`) feeds the real
 * `OwnersRegistry.getBySlug` + `mintInstanceToken`.
 *
 * Skips (rather than throws on) a host whose base URL can't be resolved or whose
 * token can't be minted — a single unhealthy or mid-provisioning host must never
 * blank the whole list. Skips are reported via `skipped` so the caller can
 * surface a non-blocking notice.
 */

import type { Membership } from '@neutronai/jwt-validator/index.ts'
import type { UnifiedProjectListSource } from './unified-project-list.ts'

export interface SharedProjectSourceResolverInput {
  /** The querying user instance slug. Hosts matching this are skipped
   *  (a user is never a cross-instance source of their own instance). */
  user_instance_slug: string
  /** The user's full membership list (from the identity DB). */
  memberships: ReadonlyArray<Membership>
  /** Resolve a host slug to its connect API base URL, or `null` if the host
   *  isn't reachable (not provisioned / archived). */
  resolveBaseUrl: (instanceSlug: string) => string | null
  /** Mint a bearer token for `aud=connect.<hostSlug>`, or `null` if minting
   *  fails (no active key, etc.). Async because signing is. */
  mintToken: (instanceSlug: string) => Promise<string | null>
}

export interface SharedProjectSourceResolution {
  sources: UnifiedProjectListSource[]
  /** Hosts that were members but couldn't be turned into a source, with the
   *  reason. Surfaced to the UI as "unavailable" without blocking the rest of
   *  the list. */
  skipped: Array<{ instance_slug: string; reason: 'no_base_url' | 'mint_failed' }>
}

export async function resolveSharedProjectSources(
  input: SharedProjectSourceResolverInput,
): Promise<SharedProjectSourceResolution> {
  const sources: UnifiedProjectListSource[] = []
  const skipped: SharedProjectSourceResolution['skipped'] = []

  const instanceSlugs = input.memberships
    .filter((m) => m.kind === 'workspace' && m.slug !== input.user_instance_slug)
    .map((m) => m.slug)
  // Dedup defensively — the identity table is PK'd on (user_id,
  // project_slug) so dupes shouldn't occur, but a belt-and-braces dedup
  // keeps the fan-out from double-minting on a malformed claim.
  const seen = new Set<string>()

  for (const slug of instanceSlugs) {
    if (seen.has(slug)) continue
    seen.add(slug)

    const base_url = input.resolveBaseUrl(slug)
    if (base_url === null || base_url.length === 0) {
      skipped.push({ instance_slug: slug, reason: 'no_base_url' })
      continue
    }
    const bearer_token = await input.mintToken(slug)
    if (bearer_token === null || bearer_token.length === 0) {
      skipped.push({ instance_slug: slug, reason: 'mint_failed' })
      continue
    }
    sources.push({ instance_slug: slug, base_url, bearer_token })
  }

  return { sources, skipped }
}
