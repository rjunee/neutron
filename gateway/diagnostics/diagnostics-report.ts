/**
 * @neutronai/gateway/diagnostics — read-only diagnostics composition (unit O5).
 *
 * WHY THIS EXISTS
 * ---------------
 * "Why is memory / chat / import broken?" was, until this unit, answerable
 * only by SSHing to the host and hand-reading `journalctl`, `repl-registry.json`,
 * and raw sqlite. O5 composes the state that already exists — no new writes,
 * no behaviour change — into ONE read-only report so the owner can answer that
 * question from the admin tab (`GET /api/app/admin/diagnostics`) or the CLI
 * (`neutron doctor`).
 *
 * PURE + FAIL-SOFT
 * ----------------
 * `composeDiagnostics` takes already-read structural inputs (getters), never a
 * live handle, so it is exhaustively unit-testable with no DB / no process. It
 * is the single source of truth for the report SHAPE; two callers feed it:
 *
 *   - the admin endpoint, from full in-process state (credential pool + cores
 *     module state are in-memory-only and ONLY available here), and
 *   - the `neutron doctor` CLI, from on-disk state (read-only sqlite SELECTs +
 *     the repl-registry file) — the in-process-only sections render
 *     `{ available: false }` there.
 *
 * Every section is independently guarded: a thrown/absent source degrades that
 * ONE section to `{ available: false, note }` and never fails the whole report.
 * This mirrors the §8 fail-soft invariants — diagnostics adds visibility only,
 * it must never itself become a new failure mode.
 */

// ─── Section shapes ─────────────────────────────────────────────────────────

export interface GbrainDiag {
  available: boolean
  /** 'ok' | 'unavailable' (latched) — from gbrain_sync_state. */
  status?: string
  /** Why the memory substrate latched off, when it did. */
  latch_reason?: string | null
  latched_at?: string | null
  last_success_at?: string | null
  /** Scribe writes deferred while latched. */
  deferred_count?: number
  updated_at?: string
  note?: string
}

export interface CredentialsDiag {
  available: boolean
  /** `hasUsableCredential(pool)` — is any credential not cooling down? */
  has_usable?: boolean
  /** `soonestCooldownUntil(pool)` — epoch-ms the next credential frees up, or
   *  null when one is already usable / the pool is empty. */
  soonest_cooldown_until?: number | null
  note?: string
}

export interface ReplSessionDiag {
  key: string
  session_id?: string | undefined
  channel_name?: string | undefined
  has_session?: boolean | undefined
  pid?: number | undefined
  model?: string | undefined
  /** ms since the REPL first reached ready, or null when never ready. */
  age_ms?: number | null
  first_ready_at?: number | undefined
  last_respawn_at?: number | undefined
  /** Respawns inside the rolling window — restart-rate pressure. */
  respawn_count?: number
  /** Epoch ms the hard restart-rate cap tripped (auto-recovery OFF), or null. */
  capped_at?: number | null
  // NOTE — `lastDataAt` (per-session PTY activity) is intentionally NOT surfaced.
  // It is an in-memory PtySession field, NOT persisted to repl-registry.json (the
  // only source reachable read-only here + off-process). Rendering a fabricated /
  // zero value would read as real; surfacing the real one needs a persistence
  // change (behaviour change, out of O5's read-only scope). Deferred.
}

export interface ReplDiag {
  available: boolean
  registry_path?: string
  sessions?: ReplSessionDiag[]
  note?: string
}

export interface CronJobDiag {
  job_name: string
  project_slug?: string | undefined
  /** Epoch MILLISECONDS (normalized from cron_state's Unix-seconds column). */
  last_run_at?: number | null
  last_run_status?: string | null
  last_run_error?: string | null
  last_run_duration_ms?: number | null
}

export interface CronDiag {
  available: boolean
  jobs?: CronJobDiag[]
  note?: string
}

export interface ImportJobDiag {
  job_id: string
  source?: string | undefined
  status?: string | undefined
  started_at?: number | null
  completed_at?: number | null
  error_code?: string | null
  error_message?: string | null
}

export interface ImportDiag {
  available: boolean
  jobs?: ImportJobDiag[]
  note?: string
}

/** One `gateway_events` row (onboarding/gateway telemetry). NOT the operational
 *  `system_events` journal — that table is created by unit O4 (unmerged); this
 *  section reads `gateway_events` and is labelled as such by every consumer. */
