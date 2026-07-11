/**
 * repl-registry.ts — the persisted REPL registry (substrate-lift S2).
 *
 * The Neutron analog of Nova's topic-map row, scoped to the persistent-REPL
 * substrate. It is the ONE piece of supervision state that must SURVIVE a
 * gateway restart: it records, per `sessionKey`, the resumable session UUID
 * (`--resume <sessionId>`), the last-known child `pid` + dev-channel port (for
 * liveness probes), and the respawn-supervision bookkeeping (in-flight stamp,
 * rolling-window respawn counts, hard cap). Without it, a crash/restart loses
 * the sessionId and the next spawn would cold-start FRESH (the S1 context-loss
 * gap, brief § 0).
 *
 * Persistence + concurrency model (brief § 1 #4, § 2 row #12):
 *   - On-disk shape is a JSON object keyed by `sessionKey` (mirrors topic-map).
 *   - Every read-modify-write goes through `withFlockSync` on the registry's
 *     lockfile so two concurrent watchdog ticks (or a tick racing a `start()`
 *     cold-resume) can't both decide to spawn for the same key. Each mutation
 *     RE-READS disk inside the lock so a row another tick appended between a
 *     stale read and our write is never clobbered (TOCTOU-safe).
 *   - Atomic write (tmp → fsync → rename) so a crash mid-write never leaves a
 *     truncated registry.
 *   - A CORRUPT on-disk file (unparseable JSON, wrong shape, or unreadable)
 *     never brings supervision down — `loadRegistry` maps it to `{}` — but a
 *     mutation built on that `{}` would otherwise silently overwrite the file
 *     and vaporize every other sessionKey's row with zero signal. The
 *     mutation path (`withRegistry` and the `*Record` helpers) guards this:
 *     it logs loudly AND best-effort sidecars the raw corrupt bytes to
 *     `<path>.corrupt-<epoch-ms>` before the rebuild, so rows are recoverable
 *     by hand. See `defaultCorruptHandler` / `defaultDropRowHandler`.
 *
 * Keyed on the `sessionKey` STRING the substrate already uses
 * (`${substrate_instance_id} ${cwd}` today; `(instance, user, project)` after S3
 * re-namespaces it). This module never parses or constructs the composite — it
 * treats `sessionKey` as an opaque key, so S2 supervision follows S3's keying
 * with zero rework (brief § 8).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { atomicWriteFileSync } from '../../../atomic-write.ts'
import { registryLockPath, withFlockSync } from './registry-lock.ts'

/** One persisted REPL supervision row. */
export interface ReplRegistryRecord {
  /** Pool key — opaque; follows S3 re-namespacing. */
  sessionKey: string
  /** Session UUID the respawn will `--resume`. */
  sessionId: string
  /** REPL working dir (instance home / project workdir). */
  cwd: string
  /** Dev-channel server name (port-recycle guard echoed by `/health`). */
  channelName: string
  /** True once the session JSONL exists on disk → safe to `--resume`. Set by
   *  consuming `captureSession`'s result (closes the S1 fire-and-forget gap). */
  has_session: boolean
  /** Last-known child pid — liveness probe (`PtyChild.hasExited` is primary;
   *  pid is the cross-restart fallback the watchdog can `kill -0`). */
  pid?: number
  /** Dev-channel HTTP port — `/health` liveness probe target. */
  devchannel_port?: number
  /** Model id the REPL spawned with — replayed on `--resume` so a respawn keeps
   *  the same `--model`. */
  model?: string
  /** Epoch ms the REPL first reached `/health` ok — the boot-grace gate input. */
  first_ready_at?: number
  /** Epoch ms of the last respawn — the cooldown gate input. */
  last_respawn_at?: number
  /** Epoch ms a respawn was marked in-flight — the cross-process double-spawn
   *  guard (the process-local guard is `in-flight-gate.ts`). Cleared on
   *  completion/failure. */
  respawn_in_flight_at?: number
  /** Respawn timestamps inside the rolling window — restart-rate cap input. */
  recent_respawns?: number[]
  /** Epoch ms the hard cap tripped — auto-recovery OFF until an operator clears
   *  it via the admin endpoint. */
  capped_at?: number
}

/** All records keyed by `sessionKey`. */
export type ReplRegistry = Record<string, ReplRegistryRecord>

/** Result of parsing the on-disk registry file. */
export type RegistryLoadResult =
  | { kind: 'absent' }
  | { kind: 'loaded'; registry: ReplRegistry }
  | { kind: 'corrupt'; reason: string }

