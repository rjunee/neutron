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
import { loadPersistedInstallToken } from './install-token-env.ts'
import { resolvePersistedCookieSecret } from './session-cookie-secret.ts'
import { resolveOwnerBearer } from './owner-bearer.ts'
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
 * value (writes only into an empty slot — see {@link applyEnvShim}).
 */
/**
 * Write the shim's derived values into EMPTY env slots only, never over an
 * operator pin.
 *
 * A BLANK SLOT IS EMPTY, NOT A PIN. This predicate was `=== ''`, which is the
 * one-keystroke-over case `effectiveOwnerHome` (`config/index.ts`) was fixed for
 * and this site was not — while that function's docblock NAMED `open/server.ts`
 * in its list of siblings that trim, and this file contained no `trim()` at all.
 * Measured before the fix: `OWNER_HOME='   '` with a real `NEUTRON_HOME` ->
 * `resolveBootConfig` reads the blank as unset and freezes the effective home as
 * `<NEUTRON_HOME>`; the shim then sees a slot that is neither `undefined` nor
 * `''`, declines to fill it, and the frozen config says `/real/home` while
 * `process.env.OWNER_HOME` still says `'   '`. Below-seam readers take the env,
 * not the config — which is the entire reason this shim exists. One variable,
 * two answers, on the value that decides where the owner's data dir is.
 *
 * Extracted from the loop inside {@link startOpenServer} so the guard in
 * `open/__tests__/owner-slug-agreement.test.ts` can drive it directly; booting a
 * whole server to pin one predicate is not a test, it is a deployment.
 */
export function applyEnvShim(env: NodeJS.ProcessEnv, shim: Record<string, string>): void {
  for (const [key, value] of Object.entries(shim)) {
    const current = env[key]
    if (current === undefined || current.trim().length === 0) env[key] = value
  }
}

export async function startOpenServer(): Promise<BootHandle> {
  const env = process.env
  // Restore a previously-persisted install token BEFORE any composer resolves
  // the LLM substrate (`resolveOpenLlmPool(env)` reads `CLAUDE_CODE_OAUTH_TOKEN`
  // from this same `env`). Bun auto-loads `<cwd>/.env` at startup, so on a
  // single-owner install the token is already present and this no-ops. But when
  // an operator has pointed `NEUTRON_INSTALL_TOKEN_ENV_PATH` at a writable file
  // OUTSIDE cwd (an isolated instance against a shared read-only checkout),
  // Bun's cwd-relative auto-load never sees it — so seed it here. Runs ahead of
  // BOTH the injected-composer branch and the Open composer, and never clobbers
  // an already-set token.
  loadPersistedInstallToken()
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
  //
  // `resolveOwnerBearer` has ALREADY applied the operator-vs-persisted precedence
  // AND validated/normalized the value (trimmed; a too-short explicit value fails
  // loud; a whitespace-only override is treated as unset → minted). Its
  // `ownerBearer.value` is the SOLE authoritative credential, and the guard
  // judged `ownerBearer.source` for exactly it. It is threaded to the composer as
  // an EXPLICIT option (`ownerBearer` below) — NEVER by writing back to the
  // shared `process.env`. Mutating `process.env['NEUTRON_OWNER_BEARER']` would
  // let a MINTED value leak into a second in-process `startOpenServer()` under a
  // different NEUTRON_HOME, where `resolveOwnerBearer` would misread it as an
  // operator-set `source: 'env'` bearer and skip the new home's per-install file
  // (two installs sharing one bearer; an ephemeral value misclassified as
  // persistent for a later wide bind) — Codex r3.
  const ownerBearer = resolveOwnerBearer(config.neutronHome, env)
  assertOwnerCredentialPolicy(config.host, ownerBearer.source)

  // SHIM (marked to die): fill OWNER_HOME / NEUTRON_DB_PATH from the frozen
  // config so below-seam readers see them, keeping the gateway data dir + the
  // composer's owner_home in lockstep under NEUTRON_HOME. Only fills empty
  // slots — an operator pin is never overwritten.
  //
  // BLANK IS AN EMPTY SLOT, NOT A PIN. This predicate was `=== ''`, which is the
  // one-keystroke-over case `effectiveOwnerHome` (`config/index.ts`) was fixed
  // for and this site was not — while that function's docblock NAMED
  // `open/server.ts` in its list of siblings that trim. This file contained no
  // `trim()` at all. Measured: `OWNER_HOME='   '` with a real `NEUTRON_HOME`
  // -> `resolveBootConfig` reads the blank as unset and freezes the effective
  // home as `<NEUTRON_HOME>`, the shim then sees a slot that is neither
  // `undefined` nor `''` and declines to fill it, so the frozen config says
  // `/real/home` while `process.env.OWNER_HOME` still says `'   '`. Every
  // below-seam reader takes the env, not the config — which is the whole reason
  // this shim exists. One variable, two answers, on the value that decides where
  // the owner's data dir is.
  applyEnvShim(env, envShimFromBootConfig(config))

  const composer = buildOpenGraphComposer({ env, config, ownerBearer: ownerBearer.value })
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
