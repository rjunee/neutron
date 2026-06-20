/**
 * @neutronai/open — single-owner Open server entrypoint (Sprint D).
 *
 * The ignition for the public Open mirror: a fresh clone runs `bun start`
 * (root package.json `start` → this file) and gets the full onboarding +
 * chat product on a single port, NOT just `/healthz`.
 *
 * What it does:
 *   1. Resolves single-owner config (NEUTRON_HOME, owner slug) and fills the
 *      few env vars `boot()` + the composer expect when unset, so a bare
 *      `bun start` works out of the box.
 *   2. Builds the single-owner GraphComposer (`open/composer.ts`).
 *   3. Calls the shared `boot()` shell, which opens the HTTP listener (port
 *      from --port / NEUTRON_LISTEN_PORT / a free port), binds the composed
 *      onboarding + chat + WebSocket routes, seeds `/healthz`, and starts the
 *      watchdog.
 *   4. Prints a clear boot banner pointing at /chat.
 *
 * Managed superset safety: if `NEUTRON_GRAPH_COMPOSER_MODULE` is set (the
 * Managed deploy-config injection seam), this entrypoint DEFERS to that
 * composer instead of the Open one — so `bun start` is safe to run in a
 * Managed checkout too. Managed production normally execs
 * `gateway/index.ts` directly via systemd and never reaches here.
 */

import { randomBytes } from 'node:crypto'

import { boot, loadGraphComposerFromEnv, resolveOwnerSlug } from '../gateway/index.ts'
import type { BootHandle } from '../gateway/index.ts'

import { buildOpenGraphComposer } from './composer.ts'
import { resolveNeutronHome, resolveOpenDbPath } from './owner-identity.ts'

/**
 * Boot the single-owner Open server. Returns the live `BootHandle` so
 * embedded callers can drive + shut down the server in-process.
 *
 * Operates on `process.env` deliberately: the config it fills below (OWNER_HOME
 * / NEUTRON_DB_PATH / cookie secret) must be visible to `boot()`, which reads
 * `process.env` directly for the DB path, slug, host, and port. Taking a
 * divergent `env` arg here would silently desync those — `boot()` would still
 * open the default DB + slug (Codex r1 P2). Callers wanting isolation set the
 * env vars on `process.env` before calling, or boot the composer + `boot()`
 * themselves (see open/__tests__/open-boot-shell.test.ts).
 */
export async function startOpenServer(): Promise<BootHandle> {
  const env = process.env
  // Managed deploy-config injection wins — defer to the injected composer.
  const injected = await loadGraphComposerFromEnv(env)
  if (injected !== undefined) {
    return boot({ composer: injected })
  }

  const neutronHome = resolveNeutronHome(env)
  // Keep the gateway's data dir + the composer's owner_home in lockstep under
  // NEUTRON_HOME unless the operator pinned them explicitly.
  if (env['OWNER_HOME'] === undefined || env['OWNER_HOME'] === '') {
    env['OWNER_HOME'] = neutronHome
  }
  if (env['NEUTRON_DB_PATH'] === undefined || env['NEUTRON_DB_PATH'] === '') {
    env['NEUTRON_DB_PATH'] = resolveOpenDbPath(env)
  }
  if (
    env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] === undefined ||
    env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] === ''
  ) {
    env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = randomBytes(24).toString('hex')
    console.warn(
      '[open] NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET unset — generated an ephemeral ' +
        'secret; the owner session resets on restart. Set it in .env to persist sessions.',
    )
  }

  const composer = buildOpenGraphComposer({ env })
  const handle = await boot({ composer })

  const slug = resolveOwnerSlug(env)
  const host = env['NEUTRON_HOST'] ?? '127.0.0.1'
  const port = handle.server.port
  console.info('')
  console.info('  ┌─────────────────────────────────────────────────────────────')
  console.info('  │  Neutron — single-owner Open boot shell')
  console.info(`  │  owner=${slug}   NEUTRON_HOME=${neutronHome}`)
  console.info(`  │  listening on http://${host}:${port}`)
  console.info(`  │  onboarding + chat:  http://127.0.0.1:${port}/chat`)
  console.info(`  │  health:             http://127.0.0.1:${port}/healthz`)
  console.info('  └─────────────────────────────────────────────────────────────')
  console.info('')
  return handle
}

if (import.meta.main) {
  // Top-level await — Bun supports TLA in entry modules. An unhandled
  // rejection exits non-zero; under a process supervisor that becomes a
  // respawn. The Bun.serve listener + watchdog keep the event loop alive.
  await startOpenServer()
}
