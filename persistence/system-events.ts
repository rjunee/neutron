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
import { neutralizeAbandonedSettle } from '@neutronai/logger/fire-and-forget.ts'

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
  // X1 — dispatch-time capability gate verdict. NOT a silent-degradation entry:
  // this is a LOG-ONLY observability stream emitted once per tool dispatch by
  // `McpServer.dispatch` (the verdict the gate WOULD reach under enforcement,
  // decision D-9). It records; it never changes dispatch behavior.
  | 'capability_verdict'
  // F4 — a supervision-watchdog alert fired (heartbeat stale / stuck / crashed
  // agent / overrun cron / db-lock contention / substrate cooldown saturation,
  // OR a stuck/dead dispatched subagent). NOTIFY-ONLY: the watchdog DETECTS +
  // journals the condition; it changes no control flow and kills nothing.
  | 'watchdog_alert'
  // O6 — a runtime persistent-REPL NOTICE crossed its rising edge and was
  // previously stderr-only (the substrate's `onDeadTurnNotice` / `onSizeAlert` /
  // `onRateLimitBanner` DI seams were unwired in Open). NOTIFY-ONLY: the runtime
  // DETECTS + journals; the gateway ALSO surfaces an owner chat bubble so the
  // state is visible instead of vanishing.
  //   - `dead_turn_notice`   (row #11) — a mid-turn API 5xx killed a turn.
  //   - `session_size_alert` (row #13) — a warm transcript crossed a size band.
  //   - `rate_limit_banner`  (row #10) — a rate-limit / usage-cap banner appeared.
  | 'dead_turn_notice'
  | 'session_size_alert'
  | 'rate_limit_banner'
  // #451 — the boot scope reconciler migrated stranded rows forward after a
  // rename. NOT a silent-degradation entry (it follows the `watchdog_alert`
  // precedent): a REPAIR happened to the owner's database and the row is the
  // durable record of exactly which tables moved, how many rows, and where the
  // pre-repair snapshot lives. Emitted at most once per boot, and only when
  // something actually moved.
  | 'instance_scope_rekeyed'
  // Credential-scope reconciler (`auth/credential-scope-reconcile.ts`). Same
  // precedent as `instance_scope_rekeyed` above: REPAIR/VISIBILITY rows, not
  // silent-degradation entries.
  //   - `credential_scope_migrated` — credential rows frozen under a
  //     pre-provisioning owner handle were unambiguously moved onto the boot
  //     handle (a repair to the owner's database; the durable record of which
  //     tables moved and how many rows).
  //   - `credential_scope_orphaned` — NOTHING was written, for one of TWO
  //     reasons, which the payload's `reason` names because they call for
  //     opposite responses and used to render identically:
  //       `ambiguous_census` — rows under two handles, or stale rows coexisting
  //         with boot-handle rows. Look at the credential rows.
  //       `fallback_boot_handle_refused_direction` — this process booted on the
  //         bare fallback handle and may not claim rows belonging to an explicit
  //         one. Set the instance handle; do NOT run the migration, which is
  //         what a reader of the generic sentence was being steered toward.
  //     Either way the row exists so a scope miss is distinguishable from
  //     "never connected", which is the expensive half of the defect.
  //     BOTH the automatic reconciler and the EXPLICIT owner-driven migration
  //     (`gateway/cores/integrations.ts` `migrateOrphanedCredentials`) emit the
  //     refusal row, with the same `reason`, so one query over this event finds
  //     every refusal regardless of which surface asked. The explicit one adds
  //     `surface: 'explicit_migrate'` to tell them apart — the same shape as
  //     `credential_scope_migrated`, where the explicit path already carries a
  //     `skipped` key the boot payload does not have. The explicit refusal used
  //     to journal NOTHING, because that path's emit was gated on
  //     `total_moved > 0` and a refusal moves nothing.
  // Payload is COUNTS + HANDLES + TABLE NAMES only — never a secret kind/label,
  // never ciphertext, never plaintext.
  | 'credential_scope_migrated'
  | 'credential_scope_orphaned'
  // Defect 2026-08-14 — the mirror of the row above: the reconciler REFUSED to
  // migrate, because the boot slug was the bare `'dev'` FALLBACK and the
  // database already carried rows under an explicit handle. Nothing moved; the
  // durable record is that an anonymous process was pointed at a real
  // instance's database.
  //
  // SCOPE (decision 2026-08-16, INVARIANTS #116(b)): `project_slug` is a handle
  // an owner can actually READ this database's feed under — the ledger's
  // handle, or `onboarding_state`'s when the ledger is absent. NOT the anonymous
  // fallback that attempted the move, and NOT (for the credential half) the
  // frozen handle the rows are stuck under, since that handle's divergence from
  // the live one IS the condition being reported. `listRecentForScope` below is
  // strictly `WHERE project_slug = ?`, so any other choice is unreadable
  // forever. One row per readable scope, each NARROWED to that scope — its own
  // handle and its own counts; every other handle is reduced to a count, never a
  // name, because a foreign key in an instance-scoped feed is exactly the
  // cross-scope disclosure that predicate exists to prevent. The attempting
  // handle rides in `attempted_by_slug`. EDGE-TRIGGERED against the VISIBLE
  // window: an unchanged repeat the owner can still see is not re-journalled
  // (`latestVisibleForScopeAndName` + `shouldJournal`), so a repeating anonymous
  // boot cannot starve the 50-row window — while a repeat that has rotated OUT
  // of it is written again, because the owner can no longer see it. The same
  // rule applies to `credential_scope_orphaned` on BOTH its branches.
  | 'instance_scope_rekey_refused'