export interface SystemEventDiag {
  ts?: number | undefined
  level?: string | undefined
  module?: string | undefined
  event?: string | undefined
  duration_ms?: number | null
}

/** Recent `gateway_events` (source = onboarding/gateway telemetry). Pending O4,
 *  this is NOT operational `system_events`; consumers label it `gateway_events`. */
export interface EventsDiag {
  available: boolean
  events?: SystemEventDiag[]
  note?: string
}

export interface DiagnosticsReport {
  generated_at: number
  project_slug: string
  gbrain: GbrainDiag
  credentials: CredentialsDiag
  repl_sessions: ReplDiag
  cron_jobs: CronDiag
  import_jobs: ImportDiag
  recent_events: EventsDiag
}

// ─── Structural source inputs (what each getter must return) ─────────────────

/** gbrain_sync_state row (subset) — `readGbrainSyncState(...)` shape. */
export interface GbrainSyncRowish {
  status: string
  latchReason: string | null
  latchedAt: string | null
  lastSuccessAt: string | null
  deferredCount: number
  updatedAt: string
}

/** Credential-pool probe results — `hasUsableCredential` / `soonestCooldownUntil`. */
export interface CredentialProbeish {
  hasUsable: boolean
  soonestCooldownUntil: number | null
}

/** REPL supervision row (subset) — `ReplRegistryRecord` shape. */
export interface ReplRecordish {
  sessionKey?: string
  sessionId?: string
  channelName?: string
  has_session?: boolean
  pid?: number
  model?: string
  first_ready_at?: number
  last_respawn_at?: number
  recent_respawns?: number[]
  capped_at?: number
}

/** cron_state row (subset) — `CronStateRow` shape. */
export interface CronRowish {
  job_name: string
  project_slug?: string
  /** Unix SECONDS as stored in cron_state (normalized to ms by the composer). */
  last_run_at?: number | null
  last_run_status?: string | null
  last_run_error?: string | null
  last_run_duration_ms?: number | null
}

/** import_jobs row (subset). */
export interface ImportRowish {
  job_id: string
  source?: string
  status?: string
  started_at?: number | null
  completed_at?: number | null
  error_code?: string | null
  error_message?: string | null
}

/** gateway_events row (subset) — `PersistedOnboardingEvent` shape. */
export interface EventRowish {
  ts?: number
  level?: string
  module?: string
  event?: string
  duration_ms?: number | null
}

/**
 * The composition inputs. Every field is an OPTIONAL getter: when omitted the
 * corresponding section renders `{ available: false }`. Getters may throw — the
 * composer catches per-section so one broken source never fails the report.
 */
export interface DiagnosticsSources {
  project_slug: string
  now?: () => number
  /** gbrain latch/sync state (P9). Returns null when no row has been written. */
  gbrain?: () => GbrainSyncRowish | null
  /** Credential-pool liveness probes (in-process only). */
  credentials?: () => CredentialProbeish
  // NOTE — core install failures (CoresModuleState.failures) are intentionally
  // NOT a section here: that state lives ONLY in the downstream cores graph
  // module (installBundledCores), with no read handle at the composer/request
  // scope. Surfacing it read-only would require a builder-written shared ref
  // threaded through the composition graph — a cross-module change beyond O5's
  // additive/read-only mandate. Deferred to a follow-up.
  /** REPL registry file: the resolved path + the parsed records map. */
  replRegistry?: () => { path: string; records: Record<string, ReplRecordish> }
  /** cron_state rows, one per (job, project). */
  cronJobs?: () => ReadonlyArray<CronRowish>
  /** import_jobs rows for this instance. */
  importJobs?: () => ReadonlyArray<ImportRowish>
  /** Most-recent system/gateway events, newest first, already sliced. */
  recentEvents?: () => ReadonlyArray<EventRowish>
}

const NOT_WIRED = 'not wired on this gateway'

/** Run a section builder; degrade to `{ available:false, note }` on throw/absent. */
function section<T extends { available: boolean; note?: string }>(
  getter: (() => unknown) | undefined,
  build: (raw: never) => T,
  empty: () => T,
): T {
  if (getter === undefined) {
    const e = empty()
    e.note = NOT_WIRED
    return e
  }
  try {
    const raw = getter()
    return build(raw as never)
  } catch (err) {
    const e = empty()
    e.note = `source error: ${err instanceof Error ? err.message : String(err)}`
    return e
  }
}

