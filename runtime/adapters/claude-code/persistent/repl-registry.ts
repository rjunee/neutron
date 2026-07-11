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
 *   - A CORRUPT on-disk file (unparseable JSON or wrong shape) never brings
 *     supervision down — `loadRegistry` maps it to `{}` — but a mutation
 *     built on that `{}` would otherwise silently overwrite the file and
 *     vaporize every other sessionKey's row with zero signal. Same story,
 *     smaller blast radius, for a single MALFORMED row (schema skew from a
 *     rolling restart) that `isMinimalRecord` drops during parse. The
 *     mutation path (`withRegistry` and the `*Record` helpers) guards BOTH:
 *     it logs loudly AND best-effort sidecars the pre-loss raw bytes to a
 *     collision-resistant `<path>.corrupt-<epoch-ms>-<pid>-<counter>` before
 *     the save makes the drop permanent, so rows are recoverable by hand. See
 *     `defaultCorruptHandler` / `defaultDropRowHandler`.
 *   - A whole-file READ error (EACCES, EMFILE, a transient I/O hiccup — as
 *     opposed to a parse/shape error) is handled MORE conservatively still:
 *     there are no bytes to sidecar and no way to know the failure wasn't
 *     momentary, so the mutation path skips the SAVE entirely rather than
 *     committing a `{}`-based rebuild — the file is left untouched for the
 *     next tick to retry. See `loadRegistryForMutation`.
 *
 * Keyed on the `sessionKey` STRING the substrate already uses
 * (`${substrate_instance_id} ${cwd}` today; `(instance, user, project)` after S3
 * re-namespaces it). This module never parses or constructs the composite — it
 * treats `sessionKey` as an opaque key, so S2 supervision follows S3's keying
 * with zero rework (brief § 8).
 */

import { readFileSync, writeFileSync } from 'node:fs'
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
 *  itself is still dropped (a half-shaped record isn't safely usable). Its
 *  third argument is the FULL raw file text (not just the one row) so a
 *  caller can sidecar-preserve the whole pre-drop file, not just the one
 *  malformed row, before the drop becomes permanent on save. */
export function parseRegistryContents(
  contents: string,
  onDropRow?: (key: string, raw: unknown, rawContents: string) => void,
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
      onDropRow?.(key, raw, contents)
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
 *  as a whole parses fine.
 *
 * Classifies "absent" by `ENOENT` on the read itself rather than a separate
 * `existsSync` pre-check (Codex r6): a pre-check-then-read has a TOCTOU gap,
 * AND `existsSync` collapses ANY stat error — not just "doesn't exist" — to
 * `false` (e.g. a permission-denied parent directory), which would silently
 * misclassify a genuine read failure as the steady-state absent case. */
export function loadRegistry(
  path: string,
  onCorrupt?: (reason: string, rawContents?: string) => void,
  onDropRow?: (key: string, raw: unknown, rawContents: string) => void,
): ReplRegistry {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {} // absent — steady-state cold boot
    onCorrupt?.(`read-error: ${(e as Error).message}`)
    return {}
  }
  const result = parseRegistryContents(contents, onDropRow)
  if (result.kind === 'loaded') return result.registry
  if (result.kind === 'corrupt') onCorrupt?.(result.reason, contents)
  return {}
}

/**
 * Load for the MUTATION path specifically (`withRegistry`) — like
 * `loadRegistry`, but additionally reports whether the save that's about to
 * follow should be SKIPPED.
 *
 * A whole-file READ error (EACCES, EMFILE, a transient NFS hiccup, ...) is
 * fundamentally different from a PARSE error: on a parse error we DID get
 * the bytes (just couldn't make sense of them), so proceeding to rebuild +
 * save is safe — the original is sidecar-preserved either way. On a read
 * error we got NOTHING, so we have no idea whether the on-disk file was
 * fine, transiently inaccessible, or genuinely bad — and no bytes to
 * sidecar even if we wanted to. Proceeding to save a mutation built on `{}`
 * would silently convert a possibly-momentary hiccup into PERMANENT,
 * unrecoverable loss of every row (Codex r4). So on a read error the
 * mutation still runs (callers always get a `T` back, same as any other
 * no-record case) but `skipSave` tells `withRegistry` to leave the on-disk
 * file untouched — whatever state it was in, the next tick gets to retry
 * the read rather than this tick permanently erasing it.
 *
 * Classifies "absent" by `ENOENT` on the read itself, same as `loadRegistry`
 * (Codex r6) — a separate `existsSync` pre-check has a TOCTOU gap and would
 * fold a genuine (non-ENOENT) read failure into the "absent" `skipSave:
 * false` branch, defeating the very protection this function exists to add.
 */
function loadRegistryForMutation(
  path: string,
  onCorrupt: (reason: string, rawContents?: string) => void,
  onDropRow: (key: string, raw: unknown, rawContents: string) => void,
): { registry: ReplRegistry; skipSave: boolean } {
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { registry: {}, skipSave: false }
    onCorrupt(`read-error: ${(e as Error).message}`)
    return { registry: {}, skipSave: true }
  }
  const result = parseRegistryContents(contents, onDropRow)
  if (result.kind === 'loaded') return { registry: result.registry, skipSave: false }
  if (result.kind === 'corrupt') onCorrupt(result.reason, contents)
  return { registry: {}, skipSave: false }
}

