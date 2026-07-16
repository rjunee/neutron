/**
 * gateway/boot-listener-registry.ts — boot-time infra resolvers.
 *
 * One of the cohesive clusters split out of the former monolithic
 * `gateway/boot-helpers.ts` (C2 refactor). Holds the resolvers the boot
 * shell needs BEFORE any composition runs: the per-instance registry DB
 * path + owner-row lookup, the listen-port resolution, the deterministic
 * HTTP-listener bind (#314), and the owner-home / repo-root resolvers.
 *
 * Open-classified and import-clean of Managed dirs — the same boundary
 * contract as the rest of the boot helpers. This module MUST NEVER import
 * `gateway/index.ts` (the entry↔composer TLA cycle ban is a hard depcruise
 * error).
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '@neutronai/logger'

const moduleLog = createLogger('gateway-boot')

/**
 * Default upstream port used by the per-instance systemd unit when no
 * `--port=N` argv flag and no `NEUTRON_PORT` env override are set. The S5
 * unit template's ExecStart always passes `--port=<allocated>`, so this
 * default only fires under direct `bun run gateway/index.ts` dev runs.
 */
const DEFAULT_LISTEN_PORT = 7_800

/**
 * Resolve the platform instances-registry SQLite path. The per-instance
 * gateway opens this read-only at boot to (a) look up its own
 * `internal_handle` keyed by `url_slug` and (b) wire the JWT
 * slug-history shim against the live `slug_history` table.
 *
 * Resolution order mirrors the provisioning CLI's `defaultRegistryDbPath`
 * (with one extra legacy fallback) so a fresh instance unit picks up the
 * same registry as the orchestrator that provisioned it:
 *
 *   1. `NEUTRON_REGISTRY_DB_PATH` env (explicit override — canonical name)
 *   2. `<NEUTRON_HOME>/registry.db` (production: /srv/neutron/registry.db)
 *   3. `NEUTRON_REGISTRY_DB_PATH_RW` env (legacy pre-2026-05-09 name —
 *      composer-side resolvers also accept this; mirrored here so OLD
 *      instance units that ONLY export `_RW` don't crash at boot before
 *      the composer fallbacks even run. `deploy-update.sh` does not
 *      re-render existing per-instance service unit files, so until an
 *      operator re-provisions every unit we must read this. Emits a
 *      one-shot deprecation warning.)
 *   4. `~/.local/share/neutron/registry.db` (dev fallback)
 */
let warnedLegacyRegistryDbPathRw = false
export function resolveRegistryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['NEUTRON_REGISTRY_DB_PATH']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const home = env['NEUTRON_HOME']
  if (home !== undefined && home !== '') return join(home, 'registry.db')
  const legacy = env['NEUTRON_REGISTRY_DB_PATH_RW']
  if (legacy !== undefined && legacy !== '') {
    if (!warnedLegacyRegistryDbPathRw) {
      warnedLegacyRegistryDbPathRw = true
      moduleLog.warn('legacy_registry_db_path', {
        detail:
          'NEUTRON_REGISTRY_DB_PATH unset; using legacy NEUTRON_REGISTRY_DB_PATH_RW. Re-render this instance unit via `owner-create.sh` to drop the legacy var.',
      })
    }
    return legacy
  }
  return join(homedir(), '.local', 'share', 'neutron', 'registry.db')
}

/**
 * Look up the boot instance's registry row with an `internal_handle` fallback.
 *
 * Primary path: `requested_slug` matches the row's `url_slug`. This is the
 * common case — the systemd unit's `NEUTRON_INSTANCE_SLUG` env (or the
 * `<owner_home>/.url_slug` file the rename orchestrator writes) holds the
 * current user-visible slug.
 *
 * Fallback path: the unit was booted with a stale value that still matches
 * the frozen `internal_handle` (e.g. `t-aaaaaaaa`). This happens when an
 * orchestrator slug-rename updates the registry's `url_slug` but the
 * per-instance systemd unit's slug env / .url_slug file is
 * not regenerated in lockstep — the unit's instance name is keyed to
 * `internal_handle` (correctly, since handles are stable across renames),
 * so it can still find the row by handle. The composer canonicalises
 * `project_slug` to the row's `url_slug` and the caller logs a one-line
 * WARN telling the operator to regenerate the drop-in.
 *
 * Both lookups miss → throw. Refuse to boot rather than disable the
 * JWT slug-history shim / connect routing silently.
 *
 * Incident of record: 2026-05-10, live instance renamed from
 * its frozen `internal_handle` to a custom `url_slug`; the per-instance unit's
 * `NEUTRON_INSTANCE_SLUG` (still the handle) was not regenerated, so the gateway
 * crash-looped on every restart for 41+ cycles before a manual
 * `slug-rename.conf` drop-in landed. See
 * `docs/solutions/runtime-errors/instance-slug-rename-systemd-unit-stale.md`.
 */
