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
import { assertOwnerCredentialPolicy } from '@neutronai/gateway/boot-bind-policy.ts'
import { resolveBootConfig, envShimFromBootConfig } from '@neutronai/config/index.ts'
import { resolveNeutronHome } from '@neutronai/migrations/db-path.ts'

import { buildOpenGraphComposer } from './composer.ts'
import { resolvePersistedCookieSecret } from './session-cookie-secret.ts'
import { resolveOwnerBearer, OWNER_BEARER_ENV_VAR } from './owner-bearer.ts'
import { installProcessSafetyNet } from '@neutronai/logger/fire-and-forget.ts'

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
  //
  // The S1 owner-bearer resolution + `assertOwnerCredentialPolicy` guard below
  // is deliberately NOT run on this branch: the per-install owner bearer is an
  // OPEN single-owner construct, and an injected composer brings its OWN auth
  // model — resolving/persisting an Open owner bearer under NEUTRON_HOME and
  // requiring it here would be semantically wrong for that deployment. The
  // injected path is NOT unguarded, though: `boot()` still runs the shared S2
  // `assertWideBindPolicy` (refuses a wide bind carrying any dev-auth bypass env)
  // for BOTH entrypoints, and an injected composer enforces its own credential
  // check in its own layer. So a wide injected bind is governed by (S2 boot guard
  // + that layer's auth); the Open owner-bearer fail-closed is scoped to the Open
  // composer path.
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

  // S1 — per-install OWNER BEARER + fail-closed wide-bind guard. Resolve the
  // stable per-install owner bearer (an operator-set NEUTRON_OWNER_BEARER wins,
  // else a random bearer persisted 0600 under NEUTRON_HOME), then REFUSE to boot
  // a WIDE (non-loopback) bind whose bearer could only be secured as a
  // process-ephemeral fallback — a public bind must carry a stable owner
  // credential (S2 already rejects the guessable `dev:owner` on a wide bind).
  // A LOOPBACK bind is a no-op: the 127.0.0.1 dogfood keeps its dev bypass.
  // The resolved bearer is threaded to the composer via NEUTRON_OWNER_BEARER so
  // the app-ws resolver + every /api/app/* surface accept THIS install's
  // credential (and it is injected into the served page bootstrap).
  //
  // `resolveOwnerBearer` has ALREADY applied the operator-vs-persisted
  // precedence AND validated/normalized the value (trimmed; a too-short explicit
  // value fails loud; a whitespace-only override is treated as unset → minted).
  // `ownerBearer.value` is therefore the SOLE authoritative credential, and the
  // guard judged `ownerBearer.source` for exactly it. Write it UNCONDITIONALLY
  // so the composer reads the same value the guard approved — never a raw,
  // unvalidated `env` string. (A conditional "fill empty slot only" left a
  // whitespace-only `NEUTRON_OWNER_BEARER='   '` in place while the guard passed
  // on the minted value, so three spaces authenticated as owner — Codex r1.)
  const ownerBearer = resolveOwnerBearer(config.neutronHome, env)
  assertOwnerCredentialPolicy(config.host, ownerBearer.source)
  env[OWNER_BEARER_ENV_VAR] = ownerBearer.value

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
  // F3 — arm the safety net as the VERY FIRST statement, BEFORE the risky
  // composer load / config read inside startOpenServer() (the most
  // failure-prone phase: missing composer module, bad config), so an early
  // startup failure is logged-then-crashed with structure, not a bare Bun
  // error. `boot()`'s own idempotent install then no-ops. RESIDUAL (documented
  // at installProcessSafetyNet): covers the BODY onward; a failure in this dual
  // library+entry module's OWN static imports (stable internal modules) is the
  // accepted in-module-install limit — no bootstrap split (it exports
  // `startOpenServer`, whose importers a split would churn).
  installProcessSafetyNet()
  // Top-level await — Bun supports TLA in entry modules. An unhandled
  // rejection exits non-zero; under a process supervisor that becomes a
  // respawn. The Bun.serve listener + watchdog keep the event loop alive.
  await startOpenServer()
}
