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
 *
 * Keyed on the `sessionKey` STRING the substrate already uses
 * (`${substrate_instance_id} ${cwd}` today; `(instance, user, project)` after S3
 * re-namespaces it). This module never parses or constructs the composite — it
 * treats `sessionKey` as an opaque key, so S2 supervision follows S3's keying
 * with zero rework (brief § 8).
 */

import { existsSync, readFileSync } from 'node:fs'
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
 *  malformed row is dropped rather than poisoning the whole registry. */
export function parseRegistryContents(contents: string): RegistryLoadResult {
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
    if (!isMinimalRecord(raw)) continue
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
 *  brick the substrate. */
export function loadRegistry(path: string, onCorrupt?: (reason: string) => void): ReplRegistry {
  if (!existsSync(path)) return {}
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (e) {
    onCorrupt?.(`read-error: ${(e as Error).message}`)
    return {}
  }
  const result = parseRegistryContents(contents)
  if (result.kind === 'loaded') return result.registry
  if (result.kind === 'corrupt') onCorrupt?.(result.reason)
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

/**
 * Lock-guarded read-modify-write. `mutate` receives the CURRENT on-disk
 * registry (re-read inside the lock so concurrent ticks compose) and returns
 * the registry to persist. Returns whatever `mutate` returns as the second
 * tuple element so callers can observe the result of the critical section
 * (e.g. "did I win the in-flight claim?").
 */
export function withRegistry<T>(
  path: string,
  mutate: (registry: ReplRegistry) => { registry: ReplRegistry; result: T },
): T {
  return withFlockSync(registryLockPath(path), () => {
    const current = loadRegistry(path)
    const { registry, result } = mutate(current)
    saveRegistry(path, registry)
    return result
  })
}

/** Upsert one record (lock-guarded). Merges onto any existing row so a
 *  concurrent tick's fields survive. */
export function upsertRecord(path: string, record: ReplRegistryRecord): void {
  withRegistry(path, (registry) => {
    const prev = registry[record.sessionKey]
    registry[record.sessionKey] = prev ? { ...prev, ...record } : record
    return { registry, result: undefined }
  })
}

/** Patch specific fields on a record (lock-guarded). No-op if the row is gone. */
export function patchRecord(
  path: string,
  sessionKey: string,
  patch: Partial<ReplRegistryRecord>,
): void {
  withRegistry(path, (registry) => {
    const prev = registry[sessionKey]
    if (prev) registry[sessionKey] = { ...prev, ...patch }
    return { registry, result: undefined }
  })
}

/** Remove a record (lock-guarded). Idempotent. */
export function removeRecord(path: string, sessionKey: string): void {
  withRegistry(path, (registry) => {
    delete registry[sessionKey]
    return { registry, result: undefined }
  })
}
