/**
 * @neutronai/migrations — single-owner DB-path resolution (L3 leaf).
 *
 * L3 (2026-07) — `resolveNeutronHome` + `resolveOpenDbPath` moved VERBATIM out
 * of `open/owner-identity.ts` into this contracts-band leaf so the migration
 * runner (`migrations/runner.ts`) no longer imports UP into the `open`
 * composition band (the `contracts-are-leaves` / `nobody-imports-composition`
 * violation this cut removes). `open/owner-identity.ts` re-exports both symbols
 * so the boot shell (`open/server.ts`) + composer specifiers stay valid
 * (test-policy §2.2 barrel rule).
 *
 * CRITICAL: the resolution PRECEDENCE + TIMING are unchanged — this is a pure
 * relocation of the function bodies, not a semantic change. `open/server.ts`
 * still calls `resolveOpenDbPath(env)` AFTER it fills `OWNER_HOME`, so the
 * env-mutation contract at open/server.ts is preserved.
 *
 * NEUTRON_HOME resolution follows docs/plans/project-folder-convention.md § 1.2.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

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
