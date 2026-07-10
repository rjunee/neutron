/**
 * @neutronai/persistence — product-wide `system_events` degradation journal.
 *
 * O4 (world-class refactor). Generalizes the onboarding `gateway_events`
 * primitive (ts/level/module/event_name/payload_json) into a product-wide
 * append-only journal for the repo's DELIBERATE silent fail-soft / degrade
 * decisions (§8 of the errors audit — 14 fail-soft/fail-open invariants).
 *
 * ── Contract: VISIBILITY ONLY ──────────────────────────────────────────────
 * This journal adds observability to degrade sites. It MUST NEVER change a
 * degrade decision, alter control flow, or swallow differently. Two mechanisms
 * enforce that:
 *
 *   1. {@link emitSystemEventSafe} — the ONLY entry point degrade sites call.
 *      It NEVER throws and NEVER rejects: a journal-write failure (disk full,
 *      locked DB, unregistered sink) is swallowed so it cannot propagate into
 *      the fail-soft path it is observing. Degrade sites fire-and-forget (they
 *      do not await), so the emit is a pure side-effect on the degrade edge.
 *
 *   2. The ambient sink registry ({@link registerSystemEventSink} /
 *      {@link resolveSystemEventSink}) — degrade sites are scattered across
 *      every band (gbrain/services, cron/platform, cores, open/composition)
 *      and most have no dependency-injection seam. They reach the sink via the
 *      process-wide registry, which the gateway registers ONCE at boot
 *      (gateway/index.ts, right after migrations apply). When no sink is
 *      registered (unit tests, non-gateway contexts, sidecar tools) the
 *      resolver returns null and every emit is a byte-identical no-op — the
 *      degrade path is unchanged.
 *
 * Tests inject a concrete {@link SystemEventsStore} (or a fake
 * {@link SystemEventSink}) directly and MAY await {@link emitSystemEventSafe}
 * (which resolves to void, never rejects) to assert exactly one row landed on
 * the degrade edge.
 */

import { randomUUID } from 'node:crypto'
import type { ProjectDb } from './db.ts'
import { parseJsonColumn } from './sidecar.ts'

export type SystemEventLevel = 'info' | 'warn' | 'error'

/**
 * The catalog of silent-degradation decisions O4 makes visible. Every entry
 * corresponds to a DELIBERATE fail-soft/fail-open invariant that previously
 * degraded with zero (or stderr-only) signal. Adding a new degrade site means
 * adding its name here + emitting from the fail-soft branch.
 */
export type SystemEventName =
  | 'gbrain_unavailable'
  | 'core_install_failed'
  | 'credential_all_cooldown'
  | 'repl_session_capped'
  | 'cron_job_error'
  | 'import_orphaned'
  | 'bundle_build_failed'
  | 'prewarm_failed'

export const ALL_SYSTEM_EVENT_NAMES: ReadonlyArray<SystemEventName> = [
  'gbrain_unavailable',
  'core_install_failed',
  'credential_all_cooldown',
  'repl_session_capped',
  'cron_job_error',
  'import_orphaned',
  'bundle_build_failed',
  'prewarm_failed',
]

/** What a degrade site passes to {@link emitSystemEventSafe}. */
export interface SystemEventInput {
  event: SystemEventName
  /** Log module tag (e.g. 'gbrain', 'cron', 'cores'). Defaults to 'system'. */
  module?: string
  /** Defaults to 'warn' — a degrade is not, by itself, an error. */
  level?: SystemEventLevel
  /** Optional instance scope; most degrade decisions are instance-wide. */
  project_slug?: string | null
  /** Free-form structured context. Defaults to `{}`. */
  payload?: Record<string, unknown>
  /** Test seam for the clock; production stamps `Date.now()`. */
  ts?: number
  /** Optional span close. */
  duration_ms?: number
}

/** Persisted shape — one `system_events` row. */
export interface PersistedSystemEvent {
  id: string
  ts: number
  level: SystemEventLevel
  module: string
  event: SystemEventName
  payload: Record<string, unknown>
  project_slug: string | null
  duration_ms?: number
}