/**
 * Sprint B (2026-05-20) — structural alias for the subset of the Managed
 * `OwnersRegistry.OwnerRow` this boot shell reads (boot fingerprint,
 * recover handler's owner check). The Managed concrete `OwnerRow` ships
 * additional bookkeeping columns this file never inspects; structural
 * typing closes the gap without a provisioning-module import edge.
 */
export interface BootOwnerRow {
  internal_handle: string
  url_slug: string
  owner_user_id?: string | null
}

/**
 * Structural alias for the registry methods the boot shell actually
 * invokes (`getBySlug` + `getByInternalHandle`). The Managed concrete
 * `OwnersRegistry` (constructed via the dynamic
 * provisioning-module registry import at composer-build time)
 * structurally satisfies this alias.
 */
export interface BootOwnersRegistry {
  getBySlug(url_slug: string): BootOwnerRow | undefined
  getByInternalHandle(internal_handle: string): BootOwnerRow | undefined
}

export interface OwnerRegistryLookupResult {
  /** The canonical user-visible slug. Equal to `requested_slug` on the
   *  primary path; equal to the row's `url_slug` on the fallback path. */
  project_slug: string
  /** The registry row. */
  row: BootOwnerRow
  /** True iff we fell back from `getBySlug` to `getByInternalHandle`. */
  fallback_used: boolean
}

export function resolveOwnerRegistryRow(input: {
  requested_slug: string
  registry: BootOwnersRegistry
  registry_db_path: string
  /** Override logger for tests. Defaults to console.warn. */
  warn?: (msg: string) => void
}): OwnerRegistryLookupResult {
  const bySlug = input.registry.getBySlug(input.requested_slug)
  if (bySlug !== undefined) {
    return { project_slug: input.requested_slug, row: bySlug, fallback_used: false }
  }
  const byHandle = input.registry.getByInternalHandle(input.requested_slug)
  if (byHandle !== undefined) {
    const canonical = byHandle.url_slug
    const warn = input.warn ?? ((m: string) => moduleLog.warn(m))
    warn(
      `[gateway] project_slug arg was internal_handle, resolved to url_slug=${canonical}; the systemd unit's NEUTRON_INSTANCE_SLUG env / .url_slug file is stale — update it to "${canonical}" (edit the unit's Environment=NEUTRON_INSTANCE_SLUG= line or write the .url_slug file, then reload + restart the unit) so the arg matches the registry and this fallback stops firing`,
    )
    return { project_slug: canonical, row: byHandle, fallback_used: true }
  }
  throw new Error(
    `[composer] project=${input.requested_slug} not found in registry at ${input.registry_db_path} — refuse to boot rather than disable the JWT slug-history shim silently. Tried getBySlug + getByInternalHandle fallback; both missed.`,
  )
}

/**
 * Resolve the listening port. Precedence (highest wins):
 *   1. explicit `BootOptions.port` (test injection — `0` requests random).
 *   2. `--port=<N>` on `process.argv` (the S5 systemd unit ExecStart shape).
 *   3. `NEUTRON_PORT` env var.
 *   4. fallback `DEFAULT_LISTEN_PORT`.
 *
 * NaN / non-integer / out-of-range values throw at boot — better to brick
 * loudly here than let systemd Restart-loop a misconfigured unit.
 */
export function resolveListenPort(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  override?: number,
): number {
  if (override !== undefined) return assertPort(override, '<BootOptions.port>')
  for (const a of argv) {
    if (a.startsWith('--port=')) {
      const raw = a.slice('--port='.length)
      const parsed = Number.parseInt(raw, 10)
      if (Number.isNaN(parsed) || String(parsed) !== raw.trim()) {
        throw new Error(`invalid --port=${raw}: not an integer`)
      }
      return assertPort(parsed, '--port')
    }
  }
  const fromEnv = env['NEUTRON_PORT']
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = Number.parseInt(fromEnv, 10)
    if (Number.isNaN(parsed) || String(parsed) !== fromEnv.trim()) {
      throw new Error(`invalid NEUTRON_PORT=${fromEnv}: not an integer`)
    }
    return assertPort(parsed, 'NEUTRON_PORT')
  }
  return DEFAULT_LISTEN_PORT
}

function assertPort(p: number, label: string): number {
  if (!Number.isInteger(p) || p < 0 || p > 65_535) {
    throw new Error(`invalid ${label}=${p}: must be an integer in [0, 65535]`)
  }
  return p
}

/** Default window to retry an EADDRINUSE on a configured port before failing
 *  loud. Sized to ride out a previous server still releasing the socket during
 *  a restart (graceful-drain + supervisor relaunch overlap), not to mask a
 *  genuinely-occupied port. */
const DEFAULT_PORT_BIND_RETRY_WINDOW_MS = 8_000
/** Delay between EADDRINUSE retries within the window. */
const DEFAULT_PORT_BIND_RETRY_INTERVAL_MS = 200

