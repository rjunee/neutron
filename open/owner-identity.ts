/**
 * @neutronai/open — single-owner identity resolver (Sprint D).
 *
 * The `LocalPlatformAdapter` (`runtime/platform-adapter-local.ts`) is
 * constructed from a `PlatformInstanceInfo` row describing the single local
 * instance. Its file header explicitly defers building that row to this
 * sprint ("Sprint D … will land the resolver that builds this row from
 * NEUTRON_HOME + env defaults"). This module is that resolver.
 *
 * It maps the single-owner environment (`NEUTRON_HOME`,
 * `NEUTRON_INSTANCE_SLUG`, owner identity) onto the `PlatformInstanceInfo`
 * shape — NO registry, NO subdomain, NO provisioning. NEUTRON_HOME
 * resolution follows docs/plans/project-folder-convention.md § 1.2.
 */

import type { PlatformInstanceInfo } from '@neutronai/runtime/platform-adapter.ts'
import { resolveOwnerSlugSourceFromConfig } from '@neutronai/gateway/index.ts'

// `resolveNeutronHome` + `resolveOpenDbPath` moved to `../migrations/db-path.ts`
// (L3, 2026-07) so the `migrations` leaf no longer imports UP into `open`.
// Re-exported here so the boot shell + composer specifiers stay valid
// (test-policy §2.2 barrel rule). Resolution precedence + timing are unchanged.
export { resolveNeutronHome, resolveOpenDbPath } from '@neutronai/migrations/db-path.ts'

/**
 * The single owner's user id. The Open box has exactly one user; every
 * per-user store (onboarding state, web sender registry, session cookie)
 * keys on this constant.
 */
export const OWNER_USER_ID = 'owner'

/**
 * Resolve the owner's instance slug. Mirrors `gateway/index.ts`
 * `resolveOwnerSlugSourceFromConfig`'s env precedence (`NEUTRON_INSTANCE_SLUG`)
 * so the banner / self-instance row agree with the slug `boot()` freezes at
 * startup. Falls back to `'dev'` for a bare `bun run` — the same fallback the
 * boot shell uses.
 *
 * ⚠️ THIS DOCBLOCK PROMISES AGREEMENT, AND FOR A WHILE IT LIED. When boot
 * started trimming (an empty or whitespace `NEUTRON_INSTANCE_SLUG` is not an
 * identity), this copy kept `length > 0`, so `'   '` resolved to `'dev'` at
 * boot and to `'   '` here. `neutron doctor` then filtered events and jobs by a
 * slug nothing had written under and reported an empty instance — a diagnostic
 * that quietly lies about the system it is diagnosing.
 *
 * The two are pinned equal by `open/__tests__/owner-slug-agreement.test.ts`.
 * A second answer to "who am I" is not a second opinion, it is a bug waiting
 * for someone to trust the wrong one.
 */
export function resolveOwnerSlug(env: NodeJS.ProcessEnv = process.env): string {
  // DELEGATES to the one canonical resolver. Trimming here was not enough: this
  // copy also ignored `.url_slug` entirely, so with a renamed instance
  // (`.url_slug` = the new name, env still the old one) boot resolved the new
  // name and `neutron doctor` resolved the old — and then filtered events and
  // jobs by an identity nothing had written under.
  return resolveOwnerSlugSourceFromConfig({
    ownerHome: env['OWNER_HOME'],
    neutronHome: env['NEUTRON_HOME'],
    instanceSlug: env['NEUTRON_INSTANCE_SLUG'],
  } as unknown as Parameters<typeof resolveOwnerSlugSourceFromConfig>[0]).slug
}

/**
 * Build the single local instance's `PlatformInstanceInfo`. The boot shell
 * passes `project_slug` (the value `boot()` resolved + froze) so the
 * adapter's `url_slug` / `owner_handle` agree with every cookie / token
 * equality check downstream. On Open `owner_handle === url_slug` (there
 * is no rename machinery to make them diverge).
 */
export function resolveOpenInstanceInfo(input: {
  project_slug: string
  owner_home: string
  env?: NodeJS.ProcessEnv
}): PlatformInstanceInfo {
  const env = input.env ?? process.env
  const agentName = env['NEUTRON_AGENT_NAME']
  return {
    owner_handle: input.project_slug,
    url_slug: input.project_slug,
    owner_home: input.owner_home,
    agent_name: typeof agentName === 'string' && agentName.length > 0 ? agentName : null,
    tier: 'open',
    kind: 'user',
  }
}