/**
 * The seam degrade sites depend on. `record` MAY be async (the SQLite store's
 * write is) or sync (an in-memory fake). {@link emitSystemEventSafe} normalizes
 * both and guarantees neither can throw into the caller.
 */
export interface SystemEventSink {
  record(input: SystemEventInput): Promise<{ id: string }> | { id: string }
}

export interface SystemEventsStoreDeps {
  db: ProjectDb
  /** Test seam for ids. */
  uuid?: () => string
  /** Test seam for the clock. */
  now?: () => number
}

/**
 * SQLite-backed {@link SystemEventSink}. Follows the `gateway_events`
 * (OnboardingTelemetry) store idiom: a single parameterised INSERT of the
 * primitive columns, plus read-only `listRecent` for the diagnostics surface
 * (O5) and rising-edge dedup reads.
 */
export class SystemEventsStore implements SystemEventSink {
  private readonly db: ProjectDb
  private readonly uuid: () => string
  private readonly now: () => number

  constructor(deps: SystemEventsStoreDeps) {
    this.db = deps.db
    this.uuid = deps.uuid ?? randomUUID
    this.now = deps.now ?? ((): number => Date.now())
  }

  async record(input: SystemEventInput): Promise<{ id: string }> {
    const id = this.uuid()
    const ts = input.ts ?? this.now()
    const level: SystemEventLevel = input.level ?? 'warn'
    const module = input.module ?? 'system'
    const project_slug = input.project_slug ?? null
    const payload = input.payload ?? {}
    await this.db.run(
      `INSERT INTO system_events
         (id, ts, level, module, event_name, payload_json, project_slug, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        ts,
        level,
        module,
        input.event,
        JSON.stringify(payload),
        project_slug,
        input.duration_ms ?? null,
      ],
    )
    return { id }
  }

  /**
   * Read-only: the most-recent `limit` events, NEWEST FIRST. Pushes
   * `ORDER BY … DESC LIMIT ?` into the DB so a long-lived instance reads at
   * most `limit` rows. `limit <= 0` returns `[]`. Optionally filter by event
   * name (the `(event_name, ts)` index serves this — used by the cron
   * rising-edge dedup + O5 diagnostics).
   */
  listRecent(limit: number, eventName?: SystemEventName): PersistedSystemEvent[] {
    if (!Number.isFinite(limit) || limit <= 0) return []
    const n = Math.floor(limit)
    const rows =
      eventName === undefined
        ? this.db.all<SystemEventRow, [number]>(
            `SELECT id, ts, level, module, event_name, payload_json, project_slug, duration_ms
               FROM system_events
              ORDER BY ts DESC, id DESC
              LIMIT ?`,
            [n],
          )
        : this.db.all<SystemEventRow, [string, number]>(
            `SELECT id, ts, level, module, event_name, payload_json, project_slug, duration_ms
               FROM system_events
              WHERE event_name = ?
              ORDER BY ts DESC, id DESC
              LIMIT ?`,
            [eventName, n],
          )
    return rows.map((r) => rowToPersisted(r))
  }
}

interface SystemEventRow {
  id: string
  ts: number
  level: SystemEventLevel
  module: string
  event_name: SystemEventName
  payload_json: string
  project_slug: string | null
  duration_ms: number | null
}

function rowToPersisted(r: SystemEventRow): PersistedSystemEvent {
  const out: PersistedSystemEvent = {
    id: r.id,
    ts: r.ts,
    level: r.level,
    module: r.module,
    event: r.event_name,
    payload: parseJsonColumn(r.payload_json, { onCorrupt: 'throw' }) as Record<string, unknown>,
    project_slug: r.project_slug,
  }
  if (r.duration_ms !== null) out.duration_ms = r.duration_ms
  return out
}

/**
 * The ONLY emit entry point degrade sites call. NEVER throws, NEVER rejects.
 *
 * A degrade site fires this and continues immediately (does not await): the
 * emit is a pure side-effect on the fail-soft edge. Both a synchronous throw
 * from `sink.record` AND an async rejection are swallowed (best-effort routed
 * to `onError`, whose own throw is also swallowed) so a journal-write failure
 * can NEVER propagate into the degrade path it observes.
 *
 * Returns a `Promise<void>` that ALWAYS resolves — tests may `await` it to
 * assert the row landed; production ignores it.
 *
 * When `sink` is null/undefined (no sink registered — unit tests, sidecar
 * tools, non-gateway contexts) this is a byte-identical no-op.
 */
export function emitSystemEventSafe(
  sink: SystemEventSink | null | undefined,
  input: SystemEventInput,
  onError?: (err: unknown) => void,
): Promise<void> {
  if (sink === null || sink === undefined) return Promise.resolve()
  const reportError = (err: unknown): void => {
    if (onError === undefined) return
    try {
      onError(err)
    } catch {
      // An observability sink's error handler must never re-throw into the
      // degrade path. Swallow.
    }
  }
  let pending: Promise<{ id: string }> | { id: string }
  try {
    pending = sink.record(input)
  } catch (err) {
    // Synchronous throw from a sink (e.g. a fake that throws, or a sync store).
    reportError(err)
    return Promise.resolve()
  }
  return Promise.resolve(pending).then(
    () => {},
    (err) => {
      reportError(err)
    },
  )
}

// ── Ambient sink registry ──────────────────────────────────────────────────
//
// Degrade sites live across every band and mostly lack a DI seam, so they reach
// the sink through this process-wide registry. It is a STACK of live sinks:
// `resolveSystemEventSink()` returns the TOP (most-recently registered still-
// live) sink, or null when empty.
//
// The stack — rather than a single slot — makes overlapping boots safe to tear
// down in ANY order. Each boot pushes its sink via `pushSystemEventSink` and
// calls the returned deregister on shutdown, which removes THAT sink by
// identity from wherever it sits. So neither a still-live older boot is
// orphaned (newest-first shutdown) nor a closed-DB sink resurrected (oldest-
// first shutdown): the top of the stack is always a live owner.

const sinkStack: SystemEventSink[] = []

/**
 * Push a sink onto the ambient stack and return an idempotent deregister that
 * removes THIS sink (by identity, from any position). The gateway pushes once
 * at boot (right after migrations apply) and deregisters on shutdown / init
 * failure. Ownership is by the returned closure, so overlapping boots tear down
 * in any order without clobbering each other.
 */
export function pushSystemEventSink(sink: SystemEventSink): () => void {
  sinkStack.push(sink)
  let removed = false
  return (): void => {
    if (removed) return
    removed = true
    const i = sinkStack.lastIndexOf(sink)
    if (i !== -1) sinkStack.splice(i, 1)
  }
}

/**
 * Simple last-wins setter: REPLACE the entire stack with `sink` (or clear it
 * when null). Kept for unit tests (register a fake, then `null` in afterEach)
 * and non-boot callers that want single-slot semantics. Boot uses
 * {@link pushSystemEventSink} instead so its lifecycle is identity-scoped.
 */
export function registerSystemEventSink(sink: SystemEventSink | null): void {
  sinkStack.length = 0
  if (sink !== null) sinkStack.push(sink)
}

/**
 * Resolve the top live sink, or null when the stack is empty. Degrade sites
 * call `emitSystemEventSafe(resolveSystemEventSink(), { … })`.
 */
export function resolveSystemEventSink(): SystemEventSink | null {
  return sinkStack.length > 0 ? (sinkStack[sinkStack.length - 1] ?? null) : null
}

/**
 * Convenience: resolve the ambient sink and emit in one guarded call. NEVER
 * throws. This is what most degrade sites use — it collapses to a no-op when
 * no sink is registered.
 */
export function emitSystemEvent(
  input: SystemEventInput,
  onError?: (err: unknown) => void,
): Promise<void> {
  return emitSystemEventSafe(resolveSystemEventSink(), input, onError)
}
