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

import { homedir } from 'node:os'
import { join } from 'node:path'

import type { PlatformInstanceInfo } from '../runtime/platform-adapter.ts'

/**
 * The single owner's user id. The Open box has exactly one user; every
 * per-user store (onboarding state, web sender registry, session cookie)
 * keys on this constant.
 */
export const OWNER_USER_ID = 'owner'

/**
 * Resolve `<NEUTRON_HOME>` for a single-owner Open box. Per
 * docs/plans/project-folder-convention.md § 1.2 the OSS-local default is
 * `~/neutron/`:
 *   1. `NEUTRON_HOME` env wins verbatim.
 *   2. `OWNER_HOME` env (the per-instance data dir the gateway already
 *      honours) is the second choice.
 *   3. Otherwise `~/neutron/`.
 *
 * (A hosted deployment pins `NEUTRON_HOME` / `OWNER_HOME` explicitly via its
 * unit env, so the bare default only ever serves the OSS self-host case.)
 */
export function resolveNeutronHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['NEUTRON_HOME']
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const ownerHome = env['OWNER_HOME']
  if (typeof ownerHome === 'string' && ownerHome.length > 0) return ownerHome
  return join(homedir(), 'neutron')
}

/**
 * Resolve the single SQLite file the server opens — and therefore the exact DB
 * the migration runner must write:
 *   1. `NEUTRON_DB_PATH` env wins verbatim (Bun auto-loads `.env`, so a `.env`
 *      pin lands here too).
 *   2. otherwise `<NEUTRON_HOME>/project.db`.
 *
 * THE single source of DB-path resolution. `open/server.ts` (boot), the
 * `migrations/runner.ts` no-arg default, and `install.sh`'s documented
 * quickstart all funnel through this precedence so migrate writes precisely the
 * file the server later reads — a `.env` pin the installer ignored would
 * otherwise migrate a different database than the one that boots.
 */
export function resolveOpenDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const pinned = env['NEUTRON_DB_PATH']
  if (typeof pinned === 'string' && pinned.length > 0) return pinned
  return join(resolveNeutronHome(env), 'project.db')
}

/**
 * Resolve the owner's instance slug. Mirrors `gateway/index.ts`
 * `resolveOwnerSlug`'s env precedence (`NEUTRON_INSTANCE_SLUG`) so the
 * banner / self-instance row agree with the slug `boot()` freezes at
 * startup. Falls back to `'dev'` for a bare `bun run` — the same fallback
 * the boot shell uses.
 */
export function resolveOwnerSlug(env: NodeJS.ProcessEnv = process.env): string {
  const slug = env['NEUTRON_INSTANCE_SLUG']
  if (typeof slug === 'string' && slug.length > 0) return slug
  return 'dev'
}

/**
 * Build the single local instance's `PlatformInstanceInfo`. The boot shell
 * passes `project_slug` (the value `boot()` resolved + froze) so the
 * adapter's `url_slug` / `internal_handle` agree with every cookie / token
 * equality check downstream. On Open `internal_handle === url_slug` (there
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
    internal_handle: input.project_slug,
    url_slug: input.project_slug,
    owner_home: input.owner_home,
    agent_name: typeof agentName === 'string' && agentName.length > 0 ? agentName : null,
    tier: 'open',
    kind: 'user',
  }
}