// ─── Pure (de)serialization ────────────────────────────────────────────────

/** Parse raw file contents into a registry. Pure — does no IO. A single
 *  malformed row is dropped rather than poisoning the whole registry.
 *  `onDropRow`, if given, is invoked for every row that fails the schema
 *  check (e.g. one written by an older/newer build during a rolling
 *  restart) so the drop is at least observable instead of silent — the row
 *  itself is still dropped (a half-shaped record isn't safely usable). */
export function parseRegistryContents(
  contents: string,
  onDropRow?: (key: string, raw: unknown) => void,
): RegistryLoadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (e) {
    return { kind: 'corrupt', reason: `json-parse-error: ${(e as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: 'not-an-object' }
  }
  const registry: ReplRegistry = {}
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isMinimalRecord(raw)) {
      onDropRow?.(key, raw)
      continue
    }
    const rec = raw as ReplRegistryRecord
    // Trust the on-disk sessionKey field; fall back to the map key.
    registry[key] = { ...rec, sessionKey: rec.sessionKey || key }
  }
  return { kind: 'loaded', registry }
}

/** Serialize a registry to disk-ready JSON. Pretty-printed for grep-ability. */
export function serializeRegistry(registry: ReplRegistry): string {
  return JSON.stringify(registry, null, 2)
}

function isMinimalRecord(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return (
    typeof r.sessionId === 'string' &&
    typeof r.cwd === 'string' &&
    typeof r.channelName === 'string' &&
    typeof r.has_session === 'boolean'
  )
}

// ─── Disk-touching wrappers ────────────────────────────────────────────────

/** Load the registry file. Returns `{}` on absent or corrupt (the steady-state
 *  cold-boot case). Corruption is logged via `onCorrupt` so the caller can
 *  observe it without this function throwing — a corrupt registry must never
 *  brick the substrate. `onCorrupt`'s second argument carries the raw file
 *  contents when they were readable (i.e. every case except a read error) so
 *  a caller can sidecar-copy them before they're lost. `onDropRow` reports
 *  individual rows dropped for failing the schema check even when the file
 *  as a whole parses fine. */
export function loadRegistry(
  path: string,
  onCorrupt?: (reason: string, rawContents?: string) => void,
  onDropRow?: (key: string, raw: unknown) => void,
): ReplRegistry {
  if (!existsSync(path)) return {}
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (e) {
    onCorrupt?.(`read-error: ${(e as Error).message}`)
    return {}
  }
  const result = parseRegistryContents(contents, onDropRow)
  if (result.kind === 'loaded') return result.registry
  if (result.kind === 'corrupt') onCorrupt?.(result.reason, contents)
  return {}
}

/** Atomically write the registry to disk (tmp → fsync → rename). */
export function saveRegistry(path: string, registry: ReplRegistry): void {
  atomicWriteFileSync(path, serializeRegistry(registry))
}

/** Read the record for `sessionKey`, or undefined. */
export function getRecord(path: string, sessionKey: string): ReplRegistryRecord | undefined {
  return loadRegistry(path)[sessionKey]
}

/** Best-effort preserve a corrupt registry's raw bytes to a timestamped
 *  sidecar file next to `path`, so an operator can hand-recover rows the
 *  rebuild-from-`{}` is about to drop. Never throws — a sidecar-write
 *  failure must not block the mutation already in flight inside the lock. */
function writeSidecarBestEffort(path: string, contents: string): string | undefined {
  const sidecarPath = `${path}.corrupt-${Date.now()}`
  try {
    writeFileSync(sidecarPath, contents, { mode: 0o600 })
    return sidecarPath
  } catch (e) {
    console.error(`repl-registry: failed to write corruption sidecar ${sidecarPath}: ${e}`)
    return undefined
  }
}

/**
 * Default `onCorrupt` handler for the mutation path (`withRegistry` and
 * everything built on it: `upsertRecord`/`patchRecord`/`removeRecord`).
 *
 * Unlike the read-only diagnostics path (`gateway/diagnostics/instance-sources.ts`,
 * which THROWS so an unreadable registry surfaces as `available: false`), the
 * mutation path must never crash the gateway on corruption — a watchdog tick
 * that can't tolerate a bad registry file would take down supervision for
 * every OTHER project too. So this degrades LOUD-but-alive instead:
 *   1. logs to stderr so the loss is never silent, and
 *   2. best-effort sidecars the raw corrupt bytes BEFORE the mutation rebuilds
 *      `path` from `{}`, so every other sessionKey's row (sessionId/pid/respawn
 *      bookkeeping) is recoverable by hand even though it's about to be
 *      dropped from the live file.
 * An ABSENT file never reaches this — `loadRegistry` returns `{}` for that
 * case without invoking `onCorrupt` at all (the steady-state cold-boot path).
 */
function defaultCorruptHandler(path: string): (reason: string, rawContents?: string) => void {
  return (reason, rawContents) => {
    const sidecarPath = rawContents !== undefined ? writeSidecarBestEffort(path, rawContents) : undefined
    console.error(
      `repl-registry: CORRUPT registry at ${path} (${reason}) — a mutation is about to ` +
        `rebuild it from empty, which DROPS every other sessionKey's row (sessionId/pid/` +
        `respawn bookkeeping). ` +
        (sidecarPath
          ? `Raw bytes preserved at ${sidecarPath} for manual recovery.`
          : `Sidecar preservation FAILED or was impossible (${reason}) — raw bytes may be lost.`),
    )
  }
}