/** Atomically write the registry to disk (tmp → fsync → rename). */
export function saveRegistry(path: string, registry: ReplRegistry): void {
  atomicWriteFileSync(path, serializeRegistry(registry))
}

/** Read the record for `sessionKey`, or undefined. */
export function getRecord(path: string, sessionKey: string): ReplRegistryRecord | undefined {
  return loadRegistry(path)[sessionKey]
}

// Per-process monotonic counter so two sidecars written in the SAME
// millisecond (a corrupt full-file save racing a dropped-row save, or two
// watchdog ticks in tight succession) never PICK the same candidate path —
// mirrors `atomic-write.ts`'s `stagingPathFor` pid+counter pattern. The `wx`
// exclusive-create flag below is the actual guarantee (this counter is just
// what keeps the retry loop from needing more than one attempt in practice);
// without EITHER, a same-millisecond second write could silently
// `writeFileSync`-truncate the first recovery copy or follow a pre-existing
// symlink at that path, defeating the whole point of the sidecar.
let sidecarCounter = 0

/** TEST-ONLY: reset the monotonic sidecar-naming counter to 0 so a test can
 *  predict exact candidate sidecar paths (combined with overriding
 *  `Date.now`) and deterministically exercise the `EEXIST`-retry / retry-
 *  exhaustion boundaries without relying on real OS permission bits — which
 *  a root-run CI container bypasses entirely, silently skipping coverage of
 *  those paths (Codex r7). NEVER call this outside tests. */
export function __resetSidecarCounterForTests(): void {
  sidecarCounter = 0
}

/** Ceiling on `EEXIST` retries — defends against a hostile/corrupted
 *  directory that's pre-populated every candidate path; a real collision
 *  resolves on attempt 1 essentially always (pid+counter+ms is already
 *  unique in the overwhelmingly common case). Exported read-only so tests
 *  can exercise the exhaustion boundary without hardcoding the number twice. */
export const SIDECAR_MAX_ATTEMPTS = 5

/** Best-effort preserve a corrupt/pre-drop registry's raw bytes to a
 *  collision-resistant sidecar file next to `path`, so an operator can
 *  hand-recover rows a save is about to drop. Uses exclusive create (`wx`) —
 *  refuses to touch an existing path (including a symlink planted there)
 *  rather than silently overwriting/following it — and retries with a fresh
 *  suffix on `EEXIST` instead of ever falling back to a non-exclusive write.
 *  Never throws — a sidecar-write failure must not block the mutation
 *  already in flight inside the lock. */
function writeSidecarBestEffort(path: string, contents: string): string | undefined {
  let lastErr: unknown
  for (let attempt = 0; attempt < SIDECAR_MAX_ATTEMPTS; attempt++) {
    const sidecarPath = `${path}.corrupt-${Date.now()}-${process.pid}-${sidecarCounter++}`
    try {
      writeFileSync(sidecarPath, contents, { mode: 0o600, flag: 'wx' })
      return sidecarPath
    } catch (e) {
      lastErr = e
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue // fresh suffix, retry
      console.error(`repl-registry: failed to write corruption sidecar ${sidecarPath}: ${e}`)
      return undefined
    }
  }
  console.error(
    `repl-registry: failed to write corruption sidecar for ${path} after ${SIDECAR_MAX_ATTEMPTS} ` +
      `EEXIST retries: ${lastErr}`,
  )
  return undefined
}