/**
 * Compose the read-only diagnostics report from already-read structural inputs.
 * Pure: no I/O, no live handles, deterministic given `now`.
 */
export function composeDiagnostics(sources: DiagnosticsSources): DiagnosticsReport {
  const now = sources.now ?? ((): number => Date.now())
  const nowMs = now()

  const gbrain = section<GbrainDiag>(
    sources.gbrain,
    (raw: GbrainSyncRowish | null): GbrainDiag => {
      if (raw === null) {
        return { available: true, note: 'no sync state recorded yet (memory not exercised this boot)' }
      }
      return {
        available: true,
        status: raw.status,
        latch_reason: raw.latchReason,
        latched_at: raw.latchedAt,
        last_success_at: raw.lastSuccessAt,
        deferred_count: raw.deferredCount,
        updated_at: raw.updatedAt,
      }
    },
    () => ({ available: false }),
  )

  const credentials = section<CredentialsDiag>(
    sources.credentials,
    (raw: CredentialProbeish): CredentialsDiag => ({
      available: true,
      has_usable: raw.hasUsable,
      soonest_cooldown_until: raw.soonestCooldownUntil,
    }),
    () => ({ available: false }),
  )

  const repl_sessions = section<ReplDiag>(
    sources.replRegistry,
    (raw: { path: string; records: Record<string, ReplRecordish> }): ReplDiag => {
      const sessions: ReplSessionDiag[] = Object.entries(raw.records).map(([key, r]) => ({
        key,
        session_id: r.sessionId,
        channel_name: r.channelName,
        has_session: r.has_session,
        pid: r.pid,
        model: r.model,
        age_ms: typeof r.first_ready_at === 'number' ? Math.max(0, nowMs - r.first_ready_at) : null,
        first_ready_at: r.first_ready_at,
        last_respawn_at: r.last_respawn_at,
        respawn_count: Array.isArray(r.recent_respawns) ? r.recent_respawns.length : 0,
        capped_at: typeof r.capped_at === 'number' ? r.capped_at : null,
      }))
      return { available: true, registry_path: raw.path, sessions }
    },
    () => ({ available: false }),
  )

  const cron_jobs = section<CronDiag>(
    sources.cronJobs,
    (raw: ReadonlyArray<CronRowish>): CronDiag => ({
      available: true,
      jobs: raw.map((j) => ({
        job_name: j.job_name,
        project_slug: j.project_slug,
        // `cron_state.last_run_at` is Unix SECONDS (the scheduler stores
        // fired_at/1000 and reads *1000); normalize to epoch-MS here so the
        // whole report is one unit and consumers can `new Date(ms)` directly.
        last_run_at: typeof j.last_run_at === 'number' ? j.last_run_at * 1000 : null,
        last_run_status: j.last_run_status ?? null,
        last_run_error: j.last_run_error ?? null,
        last_run_duration_ms: j.last_run_duration_ms ?? null,
      })),
    }),
    () => ({ available: false }),
  )

  const import_jobs = section<ImportDiag>(
    sources.importJobs,
    (raw: ReadonlyArray<ImportRowish>): ImportDiag => ({
      available: true,
      jobs: raw.map((j) => ({
        job_id: j.job_id,
        source: j.source,
        status: j.status,
        started_at: j.started_at ?? null,
        completed_at: j.completed_at ?? null,
        error_code: j.error_code ?? null,
        error_message: j.error_message ?? null,
      })),
    }),
    () => ({ available: false }),
  )

  const recent_events = section<EventsDiag>(
    sources.recentEvents,
    (raw: ReadonlyArray<EventRowish>): EventsDiag => ({
      available: true,
      events: raw.map((e) => ({
        ts: e.ts,
        level: e.level,
        module: e.module,
        event: e.event,
        duration_ms: e.duration_ms ?? null,
      })),
    }),
    () => ({ available: false }),
  )

  return {
    generated_at: nowMs,
    project_slug: sources.project_slug,
    gbrain,
    credentials,
    repl_sessions,
    cron_jobs,
    import_jobs,
    recent_events,
  }
}