/** Default `onDropRow` handler — logs a row dropped for failing the schema
 *  check (e.g. missing `has_session`/`channelName`, written by an older/newer
 *  build during a rolling restart) so the loss is observable instead of
 *  silent. The row is still dropped; a half-shaped record isn't safely usable
 *  by supervision. */
function defaultDropRowHandler(path: string): (key: string, raw: unknown) => void {
  return (key) => {
    console.error(
      `repl-registry: dropping row sessionKey=${key} in ${path} — missing required fields ` +
        `(schema skew; likely written by an older/newer build). The row is lost from this ` +
        `save unless recovered by hand from a prior copy.`,
    )
  }
}

/** Options accepted by `withRegistry` and the mutation helpers built on it. */
export interface WithRegistryOptions {
  /** Called (instead of the loud default) when the on-disk registry is
   *  corrupt/unreadable. See `defaultCorruptHandler` for what the default
   *  does. Pass this to override in tests or to add project-specific alerting
   *  — NOT to silence corruption, which must always be observable. */
  onCorrupt?: (reason: string, rawContents?: string) => void
  /** Called (instead of the loud default) per row dropped for failing the
   *  schema check. See `defaultDropRowHandler`. */
  onDropRow?: (key: string, raw: unknown) => void
}

/**
 * Lock-guarded read-modify-write. `mutate` receives the CURRENT on-disk
 * registry (re-read inside the lock so concurrent ticks compose) and returns
 * the registry to persist. Returns whatever `mutate` returns as the second
 * tuple element so callers can observe the result of the critical section
 * (e.g. "did I win the in-flight claim?").
 *
 * Corruption never aborts the mutation (boot resilience — a corrupt registry
 * must not brick the gateway) but is always LOUD: see `defaultCorruptHandler`
 * / `defaultDropRowHandler`, both overridable via `options`.
 */
export function withRegistry<T>(
  path: string,
  mutate: (registry: ReplRegistry) => { registry: ReplRegistry; result: T },
  options: WithRegistryOptions = {},
): T {
  const onCorrupt = options.onCorrupt ?? defaultCorruptHandler(path)
  const onDropRow = options.onDropRow ?? defaultDropRowHandler(path)
  return withFlockSync(registryLockPath(path), () => {
    const current = loadRegistry(path, onCorrupt, onDropRow)
    const { registry, result } = mutate(current)
    saveRegistry(path, registry)
    return result
  })
}

/** Upsert one record (lock-guarded). Merges onto any existing row so a
 *  concurrent tick's fields survive. */
export function upsertRecord(
  path: string,
  record: ReplRegistryRecord,
  options?: WithRegistryOptions,
): void {
  withRegistry(
    path,
    (registry) => {
      const prev = registry[record.sessionKey]
      registry[record.sessionKey] = prev ? { ...prev, ...record } : record
      return { registry, result: undefined }
    },
    options,
  )
}

/** Patch specific fields on a record (lock-guarded). No-op if the row is gone. */
export function patchRecord(
  path: string,
  sessionKey: string,
  patch: Partial<ReplRegistryRecord>,
  options?: WithRegistryOptions,
): void {
  withRegistry(
    path,
    (registry) => {
      const prev = registry[sessionKey]
      if (prev) registry[sessionKey] = { ...prev, ...patch }
      return { registry, result: undefined }
    },
    options,
  )
}

/** Remove a record (lock-guarded). Idempotent. */
export function removeRecord(path: string, sessionKey: string, options?: WithRegistryOptions): void {
  withRegistry(
    path,
    (registry) => {
      delete registry[sessionKey]
      return { registry, result: undefined }
    },
    options,
  )
}