/**
 * Default `onCorrupt` handler for the mutation path (`withRegistry` and
 * everything built on it: `upsertRecord`/`patchRecord`/`removeRecord`).
 *
 * Unlike the read-only diagnostics path (`gateway/diagnostics/instance-sources.ts`,
 * which THROWS so an unreadable registry surfaces as `available: false`), the
 * mutation path must never crash the gateway on corruption — a watchdog tick
 * that can't tolerate a bad registry file would take down supervision for
 * every OTHER project too. So this degrades LOUD-but-alive instead.
 *
 * Branches on TWO distinct failure shapes that must NOT share a message
 * (Codex r6 — the shared message previously falsely told operators a
 * whole-file read error was "about to rebuild ... DROPS every other row",
 * when a read error's `skipSave` actually means NOTHING is committed):
 *   - a whole-file READ error (`reason` starts with `read-error:`): NOTHING
 *     is sidecar-preserved (there are no bytes to preserve) because NOTHING
 *     is being overwritten either — `loadRegistryForMutation` sets
 *     `skipSave` for this case, so the on-disk file is left completely
 *     untouched. The log says exactly that.
 *   - a genuine PARSE/shape error (bytes WERE read, just didn't parse): the
 *     mutation DOES proceed to rebuild `path` from `{}`, so this branch logs
 *     the sidecar it best-effort writes BEFORE that rebuild, so every other
 *     sessionKey's row is recoverable by hand even though it's about to be
 *     dropped from the live file.
 * An ABSENT file never reaches this — `loadRegistry` returns `{}` for that
 * case without invoking `onCorrupt` at all (the steady-state cold-boot path).
 */
function defaultCorruptHandler(path: string): (reason: string, rawContents?: string) => void {
  return (reason, rawContents) => {
    if (reason.startsWith('read-error:')) {
      console.error(
        `repl-registry: READ ERROR on ${path} (${reason}) — the SAVE for this mutation is being ` +
          `SKIPPED entirely (not just left un-sidecarred): the on-disk file is left byte-for-byte ` +
          `untouched so the next tick can retry the read. Nothing was dropped.`,
      )
      return
    }
    const sidecarPath = rawContents !== undefined ? writeSidecarBestEffort(path, rawContents) : undefined
    console.error(
      `repl-registry: CORRUPT registry at ${path} (${reason}) — a mutation is about to ` +
        `rebuild it from empty, which DROPS every other sessionKey's row (sessionId/pid/` +
        `respawn bookkeeping). ` +
        (sidecarPath
          ? `Raw bytes preserved at ${sidecarPath} for manual recovery.`
          : `Sidecar preservation FAILED — raw bytes may be lost.`),
    )
  }
}

/**
 * Default `onDropRow` handler — a row dropped for failing the schema check
 * (e.g. missing `has_session`/`channelName`, written by an older/newer build
 * during a rolling restart) is JUST as lossy as whole-file corruption: it's
 * still gone from the registry the mutation is about to save. So this mirrors
 * `defaultCorruptHandler`: logs loudly AND best-effort sidecars the
 * PRE-DROP file bytes before the row disappears for good.
 *
 * A single `loadRegistry` pass can drop multiple rows (e.g. two stale rows
 * from the same bad deploy); this handler sidecars only ONCE per pass — the
 * closure-local `sidecarPath`/`attempted` below are scoped to one call of
 * `defaultDropRowHandler(path)`, and `withRegistry` makes exactly one such
 * call per mutation, so N drops in one load still produce ONE recovery file
 * (all the dropped rows' original bytes are in that one copy of the whole
 * file — no need for N).
 */
function defaultDropRowHandler(path: string): (key: string, raw: unknown, rawContents: string) => void {
  let attempted = false
  let sidecarPath: string | undefined
  return (key, _raw, rawContents) => {
    if (!attempted) {
      attempted = true
      sidecarPath = writeSidecarBestEffort(path, rawContents)
    }
    console.error(
      `repl-registry: dropping row sessionKey=${key} in ${path} — missing required fields ` +
        `(schema skew; likely written by an older/newer build). ` +
        (sidecarPath
          ? `Pre-drop file bytes preserved at ${sidecarPath} for manual recovery.`
          : `Sidecar preservation FAILED — the row is lost unless recovered by hand from elsewhere.`),
    )
  }
}

