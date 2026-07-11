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
 *      from `--port` / the `NEUTRON_PORT` env var / a free port — see
 *      `gateway/boot-helpers.ts` `resolveListenPort`), binds the composed
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

import { boot, loadGraphComposerFromEnv, resolveOwnerSlugFromConfig } from '@neutronai/gateway/index.ts'
import type { BootHandle } from '@neutronai/gateway/index.ts'
import { resolveBootConfig, envShimFromBootConfig } from '@neutronai/config/index.ts'
import { resolveNeutronHome } from '@neutronai/migrations/db-path.ts'

import { buildOpenGraphComposer } from './composer.ts'
import { resolvePersistedCookieSecret } from './session-cookie-secret.ts'

/**
 * Boot the single-owner Open server. Returns the live `BootHandle` so
 * embedded callers can drive + shut down the server in-process.
 *
 * C1 — the env resolution is now a single frozen {@link BootConfig}
 * (`resolveBootConfig`) threaded into BOTH `boot()` and the composer, so the
 * old "boot() re-reads process.env independently of the composer" desync
 * (Codex r1 P2) is closed structurally. This function still WRITES a few
 * derived values back onto `process.env` — the SHIM (`envShimFromBootConfig`):
 * below-the-seam readers (the composer's sub-builders, still reading
 * `process.env` today) keep working unchanged. The shim is MARKED TO DIE once
 * those readers thread BootConfig directly. Never clobbers an operator-set
 * value (writes only into an empty slot).
 */
export async function startOpenServer(): Promise<BootHandle> {
  const env = process.env
  // Managed deploy-config injection wins — defer to the injected composer.
  const injected = await loadGraphComposerFromEnv(env)
  if (injected !== undefined) {
    return boot({ composer: injected, config: resolveBootConfig(env) })
  }

  // Cookie-secret default must land on env BEFORE we freeze config so the
  // resolved value flows into both the frozen config and the shim below.
  // S2 (c) — when the operator sets none, derive a per-INSTALL RANDOM secret
  // PERSISTED under NEUTRON_HOME (stable across restarts, never a guessable
  // constant). The old ephemeral-per-boot value reset every owner session on
  // restart; a persisted random keeps sessions AND stays unforgeable. The
  // composer FAILS LOUD if this is still unset (no predictable fallback).
  if (
    env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] === undefined ||
    env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] === ''
  ) {
    env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = resolvePersistedCookieSecret(
      resolveNeutronHome(env),
    )
  }

  const config = resolveBootConfig(env)

  // SHIM (marked to die): fill OWNER_HOME / NEUTRON_DB_PATH from the frozen
  // config so below-seam readers see them, keeping the gateway data dir + the
  // composer's owner_home in lockstep under NEUTRON_HOME. Only fills empty
  // slots — an operator pin is never overwritten.
  const shim = envShimFromBootConfig(config)
  for (const [key, value] of Object.entries(shim)) {
    if (env[key] === undefined || env[key] === '') env[key] = value
  }

  const composer = buildOpenGraphComposer({ env, config })
  const handle = await boot({ composer, config })

  const slug = resolveOwnerSlugFromConfig(config)
  const neutronHome = config.neutronHome
  const host = config.host
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