/** Minimal structural surface of a bound `Bun.serve` server the bind helper
 *  hands back. `port` is `number | undefined` only because Bun's typed surface
 *  marks it so for non-TCP transports; a port-bound HTTP server always sets it. */
export interface BoundHttpServer {
  port?: number | undefined
  stop: (force?: boolean) => void | Promise<void>
}

function isAddrInUse(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false
  if ((err as { code?: unknown }).code === 'EADDRINUSE') return true
  const msg = (err as { message?: unknown }).message
  return (
    typeof msg === 'string' &&
    /EADDRINUSE|address already in use|is port .*in use/i.test(msg)
  )
}

/**
 * Bind the HTTP listener DETERMINISTICALLY (#314).
 *
 * `serve` is a thunk that performs the actual `Bun.serve({ port, … })` (kept a
 * thunk so the caller retains full inline typing of the fetch/websocket
 * handlers). Behaviour by `port`:
 *
 *   - `port === 0` — the genuine "pick any free port" case (dev/tests pass
 *     `--port=0` / `BootOptions.port = 0`). Single attempt; the OS auto-selects.
 *
 *   - `port !== 0` — an explicitly-resolved port (NEUTRON_PORT / --port, or the
 *     fixed 7800 default). Bind it and ONLY it: on EADDRINUSE, retry on a short
 *     backoff through a bounded window — the common cause is the prior process
 *     still releasing the socket during a restart — then FAIL LOUD with a clear,
 *     actionable error if it is still held. We NEVER silently fall back to a
 *     random port, because the owner's bookmarked URL is pinned to this port.
 *
 * Non-EADDRINUSE errors are rethrown immediately (never retried) so real boot
 * faults surface fast instead of being masked by the retry window.
 */
export async function bindHttpListener(opts: {
  port: number
  serve: () => BoundHttpServer
  retryWindowMs?: number
  retryIntervalMs?: number
  /** Injectable sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable monotonic clock in ms (tests). Defaults to `Date.now`. */
  now?: () => number
  /** Retry-notice logger. Defaults to `console.warn`. */
  warn?: (msg: string) => void
}): Promise<BoundHttpServer> {
  // No port explicitly configured: auto-select. dev/tests rely on this.
  if (opts.port === 0) return opts.serve()

  const windowMs = opts.retryWindowMs ?? DEFAULT_PORT_BIND_RETRY_WINDOW_MS
  const intervalMs = opts.retryIntervalMs ?? DEFAULT_PORT_BIND_RETRY_INTERVAL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? ((): number => Date.now())
  const warn = opts.warn ?? ((m: string): void => moduleLog.warn(m))

  const startedAt = now()
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return opts.serve()
    } catch (err) {
      if (!isAddrInUse(err)) throw err
      if (now() - startedAt >= windowMs) {
        throw new Error(
          `[gateway] port ${opts.port} is already in use after retrying for ` +
            `${windowMs}ms (${attempts} attempts). Another process is bound to it — ` +
            `stop it (e.g. \`neutron stop\`, or kill the old server) or set NEUTRON_PORT ` +
            `to a free port. Refusing to silently bind a different port (#314).`,
        )
      }
      warn(
        `[gateway] port ${opts.port} in use (EADDRINUSE) — likely the previous server ` +
          `still releasing the socket; retrying for up to ${windowMs}ms…`,
      )
      await sleep(intervalMs)
    }
  }
}

/**
 * Resolve the per-instance data dir (`<owner_home>`). Honors `OWNER_HOME`
 * when explicitly set; otherwise derives from `NEUTRON_DB_PATH` via the
 * locked layout `<owner_home>/db/project.db` (so `dirname(dirname(dbPath))`
 * yields owner_home). Dev fallback: `~/.local/share/neutron/`. (This is the
 * Managed owner-home derivation; the single-owner DB path itself is resolved by
 * `config`/`migrations/db-path.ts` since C1.)
 */
export function resolveOwnerHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['OWNER_HOME']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const dbPath = env['NEUTRON_DB_PATH']
  if (typeof dbPath === 'string' && dbPath.length > 0) {
    return dirname(dirname(dbPath))
  }
  return join(homedir(), '.local', 'share', 'neutron')
}

/**
 * Resolve the Neutron repo root the bundled-Cores registry walks at
 * boot. Honors `NEUTRON_REPO_ROOT` when explicitly set; otherwise falls
 * back to `process.cwd()` so a local `bun run gateway/index.ts` from
 * the repo top resolves naturally. Per
 * `docs/research/neutron-cores-marketplace-split-2026-05-17.md § 3`
 * (multi-root registry shape — Open returns `[<publicRoot>]`).
 */
export function resolveRepoRoot(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['NEUTRON_REPO_ROOT']
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return process.cwd()
}