export const ALL_SYSTEM_EVENT_NAMES: ReadonlyArray<SystemEventName> = [
  'gbrain_unavailable',
  'core_install_failed',
  'credential_all_cooldown',
  'repl_session_capped',
  'cron_job_error',
  'import_orphaned',
  'bundle_build_failed',
  'prewarm_failed',
  'capability_verdict',
  'watchdog_alert',
  'dead_turn_notice',
  'session_size_alert',
  'rate_limit_banner',
  'instance_scope_rekeyed',
  'credential_scope_migrated',
  'credential_scope_orphaned',
  'instance_scope_rekey_refused',
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
  // In-flight INSERT promises. Degrade sites fire `record()` and DISCARD the
  // promise (fire-and-forget), and `ProjectDb.withLock` schedules the write on
  // a microtask — so a degrade emitted just before shutdown could otherwise hit
  // a closed DB. Shutdown awaits {@link drain} to flush these first.
  private readonly inflight = new Set<Promise<unknown>>()

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
    // Register the write SYNCHRONOUSLY (before the first await) so a caller that
    // fires-and-forgets and then triggers shutdown on the next tick is covered
    // by drain(). Cleared on settle regardless of success/failure.
    const write = this.db.run(
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
    this.inflight.add(write)
    // Remove from the in-flight set on settle. This is `neutralizeAbandonedSettle`
    // — NOT `fireAndForget` — because the write's OWN failure is already handled
    // elsewhere (see below), so there is no failure to log/count here (a
    // fireAndForget would be the "lie" it must never tell). The write's rejection
    // is delivered to
    // the `await write` below (→ emitSystemEventSafe, whose contract swallows
    // journal-write failures so the degradation journal never breaks the
    // caller). `neutralizeAbandonedSettle` documents "settle irrelevant, handled
    // elsewhere" and guards against any unforeseen rejection.
    const cleanup = (): void => {
      this.inflight.delete(write)
    }
    // `.finally(cleanup)` runs cleanup on settle and passes the rejection
    // through; `neutralizeAbandonedSettle` silently absorbs THAT re-rejection
    // (the real write failure is surfaced by `await write` below). Using
    // `.finally` (not `.then(cleanup, cleanup)`) keeps the arg free of a
    // rejection-swallowing handler, satisfying the pre-swallow gate.
    neutralizeAbandonedSettle(write.finally(cleanup))
    await write
    return { id }
  }

  /**
   * Await every in-flight {@link record} write (best-effort — a failed write
   * settles too). Boot's shutdown / init-failure cleanup calls this BEFORE
   * `db.close()` so a degrade event fired just before teardown is durably
   * written rather than silently dropped against a closed DB.
   */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight])
    }
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

  /**
   * Read-only: the most-recent `limit` events STRICTLY scoped to `project_slug`,
   * newest first. The scope predicate is applied BEFORE the `LIMIT` so foreign-slug
   * rows can neither be DISCLOSED into an instance-scoped report nor STARVE in-scope
   * rows out of the window (O5 diagnostics, Codex). `limit <= 0` → `[]`.
   *
   * NULL-scoped rows are EXCLUDED. `NULL` is ambiguous: it means both "genuinely
   * process-wide" AND "an emitter that omitted its scope" — and several O4 degrade
   * emitters currently persist NULL while carrying instance-specific identifiers
   * (import `job_id`, REPL `session_key`, GBrain backend errors). Including NULL here
   * would DISCLOSE those identifiers into every project's report on an instance that
   * serves more than one project (Codex). Since this is an instance-scoped disclosure
   * endpoint, the safe default is strict scope; genuinely process-wide faults
   * (GBrain/credentials/cron) remain visible through their own dedicated diagnostics
   * sections. Re-including process-wide rows safely needs the emitter-scoping audit
   * (O4 territory).
   */
  listRecentForScope(project_slug: string, limit: number): PersistedSystemEvent[] {
    if (!Number.isFinite(limit) || limit <= 0) return []
    const n = Math.floor(limit)
    const rows = this.db.all<SystemEventRow, [string, number]>(
      `SELECT id, ts, level, module, event_name, payload_json, project_slug, duration_ms
         FROM system_events
        WHERE project_slug = ?
        ORDER BY ts DESC, id DESC
        LIMIT ?`,
      [project_slug, n],
    )
    return rows.map((r) => rowToPersisted(r))
  }

  /**
   * Read-only: the newest row for one `(project_slug, event_name)` pair that is
   * still INSIDE the reader's window — i.e. among the newest `windowSize` rows
   * {@link listRecentForScope} would return for that scope — or `null`.
   *
   * This is the RISING-EDGE read for a repeating boot-time condition. A degrade
   * that re-fires unchanged on every boot (the scope-direction refusal: an
   * anonymous process pointed at a live database boots as often as someone runs
   * it) would otherwise write one row per boot into a feed that is 50 rows deep
   * with no retention sweep, evicting every other degrade event — a warning that
   * starves the report it is trying to appear in. Emitters compare the latest
   * payload against the one they are about to write and skip an exact repeat
   * (`gateway/scope-refusal-journal.ts` `shouldJournal`).
   *
   * THE WINDOW IS THE POINT, and it is why this is not a plain `LIMIT 1` over
   * the table (which is what it was until Argus r2, 2026-08-16). Suppression is
   * only ever justified by "the owner is already looking at this row".
   * `system_events` has NO retention sweep, so a `LIMIT 1` over unbounded
   * history keeps matching a row that rotated out of the feed years ago and
   * suppresses the warning PERMANENTLY — a silent, unrecoverable version of the
   * invisibility the caller exists to fix. Bounded to the same window the
   * reader uses, a row the owner can no longer see is new information again.
   *
   * `windowSize <= 0` → `null` (an empty window shows nothing, so nothing is
   * already visible). Ordering matches {@link listRecentForScope} exactly —
   * `ts DESC, id DESC`; within one millisecond `id` is a random UUID, so the
   * tiebreak is arbitrary but CONSISTENT with what the reader displays, which
   * is the only property the edge trigger needs.
   */
  latestVisibleForScopeAndName(
    project_slug: string,
    eventName: SystemEventName,
    windowSize: number,
  ): PersistedSystemEvent | null {
    if (!Number.isFinite(windowSize) || windowSize <= 0) return null
    const row = this.db.get<SystemEventRow, [string, number, string]>(
      `SELECT id, ts, level, module, event_name, payload_json, project_slug, duration_ms
         FROM (SELECT id, ts, level, module, event_name, payload_json, project_slug, duration_ms
                 FROM system_events
                WHERE project_slug = ?
                ORDER BY ts DESC, id DESC
                LIMIT ?)
        WHERE event_name = ?
        ORDER BY ts DESC, id DESC
        LIMIT 1`,
      [project_slug, Math.floor(windowSize), eventName],
    )
    return row === undefined || row === null ? null : rowToPersisted(row)
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
// the sink through this PROCESS-WIDE registry rather than a threaded handle —
// that ambient reach is the whole reason the registry exists. It is a STACK of
// live sinks: `resolveSystemEventSink()` returns the TOP (most-recently
// registered still-live) sink, or null when empty.
//
// SCOPE / INVARIANT: neutron-open is a SINGLE-OWNER gateway — exactly ONE boot
// per OS process in production. So the stack normally holds exactly one sink and
// every degrade routes to that owner's DB. The registry is deliberately
// process-global; it does NOT (and cannot, without abandoning the ambient
// design) route per-boot, because degrade sites carry no boot handle. Two
// CONCURRENTLY-LIVE boots in one process is a TEST-ONLY configuration; while
// both are live, emits route to the newest (top-of-stack) boot. This is not a
// production configuration — the single-owner install runs one boot per process.
//
// The stack — rather than a single slot — exists to make TEARDOWN order-
// independent. Each boot pushes its sink via `pushSystemEventSink` and calls the
// returned deregister on shutdown, which removes THAT sink by identity from
// wherever it sits. So neither a still-live older boot is orphaned (newest-first
// shutdown) nor a closed-DB sink resurrected (oldest-first shutdown): the top of
// the stack is always a live owner.

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