/** Options accepted by `withRegistry` and the mutation helpers built on it. */
export interface WithRegistryOptions {
  /** Called IN ADDITION to (never instead of) the mandatory default —
   *  `defaultCorruptHandler`'s loud log + best-effort sidecar ALWAYS run
   *  first, unconditionally, on every corruption event. This is purely an
   *  extra side-channel notification hook (tests observing that corruption
   *  fired; a caller wanting its own additional alerting) — there is
   *  deliberately no way to pass an option that SILENCES or REPLACES the
   *  default, because corruption recovery must never be optional. */
  onCorrupt?: (reason: string, rawContents?: string) => void
  /** Called IN ADDITION to (never instead of) the mandatory default —
   *  `defaultDropRowHandler`'s loud log + best-effort sidecar. Same
   *  additive-only contract as `onCorrupt`. */
  onDropRow?: (key: string, raw: unknown, rawContents: string) => void
}

/**
 * Lock-guarded read-modify-write. `mutate` receives the CURRENT on-disk
 * registry (re-read inside the lock so concurrent ticks compose) and returns
 * the registry to persist. Returns whatever `mutate` returns as the second
 * tuple element so callers can observe the result of the critical section
 * (e.g. "did I win the in-flight claim?").
 *
 * Corruption never aborts the mutation (boot resilience — a corrupt registry
 * must not brick the gateway) but is always LOUD: `defaultCorruptHandler` /
 * `defaultDropRowHandler` run UNCONDITIONALLY on every corruption/drop event;
 * `options.onCorrupt` / `options.onDropRow`, if given, run in ADDITION —
 * never as a replacement (Codex r3: a caller-supplied callback must not be
 * able to silently disable the sidecar safety net).
 *
 * A whole-file READ error (as opposed to a parse/shape error) skips the SAVE
 * entirely — `mutate` still runs and the caller still gets its `T`, but
 * nothing is written to disk, leaving the file exactly as it was for the
 * next tick to retry (Codex r4: we have no bytes to sidecar and no way to
 * know the failure wasn't transient, so committing a `{}`-based mutation
 * would risk turning a momentary hiccup into permanent, unrecoverable loss).
 * See `loadRegistryForMutation`.
 */
export function withRegistry<T>(
  path: string,
  mutate: (registry: ReplRegistry) => { registry: ReplRegistry; result: T },
  options: WithRegistryOptions = {},
): T {
  const mandatoryOnCorrupt = defaultCorruptHandler(path)
  const mandatoryOnDropRow = defaultDropRowHandler(path)
  // The mandatory default ALWAYS runs, unguarded — if that itself throws,
  // something is deeply wrong and we want it loud. The CALLER-supplied
  // callback, in contrast, is untrusted: it must NEVER be able to abort the
  // mutation by throwing (Codex r5) — that would violate "corruption never
  // aborts the mutation" for the one case (options.onCorrupt/onDropRow) that
  // isn't under this module's control. Isolate it in its own try/catch.
  const onCorrupt = (reason: string, rawContents?: string): void => {
    mandatoryOnCorrupt(reason, rawContents)
    try {
      options.onCorrupt?.(reason, rawContents)
    } catch (e) {
      console.error(`repl-registry: caller-supplied onCorrupt callback threw (ignored): ${e}`)
    }
  }
  const onDropRow = (key: string, raw: unknown, rawContents: string): void => {
    mandatoryOnDropRow(key, raw, rawContents)
    try {
      options.onDropRow?.(key, raw, rawContents)
    } catch (e) {
      console.error(`repl-registry: caller-supplied onDropRow callback threw (ignored): ${e}`)
    }
  }
  return withFlockSync(registryLockPath(path), () => {
    const { registry: current, skipSave } = loadRegistryForMutation(path, onCorrupt, onDropRow)
    const { registry, result } = mutate(current)
    if (!skipSave) saveRegistry(path, registry)
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
